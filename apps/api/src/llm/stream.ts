import type { Stream } from 'openai/streaming';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';

export interface StreamSegment {
  segmentIndex: number;
  delta: string;
  isNewSegment: boolean;
}

export interface StreamMeta {
  generationId?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cost?: number };
}

/// Accumulator the caller passes in to collect any tool-call deltas the model
/// emits over the stream. OpenRouter (like OpenAI) streams tool calls as
/// chunks of `{index, id?, function:{name?, arguments?}}` — the same call
/// arrives across many deltas, keyed by `index`. After the stream ends, the
/// caller inspects this map to decide whether a tool round happened and to
/// pull out the assembled call arguments.
export interface ToolCallAccum {
  index: number;
  id: string;
  name: string;
  args: string;
}

// Splits streamed output into segments on \n\n (blank line).
// Triple-backtick fenced blocks are preserved as a single segment —
// any \n\n inside ```...``` does NOT split, so quoted/long content is safe.
//
// `disableSplit: true` keeps the entire response as a single segment (used by
// the "normal AI" tone where multi-bubble splitting is undesirable).
export async function* streamWithSplit(
  stream: Stream<ChatCompletionChunk>,
  onSegmentReady: (segmentIndex: number, fullText: string) => void,
  meta?: StreamMeta,
  options?: {
    disableSplit?: boolean;
    /// When provided, tool-call deltas from the underlying chunks are merged
    /// into this map (keyed by the SDK's per-call `index`). The caller owns
    /// the map and reads it once iteration finishes — content deltas keep
    /// flowing through the generator unchanged either way.
    toolCallSink?: Map<number, ToolCallAccum>;
  },
): AsyncGenerator<StreamSegment> {
  const disableSplit = options?.disableSplit === true;
  let currentSegment = 0;
  let buffer = '';
  let pendingNewlines = 0;
  let pendingBackticks = 0;
  let inCodeFence = false;

  function* flushNewlines(): Generator<StreamSegment> {
    if (pendingNewlines > 0) {
      const nl = '\n'.repeat(pendingNewlines);
      buffer += nl;
      yield { segmentIndex: currentSegment, delta: nl, isNewSegment: false };
      pendingNewlines = 0;
    }
  }

  function* flushBackticks(): Generator<StreamSegment> {
    if (pendingBackticks > 0) {
      const bt = '`'.repeat(pendingBackticks);
      buffer += bt;
      yield { segmentIndex: currentSegment, delta: bt, isNewSegment: false };
      pendingBackticks = 0;
    }
  }

  const toolCallSink = options?.toolCallSink;

  for await (const chunk of stream) {
    // Capture generation ID and usage from chunks
    if (meta) {
      if (!meta.generationId && chunk.id) meta.generationId = chunk.id;
      if (chunk.usage) meta.usage = chunk.usage as any;
    }

    const delta = chunk.choices[0]?.delta as
      | { content?: string; tool_calls?: Array<{
          index?: number; id?: string;
          function?: { name?: string; arguments?: string };
        }> }
      | undefined;

    // Tool calls arrive incrementally — id + name in the first delta, then
    // arguments dribble in across subsequent deltas under the same index.
    if (toolCallSink && delta?.tool_calls?.length) {
      for (const tcd of delta.tool_calls) {
        const idx = tcd.index ?? 0;
        const existing = toolCallSink.get(idx) ?? { index: idx, id: '', name: '', args: '' };
        if (tcd.id) existing.id = tcd.id;
        if (tcd.function?.name) existing.name = tcd.function.name;
        if (tcd.function?.arguments) existing.args += tcd.function.arguments;
        toolCallSink.set(idx, existing);
      }
    }

    const content = delta?.content;
    if (!content) continue;

    for (const char of content) {
      if (char === '`') {
        // A newline followed by a backtick is regular content
        yield* flushNewlines();
        pendingBackticks++;
        if (pendingBackticks === 3) {
          inCodeFence = !inCodeFence;
          buffer += '```';
          yield { segmentIndex: currentSegment, delta: '```', isNewSegment: false };
          pendingBackticks = 0;
        }
        continue;
      }

      // Non-backtick: flush accumulated backticks as content
      yield* flushBackticks();

      if (char === '\n' && !inCodeFence && !disableSplit) {
        pendingNewlines++;
        if (pendingNewlines === 2) {
          // Segment boundary — \n\n consumed as delimiter, not emitted
          onSegmentReady(currentSegment, buffer);
          currentSegment++;
          buffer = '';
          pendingNewlines = 0;
          yield { segmentIndex: currentSegment, delta: '', isNewSegment: true };
        }
        continue;
      }

      // Single \n, or \n inside a code fence — treat as regular content
      yield* flushNewlines();

      buffer += char;
      yield { segmentIndex: currentSegment, delta: char, isNewSegment: false };
    }
  }

  // End of stream — flush any remaining pending state
  yield* flushBackticks();
  yield* flushNewlines();

  if (buffer) {
    onSegmentReady(currentSegment, buffer);
  }
}

