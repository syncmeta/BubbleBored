import type { Stream } from 'openai/streaming';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';

export interface StreamSegment {
  segmentIndex: number;
  delta: string;
  isNewSegment: boolean;
}

export async function* streamWithSplit(
  stream: Stream<ChatCompletionChunk>,
  onSegmentReady: (segmentIndex: number, fullText: string) => void
): AsyncGenerator<StreamSegment> {
  let currentSegment = 0;
  let buffer = '';
  let pipeCount = 0;

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content;
    if (!content) continue;

    for (const char of content) {
      if (char === '|') {
        pipeCount++;
        if (pipeCount === 3) {
          // Found |||, complete current segment
          onSegmentReady(currentSegment, buffer);
          currentSegment++;
          buffer = '';
          pipeCount = 0;
          yield { segmentIndex: currentSegment, delta: '', isNewSegment: true };
        }
        continue;
      }

      // Not a pipe - flush any accumulated pipes as regular content
      if (pipeCount > 0) {
        const pipes = '|'.repeat(pipeCount);
        buffer += pipes;
        yield { segmentIndex: currentSegment, delta: pipes, isNewSegment: false };
        pipeCount = 0;
      }

      buffer += char;
      yield { segmentIndex: currentSegment, delta: char, isNewSegment: false };
    }
  }

  // Flush remaining pipes
  if (pipeCount > 0) {
    const pipes = '|'.repeat(pipeCount);
    buffer += pipes;
    yield { segmentIndex: currentSegment, delta: pipes, isNewSegment: false };
  }

  // Final segment
  if (buffer) {
    onSegmentReady(currentSegment, buffer);
  }
}

export function collectStream(
  stream: Stream<ChatCompletionChunk>
): Promise<{ content: string; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }> {
  return new Promise(async (resolve) => {
    let content = '';
    let usage: any;
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) content += delta;
      if (chunk.usage) usage = chunk.usage;
    }
    resolve({ content, usage });
  });
}
