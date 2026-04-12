import { randomUUID } from 'crypto';
import { configManager } from '../../config/loader';
import { chatCompletion } from '../../llm/client';
import { logAudit } from '../../llm/audit';
import { getMessages, insertMessage } from '../../db/queries';
import type { OutboundMessage } from '../../bus/types';

interface SurfFinding {
  content: string;
  source?: string;
}

export async function runSurf(
  conversationId: string,
  botId: string,
  userId: string,
  replyFn: (msg: OutboundMessage) => void,
): Promise<void> {
  const botConfig = configManager.getBotConfig(botId);
  const model = configManager.get().openrouter.surfingModel ?? botConfig.model;
  const maxRequests = botConfig.surfing.maxRequests;

  console.log(`[surf] starting for conv ${conversationId}, budget: ${maxRequests}`);

  // Get user context from recent messages
  const history = getMessages(conversationId, 20);
  const userContext = history
    .filter(m => m.sender_type === 'user')
    .map(m => m.content)
    .join('\n');

  // Step 1: Generate search queries
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
    latencyMs: planLatency,
  });

  const queries = (planResult.choices[0]?.message?.content ?? '')
    .split('\n')
    .map(q => q.trim())
    .filter(q => q.length > 0);

  if (queries.length === 0) {
    console.log('[surf] no queries generated');
    return;
  }

  // Step 2: Search and evaluation loop
  const findings: SurfFinding[] = [];
  let remaining = maxRequests - 1; // Already used one for planning

  const evalPrompt = await configManager.readPrompt('surfing-eval.md');

  for (const query of queries) {
    if (remaining <= 1) break; // Reserve 1 for final report

    // Simulated search (in production, use a real search API/MCP tool)
    // For now, we ask the model to evaluate what it knows
    const { result: evalResult, latencyMs: evalLatency } = await chatCompletion({
      model,
      messages: [
        { role: 'system', content: evalPrompt },
        {
          role: 'user',
          content: `搜索查询: ${query}\n剩余请求次数: ${remaining}\n\n请基于你的知识评估这个查询可能带来的发现。`,
        },
      ],
    });

    remaining--;

    logAudit({
      conversationId, taskType: 'surfing_eval', model,
      inputTokens: evalResult.usage?.prompt_tokens ?? 0,
      outputTokens: evalResult.usage?.completion_tokens ?? 0,
      totalTokens: evalResult.usage?.total_tokens ?? 0,
      latencyMs: evalLatency,
    });

    try {
      const evalText = evalResult.choices[0]?.message?.content ?? '';
      // Try to parse JSON
      const jsonMatch = evalText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const evalData = JSON.parse(jsonMatch[0]);
        if (evalData.findings && Array.isArray(evalData.findings)) {
          for (const f of evalData.findings) {
            if (typeof f === 'string' && f.trim()) {
              findings.push({ content: f });
            }
          }
        }
        if (evalData.action === 'done') break;
      }
    } catch {
      // Eval response wasn't valid JSON, skip
    }
  }

  // Step 3: Report findings
  if (findings.length === 0) {
    console.log('[surf] no findings to report');
    return;
  }

  await reportFindings(conversationId, botId, findings, model, replyFn);
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

  const findingsText = findings.map(f => `- ${f.content}`).join('\n');

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
