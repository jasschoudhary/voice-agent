/**
 * LLM service with streaming (Groq, OpenAI-compatible).
 *
 * Manages conversation history and streams tokens via callback.
 * Cancellation uses an AbortController (the Node equivalent of Python's
 * task.cancel()): abort() makes the SDK stream throw promptly, and the
 * partial response is kept in history, marked with a trailing "...".
 */

import OpenAI from 'openai';

import { ServiceLogger } from '../log.ts';

const log = new ServiceLogger('LLM');

const SYSTEM_PROMPT =
  'You are a helpful voice assistant. Keep your responses concise and ' +
  'conversational, as they will be spoken aloud. Avoid using markdown, ' +
  "bullet points, or other formatting that doesn't work well in speech. " +
  'Be friendly and natural.';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export class LLMService {
  private onToken: (token: string) => Promise<void> | void;
  private onDone: () => Promise<void> | void;

  private client: OpenAI;
  private historyList: ChatMessage[] = [];
  private running = false;
  private abortController: AbortController | null = null;
  private task: Promise<void> | null = null;

  constructor(
    onToken: (token: string) => Promise<void> | void,
    onDone: () => Promise<void> | void,
  ) {
    this.onToken = onToken;
    this.onDone = onDone;

    this.client = new OpenAI({
      apiKey: process.env.GROQ_API_KEY ?? '',
      baseURL: process.env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1',
    });
  }

  get isActive(): boolean {
    return this.running && this.task !== null;
  }

  get history(): ChatMessage[] {
    return [...this.historyList];
  }

  clearHistory(): void {
    this.historyList = [];
  }

  /** Start generating a response. */
  async start(userMessage: string): Promise<void> {
    if (this.running) await this.cancel();

    this.historyList.push({ role: 'user', content: userMessage });

    this.running = true;
    this.abortController = new AbortController();
    this.task = this.generate(this.abortController.signal);
    log.connected();
  }

  /** Cancel ongoing generation. */
  async cancel(): Promise<void> {
    this.running = false;
    this.abortController?.abort();

    if (this.task) {
      try {
        await this.task;
      } catch {
        // generate() handles its own errors
      }
      this.task = null;
    }

    log.cancelled();
  }

  /** Generate response and stream tokens. */
  private async generate(signal: AbortSignal): Promise<void> {
    let assistantResponse = '';

    try {
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...this.historyList,
      ];

      const stream = await this.client.chat.completions.create(
        {
          model: process.env.LLM_MODEL ?? 'llama-3.3-70b-versatile',
          messages,
          stream: true,
          max_tokens: 500,
          temperature: 0.7,
        },
        { signal },
      );

      for await (const chunk of stream) {
        if (!this.running) break;

        const token = chunk.choices[0]?.delta?.content;
        if (token) {
          assistantResponse += token;
          await this.onToken(token);
        }
      }

      if (this.running && assistantResponse) {
        this.historyList.push({ role: 'assistant', content: assistantResponse });
        await this.onDone();
      } else if (!this.running && assistantResponse) {
        // Cancelled mid-stream (barge-in) -- keep the partial response
        this.historyList.push({ role: 'assistant', content: assistantResponse + '...' });
      }
    } catch (err) {
      if (signal.aborted) {
        if (assistantResponse) {
          this.historyList.push({ role: 'assistant', content: assistantResponse + '...' });
        }
      } else {
        log.error('Generation failed', err);
        await this.onDone();
      }
    } finally {
      this.running = false;
      this.task = null;
    }
  }
}
