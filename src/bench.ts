/**
 * TTFT benchmark endpoint.
 *
 * Benchmarks time-to-first-token across OpenAI-compatible models.
 * Uses OPENAI_API_KEY and GROQ_API_KEY; models whose provider has no key
 * configured are skipped.
 */

import type { Express, Request, Response } from 'express';
import OpenAI from 'openai';

import { getLogger } from './log.ts';

const logger = getLogger('bench');

const BENCH_PROMPT = 'Explain how a combustion engine works.';

// provider is used to look up the right OpenAI-compatible client
interface ModelEntry {
  name: string;
  provider: string;
  modelId: string;
}

const DEFAULT_MODELS: ModelEntry[] = [
  // OpenAI 4-series
  { name: 'gpt-4o-mini', provider: 'openai', modelId: 'gpt-4o-mini' },
  { name: 'gpt-4o', provider: 'openai', modelId: 'gpt-4o' },
  { name: 'gpt-4.1-nano', provider: 'openai', modelId: 'gpt-4.1-nano' },
  { name: 'gpt-4.1-mini', provider: 'openai', modelId: 'gpt-4.1-mini' },
  { name: 'gpt-4.1', provider: 'openai', modelId: 'gpt-4.1' },
  // OpenAI 5-series
  { name: 'gpt-5-nano', provider: 'openai', modelId: 'gpt-5-nano' },
  { name: 'gpt-5-mini', provider: 'openai', modelId: 'gpt-5-mini' },
  { name: 'gpt-5', provider: 'openai', modelId: 'gpt-5' },
  { name: 'gpt-5.1', provider: 'openai', modelId: 'gpt-5.1' },
  { name: 'gpt-5.2', provider: 'openai', modelId: 'gpt-5.2' },
  // Groq
  { name: 'groq/llama-3.3-70b', provider: 'groq', modelId: 'llama-3.3-70b-versatile' },
  { name: 'groq/llama-3.1-8b', provider: 'groq', modelId: 'llama-3.1-8b-instant' },
];

const BENCH_MESSAGES = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: BENCH_PROMPT },
];

/** Build provider -> OpenAI-compatible client map. */
function makeClients(): Map<string, OpenAI> {
  const clients = new Map<string, OpenAI>();
  const oaiKey = process.env.OPENAI_API_KEY;
  if (oaiKey) {
    clients.set('openai', new OpenAI({ apiKey: oaiKey }));
  }
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    clients.set(
      'groq',
      new OpenAI({ apiKey: groqKey, baseURL: 'https://api.groq.com/openai/v1' }),
    );
  }
  return clients;
}

/**
 * Single TTFT measurement in milliseconds.
 *
 * Opens a streaming completion, records time-to-first-content-token,
 * then aborts the stream immediately.
 */
async function measureTtft(client: OpenAI, model: string): Promise<number> {
  // GPT-5+ uses max_completion_tokens; older models use max_tokens
  const isNew = ['gpt-5', 'o1', 'o3', 'o4'].some((p) => model.startsWith(p));

  const params: Record<string, unknown> = {
    model,
    messages: BENCH_MESSAGES,
    stream: true,
    [isNew ? 'max_completion_tokens' : 'max_tokens']: 20,
  };
  if (isNew) {
    // Use lowest reasoning effort the model accepts:
    // try "none" first, fall back to "minimal"
    params.reasoning_effort = 'none';
  } else {
    params.temperature = 0;
  }

  const create = (p: Record<string, unknown>) =>
    client.chat.completions.create(
      p as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
    );

  let t0 = performance.now();
  let stream;
  try {
    stream = await create(params);
  } catch (err) {
    if (isNew && String(err).toLowerCase().includes('none')) {
      // Model doesn't support "none" -- retry with "minimal"
      params.reasoning_effort = 'minimal';
      t0 = performance.now();
      stream = await create(params);
    } else {
      throw err;
    }
  }

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;
    if (delta?.content) {
      const ttftMs = performance.now() - t0;
      stream.controller.abort();
      return ttftMs;
    }
  }
  // edge case: no content tokens at all
  return performance.now() - t0;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Mount GET /bench/ttft.
 *
 * Usage:
 *     curl https://your-server/bench/ttft
 *     curl "https://your-server/bench/ttft?models=gpt-4o-mini,gpt-4o&runs=5"
 */
export function mountBench(app: Express): void {
  app.get('/bench/ttft', async (req: Request, res: Response) => {
    const clients = makeClients();

    // Runs per model (default 30, clamped to 1..100)
    let runs = Number.parseInt(String(req.query.runs ?? '30'), 10);
    if (!Number.isFinite(runs)) runs = 30;
    runs = Math.min(100, Math.max(1, runs));

    // Build model list: use DEFAULT_MODELS or parse comma-separated overrides
    const modelsParam = typeof req.query.models === 'string' ? req.query.models : null;
    let modelEntries: ModelEntry[];
    if (modelsParam) {
      // For custom input, assume openai provider unless "groq/" prefixed
      modelEntries = modelsParam
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean)
        .map((m) =>
          m.startsWith('groq/')
            ? { name: m, provider: 'groq', modelId: m.slice('groq/'.length) }
            : { name: m, provider: 'openai', modelId: m },
        );
    } else {
      modelEntries = DEFAULT_MODELS;
    }

    // Filter out models whose provider has no API key
    modelEntries = modelEntries.filter((e) => clients.has(e.provider));

    // Build a shuffled schedule: each model appears `runs` times, interleaved
    const schedule = modelEntries.flatMap((e) =>
      Array.from({ length: runs }, (_, i) => ({ ...e, runIndex: i })),
    );
    for (let i = schedule.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [schedule[i], schedule[j]] = [schedule[j]!, schedule[i]!];
    }

    const total = schedule.length;
    logger.info(
      `TTFT benchmark: ${modelEntries.length} models × ${runs} runs = ${total} calls (randomised)`,
    );

    const timesByModel = new Map<string, number[]>();
    const errorsByModel = new Map<string, string[]>();

    for (let idx = 0; idx < schedule.length; idx++) {
      const { name, provider, modelId, runIndex } = schedule[idx]!;
      try {
        const ms = await measureTtft(clients.get(provider)!, modelId);
        const times = timesByModel.get(name) ?? [];
        times.push(round1(ms));
        timesByModel.set(name, times);
        logger.info(`  [${idx + 1}/${total}] ${name} #${runIndex + 1} → ${Math.round(ms)} ms`);
      } catch (err) {
        const errors = errorsByModel.get(name) ?? [];
        errors.push(`run ${runIndex + 1}: ${String(err)}`);
        errorsByModel.set(name, errors);
        logger.info(`  [${idx + 1}/${total}] ${name} #${runIndex + 1} → ERROR`);
      }
    }

    // Aggregate stats per model (preserve original order)
    const results = modelEntries.map(({ name }) => {
      const times = timesByModel.get(name) ?? [];
      const errors = errorsByModel.get(name) ?? [];

      if (times.length === 0) {
        const error = errors[0] ?? 'no data';
        logger.info(`  ${name} → ERROR: ${error}`);
        return { model: name, error };
      }

      const avg = round1(times.reduce((a, b) => a + b, 0) / times.length);
      const entry: Record<string, unknown> = {
        model: name,
        runs: times.length,
        avg_ms: avg,
        min_ms: Math.min(...times),
        max_ms: Math.max(...times),
        all_ms: times,
      };
      if (errors.length > 0) entry.errors = errors;
      logger.info(`  ${name} → avg ${avg} ms  (min ${Math.min(...times)}, max ${Math.max(...times)})`);
      return entry;
    });

    res.json({
      prompt: BENCH_PROMPT,
      runs_per_model: runs,
      results,
    });
  });
}
