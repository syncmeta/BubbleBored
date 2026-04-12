import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { configManager } from '../../config/loader';
import { chatCompletion } from '../../llm/client';
import { logAudit } from '../../llm/audit';
import { getMessages, insertMessage } from '../../db/queries';
import { mcpManager } from '../../mcp/manager';
import type { OutboundMessage } from '../../bus/types';

interface SurfFinding {
  content: string;
  source?: string;
}

interface SurfPlan {
  assessment: string;
  gaps: string;
  should_search: boolean;
  reason: string;
  queries: string[];
}

// Surf monitoring infrastructure
export const surfEvents = new EventEmitter();
export const activeSurfs = new Map<string, AbortController>();

export function stopSurf(botId: string): boolean {
  const controller = activeSurfs.get(botId);
  if (controller) {
    controller.abort();
    activeSurfs.delete(botId);
    return true;
  }
  return false;
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('SURF_ABORTED');
}

export async function runSurf(
  conversationId: string,
  botId: string,
  userId: string,
  replyFn: (msg: OutboundMessage) => void,
  signal?: AbortSignal,
): Promise<void> {
  const botConfig = configManager.getBotConfig(botId);
  const model = configManager.get().openrouter.surfingModel ?? botConfig.model;
  const maxRequests = botConfig.surfing.maxRequests;

  console.log(`[surf] starting for conv ${conversationId}, budget: ${maxRequests}`);

  // Wrap replyFn to also emit to surf monitor
  const originalReplyFn = replyFn;
  replyFn = (msg: OutboundMessage) => {
    originalReplyFn(msg);
    surfEvents.emit('log', { botId, conversationId, ...msg, timestamp: Date.now() });
  };

  if (signal?.aborted) {
    surfEvents.emit('log', { botId, conversationId, type: 'surf_status', content: '冲浪已取消', timestamp: Date.now() });
    return;
  }

  try {

  replyFn({
    type: 'surf_status',
    conversationId,
    content: '正在评估对方的需求…',
  });

  // Get user context from recent messages
  const history = getMessages(conversationId, 20);
  const userContext = history
    .filter(m => m.sender_type === 'user')
    .map(m => m.content)
    .join('\n');

  // Step 1: Needs assessment report
  const surfPrompt = await configManager.readPrompt('surfing.md');
  const { result: planResult, latencyMs: planLatency } = await chatCompletion({
    model,
    messages: [
      { role: 'system', content: surfPrompt },
      { role: 'user', content: `用户近期谈论内容：\n${userContext || '(暂无足够信息)'}` },
    ],
  });

  logAudit({
    conversationId, taskType: 'surfing', model,
    inputTokens: planResult.usage?.prompt_tokens ?? 0,
    outputTokens: planResult.usage?.completion_tokens ?? 0,
    totalTokens: planResult.usage?.total_tokens ?? 0,
    generationId: planResult.id,
    latencyMs: planLatency,
  });

  let remaining = maxRequests - 1;

  // Parse the assessment report
  const planText = planResult.choices[0]?.message?.content ?? '';
  const planJson = planText.match(/\{[\s\S]*\}/);
  if (!planJson) {
    console.log('[surf] failed to parse plan');
    replyFn({
      type: 'surf_status',
      conversationId,
      content: '冲浪结束：无法生成评估报告',
    });
    return;
  }

  let plan: SurfPlan;
  try {
    plan = JSON.parse(planJson[0]);
  } catch {
    console.log('[surf] invalid plan JSON');
    replyFn({
      type: 'surf_status',
      conversationId,
      content: '冲浪结束：评估报告格式异常',
    });
    return;
  }

  // Show the assessment report
  replyFn({
    type: 'surf_status',
    conversationId,
    content: `评估报告：\n• 需求：${plan.assessment}\n• 信息缺口：${plan.gaps}\n• 结论：${plan.reason}`,
  });

  // Step 2: Decide whether to search
  if (!plan.should_search || !plan.queries || plan.queries.length === 0) {
    console.log('[surf] assessment says no search needed');
    replyFn({
      type: 'surf_status',
      conversationId,
      content: '评估认为暂时不需要搜索，冲浪结束',
    });
    return;
  }

  const queries = plan.queries.filter(q => q.trim().length > 0);

  replyFn({
    type: 'surf_status',
    conversationId,
    content: `决定搜索 ${queries.length} 个方向：\n${queries.map((q, i) => `${i + 1}. ${q}`).join('\n')}`,
  });

  // Step 3: Search via Jina MCP + LLM evaluation loop
  const findings: SurfFinding[] = [];
  const evalPrompt = await configManager.readPrompt('surfing-eval.md');

  for (let qi = 0; qi < queries.length; qi++) {
    const query = queries[qi];
    if (remaining <= 1) break; // Reserve 1 for final report

    checkAborted(signal);

    // 3a: Search via Jina MCP
    replyFn({
      type: 'surf_status',
      conversationId,
      content: `正在搜索 (${qi + 1}/${queries.length})：${query}`,
    });

    let searchResults: string;
    try {
      searchResults = await mcpManager.searchWeb(query);
    } catch (e) {
      console.error(`[surf] search failed for "${query}":`, e);
      replyFn({
        type: 'surf_status',
        conversationId,
        content: `搜索「${query}」失败，跳过`,
      });
      continue;
    }

    // 3b: LLM evaluates real search results
    const { result: evalResult, latencyMs: evalLatency } = await chatCompletion({
      model,
      messages: [
        { role: 'system', content: evalPrompt },
        {
          role: 'user',
          content: `搜索查询: ${query}\n剩余请求次数: ${remaining}\n\n搜索结果：\n${searchResults}`,
        },
      ],
    });

    remaining--;

    logAudit({
      conversationId, taskType: 'surfing_eval', model,
      inputTokens: evalResult.usage?.prompt_tokens ?? 0,
      outputTokens: evalResult.usage?.completion_tokens ?? 0,
      totalTokens: evalResult.usage?.total_tokens ?? 0,
      generationId: evalResult.id,
      latencyMs: evalLatency,
    });

    try {
      const evalText = evalResult.choices[0]?.message?.content ?? '';
      const jsonMatch = evalText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) continue;

      const evalData = JSON.parse(jsonMatch[0]);

      // Collect findings
      if (evalData.findings && Array.isArray(evalData.findings)) {
        let newCount = 0;
        for (const f of evalData.findings) {
          if (typeof f === 'string' && f.trim()) {
            findings.push({ content: f });
            newCount++;
          }
        }
        if (newCount > 0) {
          replyFn({
            type: 'surf_status',
            conversationId,
            content: `搜索「${query}」发现 ${newCount} 条内容（共 ${findings.length} 条）`,
          });
        }
      }

      // If eval wants to read a specific URL
      checkAborted(signal);
      if (evalData.action === 'read' && evalData.url && remaining > 1) {
        replyFn({
          type: 'surf_status',
          conversationId,
          content: `正在阅读：${evalData.url}`,
        });

        try {
          const pageContent = await mcpManager.readUrl(evalData.url);

          const { result: readEval, latencyMs: readLatency } = await chatCompletion({
            model,
            messages: [
              { role: 'system', content: evalPrompt },
              {
                role: 'user',
                content: `阅读页面: ${evalData.url}\n剩余请求次数: ${remaining}\n\n页面内容：\n${pageContent}`,
              },
            ],
          });

          remaining--;

          logAudit({
            conversationId, taskType: 'surfing_eval', model,
            inputTokens: readEval.usage?.prompt_tokens ?? 0,
            outputTokens: readEval.usage?.completion_tokens ?? 0,
            totalTokens: readEval.usage?.total_tokens ?? 0,
            generationId: readEval.id,
            latencyMs: readLatency,
          });

          const readText = readEval.choices[0]?.message?.content ?? '';
          const readJson = readText.match(/\{[\s\S]*\}/);
          if (readJson) {
            const readData = JSON.parse(readJson[0]);
            if (readData.findings && Array.isArray(readData.findings)) {
              let readCount = 0;
              for (const f of readData.findings) {
                if (typeof f === 'string' && f.trim()) {
                  findings.push({ content: f, source: evalData.url });
                  readCount++;
                }
              }
              if (readCount > 0) {
                replyFn({
                  type: 'surf_status',
                  conversationId,
                  content: `阅读页面后又发现 ${readCount} 条内容`,
                });
              }
            }
          }
        } catch (e) {
          console.error(`[surf] read_url failed for "${evalData.url}":`, e);
        }
      }

      if (evalData.action === 'done') {
        replyFn({
          type: 'surf_status',
          conversationId,
          content: '搜索已收集到足够信息，停止搜索',
        });
        break;
      }
    } catch (e: any) {
      if (e?.message === 'SURF_ABORTED') throw e;
      // Eval response wasn't valid JSON, skip
    }
  }

  checkAborted(signal);

  // Step 4: Report findings
  if (findings.length === 0) {
    console.log('[surf] no findings to report');
    replyFn({
      type: 'surf_status',
      conversationId,
      content: '冲浪结束：这次没有发现值得分享的内容',
    });
    return;
  }

  replyFn({
    type: 'surf_status',
    conversationId,
    content: `共发现 ${findings.length} 条内容，正在整理…`,
  });

  await reportFindings(conversationId, botId, findings, model, replyFn);

  } catch (e: any) {
    if (e?.message === 'SURF_ABORTED') {
      replyFn({
        type: 'surf_status',
        conversationId,
        content: '冲浪已被手动停止',
      });
      return;
    }
    throw e;
  } finally {
    activeSurfs.delete(botId);
    surfEvents.emit('done', { botId, conversationId, timestamp: Date.now() });
  }
}

async function reportFindings(
  conversationId: string,
  botId: string,
  findings: SurfFinding[],
  model: string,
  replyFn: (msg: OutboundMessage) => void,
): Promise<void> {
  const systemPrompt = await configManager.readPrompt('system.md');
  let botPrompt = '';
  try {
    const botConfig = configManager.getBotConfig(botId);
    botPrompt = await configManager.readPrompt(`bots/${botConfig.promptFile}`);
  } catch {}

  const findingsText = findings.map(f => {
    const src = f.source ? ` (来源: ${f.source})` : '';
    return `- ${f.content}${src}`;
  }).join('\n');

  const { result, latencyMs } = await chatCompletion({
    model,
    messages: [
      { role: 'system', content: `${systemPrompt}\n\n${botPrompt}` },
      {
        role: 'user',
        content: `你刚刚在网上冲浪了一圈，发现了一些可能对对方有价值的东西。
自然地分享你的发现，就像朋友随手转发一个有意思的东西。
如果这些发现确实没什么价值，输出 [SILENT]。
不要用"我发现""我注意到"开头。直接说内容。

发现：
${findingsText}`,
      },
    ],
  });

  logAudit({
    conversationId, taskType: 'surfing', model,
    inputTokens: result.usage?.prompt_tokens ?? 0,
    outputTokens: result.usage?.completion_tokens ?? 0,
    totalTokens: result.usage?.total_tokens ?? 0,
    generationId: result.id,
    latencyMs,
  });

  const content = result.choices[0]?.message?.content?.trim();
  if (!content || content === '[SILENT]') return;

  const msgId = randomUUID();
  insertMessage(msgId, conversationId, 'bot', botId, content);
  replyFn({
    type: 'message',
    conversationId,
    messageId: msgId,
    content,
  });
}
