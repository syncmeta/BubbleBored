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

// Splits streamed output into segments on \n\n (blank line).
// Triple-backtick fenced blocks are preserved as a single segment —
// any \n\n inside ```...``` does NOT split, so quoted/long content is safe.
export async function* streamWithSplit(
  stream: Stream<ChatCompletionChunk>,
  onSegmentReady: (segmentIndex: number, fullText: string) => void,
  meta?: StreamMeta,
): AsyncGenerator<StreamSegment> {
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

  for await (const chunk of stream) {
    // Capture generation ID and usage from chunks
    if (meta) {
      if (!meta.generationId && chunk.id) meta.generationId = chunk.id;
      if (chunk.usage) meta.usage = chunk.usage as any;
    }

    const content = chunk.choices[0]?.delta?.content;
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

      if (char === '\n' && !inCodeFence) {
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

