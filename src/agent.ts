/**
 * Agent -- self-contained LLM -> TTS -> Player pipeline.
 *
 * Encapsulates the entire agent response lifecycle.
 * Owns conversation history across turns.
 *
 *     startTurn(transcript) -> add to history -> LLM -> TTS -> Player -> Twilio
 *     cancelTurn()          -> cancel all, keep history
 *
 * TTS connections are managed by TTSPool (see services/ttsPool.ts).
 */

import type WebSocket from 'ws';

import { ServiceLogger } from './log.ts';
import { LLMService, type ChatMessage } from './services/llm.ts';
import { AudioPlayer } from './services/player.ts';
import type { TTSService } from './services/tts.ts';
import type { TTSPool } from './services/ttsPool.ts';
import type { Tracer } from './tracer.ts';

const log = new ServiceLogger('Agent');

/**
 * Self-contained agent response pipeline.
 *
 * LLM is persistent (keeps conversation history across turns).
 * TTS connections come from TTSPool (pre-connected, with TTL eviction).
 * Player is created fresh per turn.
 */
export class Agent {
  private websocket: WebSocket;
  private streamSid: string;
  private onDone: () => void;
  private ttsPool: TTSPool;
  private tracer: Tracer;

  // Persistent LLM -- keeps conversation history across turns
  private llm: LLMService;

  // Active per-turn services (set during start, cleared on cancel)
  private tts: TTSService | null = null;
  private player: AudioPlayer | null = null;
  private active = false;

  // Current turn number (for tracer)
  private turn = 0;

  // Latency milestones (performance.now() timestamps, reset each turn)
  private t0 = 0;
  private tFirstToken = 0;
  private gotFirstToken = false;
  private gotFirstAudio = false;

  constructor(
    websocket: WebSocket,
    streamSid: string,
    onDone: () => void,
    ttsPool: TTSPool,
    tracer: Tracer,
  ) {
    this.websocket = websocket;
    this.streamSid = streamSid;
    this.onDone = onDone;
    this.ttsPool = ttsPool;
    this.tracer = tracer;

    this.llm = new LLMService(
      (token) => this.onLlmToken(token),
      () => this.onLlmDone(),
    );
  }

  get isTurnActive(): boolean {
    return this.active;
  }

  /** Read-only access to conversation history (owned by LLM). */
  get history(): ChatMessage[] {
    return this.llm.history;
  }

  private msSinceT0(): number {
    return Math.round(performance.now() - this.t0);
  }

  // -- Turn Lifecycle -------------------------------------------------------

  /** Start a new agent turn. */
  async startTurn(transcript: string): Promise<void> {
    if (this.active) await this.cancelTurn();

    this.active = true;
    this.t0 = performance.now();
    this.gotFirstToken = false;
    this.gotFirstAudio = false;

    // Begin tracing this turn
    this.turn = this.tracer.beginTurn(transcript);
    this.tracer.begin(this.turn, 'tts_pool');

    // Get TTS from pool (instant if warm, blocks if cold)
    this.tts = await this.ttsPool.get(
      (audio) => this.onTtsAudio(audio),
      () => this.onTtsDone(),
    );
    const ttsMs = this.msSinceT0();
    this.tracer.end(this.turn, 'tts_pool');

    // Create player
    this.player = new AudioPlayer(this.websocket, this.streamSid, () =>
      this.onPlaybackDone(),
    );

    // Start LLM
    this.tracer.begin(this.turn, 'llm');
    await this.llm.start(transcript);

    log.info(`Turn started  (TTS ${ttsMs}ms setup)`);
  }

  /** Cancel current turn, preserve history. */
  async cancelTurn(): Promise<void> {
    if (!this.active) return;

    const elapsed = this.t0 ? this.msSinceT0() : 0;
    this.active = false;

    // Mark turn as cancelled (ends all open spans)
    this.tracer.cancelTurn(this.turn);

    // Cancel in order: LLM -> TTS -> Player
    await this.llm.cancel();

    if (this.tts) {
      this.tts.cancel();
      this.tts = null;
    }

    if (this.player) {
      if (this.player.isPlaying) {
        await this.player.stopAndClear();
      }
      this.player = null;
    }

    log.info(`Turn cancelled at +${elapsed}ms (history preserved)`);
  }

  /** Final cleanup when call ends. */
  async cleanup(): Promise<void> {
    if (this.active) await this.cancelTurn();
  }

  // -- Internal Callbacks ---------------------------------------------------

  /** LLM produced a token -> feed to TTS. */
  private onLlmToken(token: string): void {
    if (!this.active || !this.tts) return;

    if (!this.gotFirstToken) {
      this.gotFirstToken = true;
      this.tFirstToken = performance.now();
      this.tracer.mark(this.turn, 'llm_first_token');
      this.tracer.begin(this.turn, 'tts');
      log.info(`⏱  LLM first token  +${this.msSinceT0()}ms`);
    }

    this.tts.send(token);
  }

  /** LLM finished -> flush TTS. */
  private onLlmDone(): void {
    if (!this.active || !this.tts) return;
    this.tracer.end(this.turn, 'llm');
    this.tts.flush();
  }

  /** TTS produced audio -> send to player. */
  private onTtsAudio(audioBase64: string): void {
    if (!this.active || !this.player) return;

    if (!this.gotFirstAudio) {
      this.gotFirstAudio = true;
      const tFirstAudio = performance.now();
      this.tracer.mark(this.turn, 'tts_first_audio');
      this.tracer.begin(this.turn, 'player');
      const ttft = this.msSinceT0();
      const sinceToken = this.gotFirstToken
        ? Math.round(tFirstAudio - this.tFirstToken)
        : 0;
      log.info(`⏱  TTS first audio  +${ttft}ms  (TTS latency ${sinceToken}ms)`);
    }

    this.player.sendChunk(audioBase64);
  }

  /** TTS finished -> tell player no more chunks coming. */
  private onTtsDone(): void {
    if (!this.active || !this.player) return;
    this.tracer.end(this.turn, 'tts');
    this.player.markTtsDone();
  }

  /** Player finished -> turn is complete. */
  private onPlaybackDone(): void {
    if (!this.active) return;

    this.tracer.end(this.turn, 'player');
    log.info(`⏱  Turn complete    +${this.msSinceT0()}ms total`);

    this.active = false;
    this.tts = null;
    this.player = null;

    this.onDone();
  }
}
