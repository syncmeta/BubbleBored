// Synthesizer — replaces curator's 4-class judgment.
//
// Digger has already inline-filtered redundant_known, so the synthesizer
// only composes a final message anchored to the vector(s). Single tool:
// finish(message, used_findings, dropped_findings?).

import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { configManager } from '../../config/loader';
import { chatCompletion } from '../../llm/client';
import { logAudit } from '../../llm/audit';
import type { DiggerResult } from './digger';
import type { PickerKnownProfile } from './vector-picker';

export interface SynthesizerInput {
  userId: string;
  conversationId: string;
  model: string;
  diggerResults: DiggerResult[];
  knownProfile: PickerKnownProfile;
  emitLog: (content: string) => void;
  signal?: AbortSignal;
}

export interface SynthesizerResult {
  finalMessage: string;
  usedIndices: number[];
  droppedIndices: Array<{ index: number; reason: string }>;
  turns: number;
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    throw err;
  }
}

function safeJsonParse(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

const TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'finish',
      description: '提交最终消息。',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: '发给用户的中文消息，开头必须锚定向量；不要元话语',
          },
          used_findings: {
            type: 'array',
            items: { type: 'integer' },
            description: '真正写进 message 的 finding 全局索引（0-based）',
          },
          dropped_findings: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'integer' },
                reason: { type: 'string' },
              },
              required: ['index', 'reason'],
            },
            description: '看了但没用的 finding + 一句话理由（可选）',
          },
        },
        required: ['message', 'used_findings'],
      },
    },
  },
];

function buildUserInput(input: SynthesizerInput): string {
  const lines: string[] = [];
  const kp = input.knownProfile;
  lines.push('## known_profile（用户已知，仅作背景参考——digger 已经内联过滤过 redundant_known）');
  lines.push(`- topics_covered: ${kp.topics_covered.join('、') || '(空)'}`);
  lines.push(`- concepts_known: ${kp.concepts_known.join('、') || '(空)'}`);
  lines.push(`- open_questions: ${kp.open_questions.join('、') || '(空)'}`);
  lines.push('');

  let globalIdx = 0;
  for (const dr of input.diggerResults) {
    const v = dr.vector;
    const fresh = v.freshness_window ? `, freshness=${v.freshness_window}` : '';
    lines.push(`## 向量 [${v.mode}${fresh}] ${v.topic}`);
    lines.push(`- why_now: ${v.why_now || '(空)'}`);
    if (dr.findings.length === 0) {
      lines.push('- findings: (空——digger 没挖到东西)');
    } else {
      lines.push('- findings:');
      for (const f of dr.findings) {
        const url = f.url ? ` [${f.url}]` : '';
        lines.push(`  ${globalIdx}. (${f.novelty}) ${f.title}${url}`);
        lines.push(`     summary: ${f.summary}`);
        lines.push(`     serves_vector_how: ${f.serves_vector_how}`);
        globalIdx++;
      }
    }
    lines.push('');
  }

  if (globalIdx === 0) {
    lines.push('（所有向量都没有 finding——老实告诉用户这次没挖到东西。）');
  }

  lines.push('用 finish 工具收尾。message 写中文、口语、锚定向量。');
  return lines.join('\n');
}

export async function runSynthesizer(input: SynthesizerInput): Promise<SynthesizerResult> {
  const { userId, conversationId, model, emitLog, signal } = input;

  const systemPrompt = await configManager.readPrompt('surfing-synthesizer.md');
  const userInput = buildUserInput(input);

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userInput },
  ];

  let turns = 0;
  const maxTurns = 4;

  while (turns < maxTurns) {
    checkAborted(signal);
    turns++;
    emitLog(`[synth] 第 ${turns} 轮`);

    const { result, latencyMs, costUsd } = await chatCompletion({
      model, messages,
      tools: TOOLS,
      tool_choice: { type: 'function', function: { name: 'finish' } },
    });

    logAudit({
      userId, conversationId, taskType: 'surfing', model,
      inputTokens: result.usage?.prompt_tokens ?? 0,
      outputTokens: result.usage?.completion_tokens ?? 0,
      totalTokens: result.usage?.total_tokens ?? 0,
      costUsd, generationId: result.id, latencyMs,
    });

    const msg = result.choices[0]?.message;
    if (!msg) {
      emitLog('[synth] ⚠️ 空 message');
      break;
    }

    messages.push(msg as ChatCompletionMessageParam);
    const toolCalls = msg.tool_calls ?? [];

    for (const tc of toolCalls) {
      if (tc.type !== 'function' || tc.function.name !== 'finish') {
        messages.push({
          role: 'tool', tool_call_id: tc.id,
          content: '只支持 finish。',
        });
        continue;
      }
      const args = safeJsonParse(tc.function.arguments) ?? {};
      const finalMessage = typeof args.message === 'string' ? args.message.trim() : '';
      const usedIndices = Array.isArray(args.used_findings)
        ? args.used_findings.filter((n: any) => Number.isInteger(n))
        : [];
      const droppedIndices = Array.isArray(args.dropped_findings)
        ? args.dropped_findings
            .filter((d: any) => d && Number.isInteger(d.index) && typeof d.reason === 'string')
            .map((d: any) => ({ index: d.index, reason: d.reason.trim() }))
        : [];
      return { finalMessage, usedIndices, droppedIndices, turns };
    }
  }

  emitLog('[synth] ⚠️ 未产出 finish');
  return { finalMessage: '', usedIndices: [], droppedIndices: [], turns };
}
