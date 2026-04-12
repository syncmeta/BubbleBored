import { EventEmitter } from 'events';
import { configManager } from '../../config/loader';
import { chatCompletion } from '../../llm/client';
import { logAudit } from '../../llm/audit';
import { getMessages } from '../../db/queries';
import { mcpManager } from '../../mcp/manager';
import { getUserProfile } from '../../honcho/memory';
import { handleUserMessage } from '../orchestrator';
import type { OutboundMessage } from '../../bus/types';

interface SurfFinding {
  content: string;
  source?: string;
}

interface SurfPlan {
  needs: string;
  stuck_pattern: string;
  strengths: string;
  blind_spots: string;
  insights: string[];
  need_search: boolean;
  search_reason: string;
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

export type SurfTrigger = 'auto' | 'user';

export async function runSurf(
  conversationId: string,
  botId: string,
  userId: string,
  replyFn: (msg: OutboundMessage) => void,
  signal?: AbortSignal,
  trigger: SurfTrigger = 'auto',
): Promise<void> {
  const botConfig = configManager.getBotConfig(botId);
  const model = configManager.get().openrouter.surfingModel ?? botConfig.model;
  const maxRequests = botConfig.surfing.maxRequests;

  console.log(`[surf] starting for conv ${conversationId}, trigger: ${trigger}, budget: ${maxRequests}`);

  // Wrap replyFn to also emit to surf monitor
  const originalReplyFn = replyFn;
  replyFn = (msg: OutboundMessage) => {
    originalReplyFn(msg);
    surfEvents.emit('log', { ...msg, botId, conversationId, timestamp: Date.now() });
  };

  if (signal?.aborted) {
    surfEvents.emit('log', { botId, conversationId, type: 'surf_status', content: '冲浪已取消', timestamp: Date.now() });
    return;
  }

  try {

  replyFn({
    type: 'surf_status',
    conversationId,
    content: '正在评估…',
  });

  // Get user context from recent messages
  const history = getMessages(conversationId, 20);
  const userContext = history
    .filter(m => m.sender_type === 'user')
    .map(m => m.content)
    .join('\n');

  // Get user profile
  const profile = await getUserProfile(userId);
  const profileText = profile.card.length > 0
    ? `用户画像：\n${profile.card.join('\n')}\n${profile.representation}`
    : '';

  // Step 1: Assessment — the core
  const surfPrompt = await configManager.readPrompt('surfing.md');
  const { result: planResult, latencyMs: planLatency } = await chatCompletion({
    model,
    messages: [
      { role: 'system', content: surfPrompt },
      {
        role: 'user',
        content: [
          profileText,
          `用户近期谈论内容：\n${userContext || '(暂无足够信息)'}`,
        ].filter(Boolean).join('\n\n'),
      },
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

  const planText = planResult.choices[0]?.message?.content ?? '';
  const planJson = planText.match(/\{[\s\S]*\}/);
  if (!planJson) {
    console.log('[surf] failed to parse plan');
    replyFn({ type: 'surf_status', conversationId, content: '评估失败：无法解析' });
    return;
  }

  let plan: SurfPlan;
  try {
    plan = JSON.parse(planJson[0]);
  } catch {
    console.log('[surf] invalid plan JSON');
    replyFn({ type: 'surf_status', conversationId, content: '评估失败：格式异常' });
    return;
  }

  // Show assessment
  replyFn({
    type: 'surf_status',
    conversationId,
    content: [
      '评估报告：',
      `• 需求：${plan.needs}`,
      `• 怪圈：${plan.stuck_pattern}`,
      `• 优势：${plan.strengths}`,
      `• 盲区：${plan.blind_spots}`,
      `• 洞察：${(plan.insights || []).map(i => i).join('；')}`,
    ].join('\n'),
  });

  // Step 2: Optional search — only if assessment says so
  const findings: SurfFinding[] = [];

  if (plan.need_search && plan.queries && plan.queries.length > 0) {
    const queries = plan.queries.filter(q => q.trim().length > 0);

    replyFn({
      type: 'surf_status',
      conversationId,
      content: `需要搜索补充（${plan.search_reason}）：\n${queries.map((q, i) => `${i + 1}. ${q}`).join('\n')}`,
    });

    const evalPrompt = await configManager.readPrompt('surfing-eval.md');

    for (let qi = 0; qi < queries.length; qi++) {
      const query = queries[qi];
      if (remaining <= 1) break;

      checkAborted(signal);

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
        replyFn({ type: 'surf_status', conversationId, content: `搜索「${query}」失败，跳过` });
        continue;
      }

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

        if (evalData.findings && Array.isArray(evalData.findings)) {
          for (const f of evalData.findings) {
            if (typeof f === 'string' && f.trim()) {
              findings.push({ content: f });
            }
          }
        }

        checkAborted(signal);
        if (evalData.action === 'read' && evalData.url && remaining > 1) {
          replyFn({ type: 'surf_status', conversationId, content: `正在阅读：${evalData.url}` });

          try {
            const pageContent = await mcpManager.readUrl(evalData.url);
            const { result: readEval, latencyMs: readLatency } = await chatCompletion({
              model,
              messages: [
                { role: 'system', content: evalPrompt },
                { role: 'user', content: `阅读页面: ${evalData.url}\n剩余请求次数: ${remaining}\n\n页面内容：\n${pageContent}` },
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
                for (const f of readData.findings) {
                  if (typeof f === 'string' && f.trim()) {
                    findings.push({ content: f, source: evalData.url });
                  }
                }
              }
            }
          } catch (e) {
            console.error(`[surf] read_url failed for "${evalData.url}":`, e);
          }
        }

        if (evalData.action === 'done') break;
      } catch (e: any) {
        if (e?.message === 'SURF_ABORTED') throw e;
      }
    }

    if (findings.length > 0) {
      replyFn({
        type: 'surf_status',
        conversationId,
        content: `搜索补充了 ${findings.length} 条内容`,
      });
    }
  }

  checkAborted(signal);

  // Step 3: Send message through normal flow
  // Insights from the model's own knowledge are the core;
  // search findings are supplementary
  const insightsText = (plan.insights || []).map(i => `- ${i}`).join('\n');
  const findingsText = findings.map(f => {
    const src = f.source ? ` (来源: ${f.source})` : '';
    return `- ${f.content}${src}`;
  }).join('\n');

  const triggerDesc = trigger === 'user'
    ? '用户刚才让你去冲浪，你冲完了。'
    : '你自己想去思考和观察，刚想完。';

  const parts = [
    `[内部上下文 - 不要原样输出]`,
    triggerDesc,
    ``,
    `你的洞察：`,
    insightsText,
  ];

  if (findingsText) {
    parts.push(``, `你还在网上找到了一些补充信息：`, findingsText);
  }

  parts.push(
    ``,
    `自然地融入对话。不要用"报告""总结""发现""洞察"这类词。`,
    `像朋友聊天一样说出来。`,
    `如果确实没什么值得说的，输出 [SILENT]。`,
  );

  replyFn({
    type: 'surf_status',
    conversationId,
    content: '正在组织语言…',
  });

  await handleUserMessage({
    conversationId,
    botId,
    userId,
    mergedContent: parts.join('\n'),
    replyFn: originalReplyFn,
    extraContext: [
      triggerDesc,
      `评估报告：`,
      `• 对方需求：${plan.needs}`,
      `• 怪圈：${plan.stuck_pattern}`,
      `• 优势：${plan.strengths}`,
      `• 盲区：${plan.blind_spots}`,
    ].join('\n'),
  });

  } catch (e: any) {
    if (e?.message === 'SURF_ABORTED') {
      replyFn({ type: 'surf_status', conversationId, content: '冲浪已被手动停止' });
      return;
    }
    throw e;
  } finally {
    activeSurfs.delete(botId);
    surfEvents.emit('done', { botId, conversationId, timestamp: Date.now() });
  }
}
