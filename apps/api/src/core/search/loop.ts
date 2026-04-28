import { configManager } from '../../config/loader';
import { chatCompletion } from '../../llm/client';
import { logAudit, type TaskType } from '../../llm/audit';
import { mcpManager } from '../../mcp/manager';

export interface Finding {
  content: string;
  source?: string;
}

export interface SearchLoopOptions {
  userId: string;
  conversationId: string;
  model: string;
  queries: string[];
  budget: number;
  evalPromptName: string;           // 'review-eval.md' | 'surfing-eval.md'
  taskType: Extract<TaskType, 'review_eval' | 'surfing_eval'>;
  emitLog: (content: string) => void;
  signal?: AbortSignal;
}

export interface SearchLoopResult {
  findings: Finding[];
  used: number;
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    throw err;
  }
}

export async function runSearchLoop(opts: SearchLoopOptions): Promise<SearchLoopResult> {
  const { userId, conversationId, model, queries, budget, evalPromptName, taskType, emitLog, signal } = opts;

  const findings: Finding[] = [];
  if (queries.length === 0 || budget <= 0) return { findings, used: 0 };

  const evalPrompt = await configManager.readPrompt(evalPromptName);
  let remaining = budget;
  const startBudget = budget;

  for (let qi = 0; qi < queries.length; qi++) {
    checkAborted(signal);
    if (remaining <= 1) break;
    const query = queries[qi];

    emitLog(`搜索 (${qi + 1}/${queries.length})：${query}`);

    let searchResults: string;
    try {
      searchResults = await mcpManager.searchWeb(query);
    } catch (e: any) {
      emitLog(`搜索「${query}」失败：${e?.message ?? e}`);
      continue;
    }

    checkAborted(signal);

    const { result: evalResult, latencyMs: evalLatency, costUsd: evalCost } = await chatCompletion({
      model,
      messages: [
        { role: 'system', content: evalPrompt },
        { role: 'user', content: `搜索查询: ${query}\n剩余请求次数: ${remaining}\n\n搜索结果：\n${searchResults}` },
      ],
    });
    remaining--;

    logAudit({
      userId, conversationId, taskType, model,
      inputTokens: evalResult.usage?.prompt_tokens ?? 0,
      outputTokens: evalResult.usage?.completion_tokens ?? 0,
      totalTokens: evalResult.usage?.total_tokens ?? 0,
      costUsd: evalCost,
      generationId: evalResult.id,
      latencyMs: evalLatency,
    });

    const evalText = evalResult.choices[0]?.message?.content ?? '';
    const jsonMatch = evalText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) continue;

    let evalData: any;
    try {
      evalData = JSON.parse(jsonMatch[0]);
    } catch {
      continue;
    }

    if (Array.isArray(evalData.findings)) {
      for (const f of evalData.findings) {
        if (typeof f === 'string' && f.trim()) findings.push({ content: f });
      }
    }

    if (evalData.action === 'read' && typeof evalData.url === 'string' && remaining > 1) {
      checkAborted(signal);
      emitLog(`阅读：${evalData.url}`);
      try {
        const pageContent = await mcpManager.readUrl(evalData.url);
        checkAborted(signal);
        const { result: readEval, latencyMs: readLatency, costUsd: readCost } = await chatCompletion({
          model,
          messages: [
            { role: 'system', content: evalPrompt },
            { role: 'user', content: `阅读页面: ${evalData.url}\n剩余请求次数: ${remaining}\n\n页面内容：\n${pageContent}` },
          ],
        });
        remaining--;

        logAudit({
          userId, conversationId, taskType, model,
          inputTokens: readEval.usage?.prompt_tokens ?? 0,
          outputTokens: readEval.usage?.completion_tokens ?? 0,
          totalTokens: readEval.usage?.total_tokens ?? 0,
          costUsd: readCost,
          generationId: readEval.id,
          latencyMs: readLatency,
        });

        const readText = readEval.choices[0]?.message?.content ?? '';
        const readJson = readText.match(/\{[\s\S]*\}/);
        if (readJson) {
          try {
            const readData = JSON.parse(readJson[0]);
            if (Array.isArray(readData.findings)) {
              for (const f of readData.findings) {
                if (typeof f === 'string' && f.trim()) {
                  findings.push({ content: f, source: evalData.url });
                }
              }
            }
          } catch {}
        }
      } catch (e: any) {
        if (e?.name === 'AbortError') throw e;
        emitLog(`阅读失败：${e?.message ?? e}`);
      }
    }

    if (evalData.action === 'done') break;
  }

  return { findings, used: startBudget - remaining };
}
