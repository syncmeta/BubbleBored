import { configManager } from '../config/loader';
import { chatCompletion } from '../llm/client';
import { logAudit } from '../llm/audit';
import { addToDebounceBuffer, clearDebounceBuffer } from '../db/queries';
import type { OutboundMessage } from '../bus/types';

interface DebounceState {
  hardTimer: Timer | null;
  pendingMessages: string[];
  processing: boolean;
}

const states = new Map<string, DebounceState>();

function getState(conversationId: string): DebounceState {
  let s = states.get(conversationId);
  if (!s) {
    s = { hardTimer: null, pendingMessages: [], processing: false };
    states.set(conversationId, s);
  }
  return s;
}

export function addMessage(
  conversationId: string,
  botId: string,
  userId: string,
  content: string,
  replyFn: (msg: OutboundMessage) => void,
  onReady: (mergedContent: string) => void,
): void {
  const botConfig = configManager.getBotConfig(botId);
  const { debounce } = botConfig;

  if (!debounce.enabled) {
    onReady(content);
    return;
  }

  const state = getState(conversationId);
  state.pendingMessages.push(content);
  addToDebounceBuffer(conversationId, content);
  console.log(`[debounce] buffered (${state.pendingMessages.length} pending): ${content.slice(0, 50)}`);

  // Hard timeout
  if (!state.hardTimer) {
    state.hardTimer = setTimeout(() => {
      console.log(`[debounce] hard timeout → flush`);
      flush(conversationId, onReady);
    }, debounce.maxWaitMs);
  }

  // If already waiting for a judge response, don't call again
  if (state.processing) return;

  // Immediately call LLM judge
  judge(conversationId, botId, onReady);
}

async function judge(
  conversationId: string,
  botId: string,
  onReady: (mergedContent: string) => void,
): Promise<void> {
  const state = states.get(conversationId);
  if (!state || state.processing) return;

  state.processing = true;
  try {
    const judgePrompt = await configManager.readPrompt('debounce-judge.md');
    const messagesText = state.pendingMessages.map((m, i) => `消息${i + 1}: ${m}`).join('\n');

    console.log(`[debounce] judging (${state.pendingMessages.length} msgs)...`);
    const { result, latencyMs } = await chatCompletion({
      model: configManager.get().openrouter.debounceModel,
      messages: [
        { role: 'system', content: judgePrompt },
        { role: 'user', content: messagesText },
      ],
      max_tokens: 10,
      provider: { sort: { by: 'latency' } },
    } as any);

    logAudit({
      conversationId,
      taskType: 'debounce',
      model: configManager.get().openrouter.debounceModel,
      inputTokens: result.usage?.prompt_tokens ?? 0,
      outputTokens: result.usage?.completion_tokens ?? 0,
      totalTokens: result.usage?.total_tokens ?? 0,
      generationId: result.id,
      latencyMs,
    });

    const rawAnswer = result.choices[0]?.message?.content;
    const answer = rawAnswer?.trim().toUpperCase();
    console.log(`[debounce] judge → ${JSON.stringify(rawAnswer)} → ${answer ?? 'EMPTY'} (${latencyMs}ms, model: ${result.model ?? '?'})`);

    // Check if new messages arrived while we were judging
    const current = states.get(conversationId);
    if (!current) return; // already flushed

    if (answer?.startsWith('WAIT')) {
      const waitSec = parseInt(answer.split(/\s+/)[1]) || 5;
      console.log(`[debounce] judge says WAIT ${waitSec}s`);
      // Wait specified seconds, then re-judge if no new message arrived
      current.processing = false; // allow new messages to cancel this wait
      await Bun.sleep(waitSec * 1000);
      const still = states.get(conversationId);
      if (!still) return; // flushed or cancelled
      // Re-judge with any new messages that arrived during wait
      still.processing = false;
      judge(conversationId, botId, onReady);
      return; // skip the finally processing=false since we set it above
    } else {
      flush(conversationId, onReady);
    }
  } catch (e) {
    console.error('[debounce] judge error, flushing:', e);
    flush(conversationId, onReady);
  } finally {
    const s = states.get(conversationId);
    if (s) s.processing = false;
  }
}

function flush(conversationId: string, onReady: (mergedContent: string) => void): void {
  const state = states.get(conversationId);
  if (!state) return;

  if (state.hardTimer) clearTimeout(state.hardTimer);

  const merged = state.pendingMessages.join('\n');
  states.delete(conversationId);
  clearDebounceBuffer(conversationId);

  if (merged.trim()) {
    console.log(`[debounce] flushed → "${merged.slice(0, 80)}${merged.length > 80 ? '...' : ''}"`);
    onReady(merged);
  }
}

export function cancelPending(conversationId: string): void {
  const state = states.get(conversationId);
  if (state) {
    if (state.hardTimer) clearTimeout(state.hardTimer);
    states.delete(conversationId);
    clearDebounceBuffer(conversationId);
  }
}
