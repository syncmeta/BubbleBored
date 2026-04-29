import { randomUUID } from 'crypto';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { configManager } from '../../config/loader';
import { chatCompletion } from '../../llm/client';
import { logAudit } from '../../llm/audit';
import {
  createBotJournalEntry, recentBotJournalEntries,
  type BotJournalEntryRow,
} from '../../db/queries';
import { modelForTask } from '../models';

// First-person diary the bot writes after each surf, then reads back into
// chat prompts later so it can naturally reference "my own" experiences.

export interface JournalWriteInput {
  botId: string;
  userId: string;
  surfConvId: string;
  userlens: string;
  notes: { title: string; summary: string; url?: string; why: string }[];
  finishReason: string;
  satisfied: boolean;
}

export async function writeJournalEntry(input: JournalWriteInput): Promise<string> {
  const prompt = await configManager.readPrompt('surfing-journal.md');
  const model = modelForTask('humanAnalysis');

  const noteLines = input.notes.length === 0
    ? '(本次没有任何 note —— 空手而归)'
    : input.notes.map((n, i) =>
        `${i + 1}. **${n.title}**${n.url ? ` (${n.url})` : ''}\n   ${n.summary}\n   钩到我的点：${n.why}`,
      ).join('\n');

  const userMsg = [
    '## 对该用户的观察',
    input.userlens || '(空)',
    '',
    '## 我看过的东西（笔记）',
    noteLines,
    '',
    '## 我自己的收尾感受',
    `${input.satisfied ? '攒到了想分享的东西' : '没什么戏，提前收手'}：${input.finishReason || '(没说)'}`,
  ].join('\n');

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: prompt },
    { role: 'user', content: userMsg },
  ];

  const { result, latencyMs, costUsd } = await chatCompletion({ model, messages });
  const content = result.choices[0]?.message?.content?.trim() ?? '';

  logAudit({
    userId: input.userId,
    conversationId: input.surfConvId,
    taskType: 'surfing',
    model,
    inputTokens: result.usage?.prompt_tokens ?? 0,
    outputTokens: result.usage?.completion_tokens ?? 0,
    totalTokens: result.usage?.total_tokens ?? 0,
    costUsd,
    generationId: result.id,
    latencyMs,
  });

  if (content) {
    createBotJournalEntry({
      id: randomUUID(),
      botId: input.botId,
      userId: input.userId,
      surfConvId: input.surfConvId,
      content,
    });
  }

  return content;
}

// Format a chunk for the chat system prompt. Empty when there are no entries.
export function buildJournalPromptBlock(
  botId: string, userId: string, limit: number,
): { block: string | null; entries: BotJournalEntryRow[] } {
  if (limit <= 0) return { block: null, entries: [] };
  const entries = recentBotJournalEntries(botId, userId, limit);
  if (entries.length === 0) return { block: null, entries: [] };

  const lines = entries.map(e => {
    const when = formatWhen(e.created_at);
    return `### ${when}\n${e.content}`;
  }).join('\n\n');

  return {
    block: `## 你最近自己冲浪时记下的小本子\n\n这是你自己写过的日记，对方看不到。需要时可以**自然地**把里面的所见所感带进对话——"前几天我刷到一个东西…"——别复读，也别故意凑话题。\n\n${lines}`,
    entries,
  };
}

function formatWhen(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)} 天前`;
  if (diff < 30 * 86400) return `${Math.floor(diff / (7 * 86400))} 周前`;
  return new Date(ts * 1000).toISOString().slice(0, 10);
}
