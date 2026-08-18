/**
 * ElevenLabs TTS connection pool.
 *
 * Pre-connects WebSocket connections and manages their lifecycle.
 * Stale connections (past TTL) are evicted automatically.
 * The pool auto-refills after a connection is dispensed.
 *
 * Usage:
 *     const pool = new TTSPool(1, 8000);
 *     pool.start();
 *
 *     const tts = await pool.get(onAudio, onDone);
 *     // tts is ready to use immediately (if warm) or after a fresh connect
 *
 *     await pool.stop();
 */

import { ServiceLogger } from '../log.ts';
import { sleep } from '../util.ts';
import { TTSService, type AudioCallback, type DoneCallback } from './tts.ts';

const log = new ServiceLogger('TTSPool');

// No-op callbacks for pre-connected (idle) services
const noopAudio: AudioCallback = () => undefined;
const noopDone: DoneCallback = () => undefined;

/** A pooled TTS connection with its creation timestamp. */
interface PoolEntry {
  tts: TTSService;
  createdAt: number; // performance.now(), ms
}

/**
 * Connection pool for ElevenLabs TTS WebSockets.
 *
 * - Pre-connects `poolSize` connections at startup
 * - Dispenses warm connections via get() with callback rebinding
 * - Evicts connections older than `ttlMs`
 * - Auto-refills in the background after dispensing or eviction
 */
export class TTSPool {
  private poolSize: number;
  private ttlMs: number;

  private ready: PoolEntry[] = [];
  private running = false;
  private fillTask: Promise<void> | null = null;
  private fillSignal: (() => void) | null = null;

  constructor(poolSize = 1, ttlMs = 8000) {
    this.poolSize = poolSize;
    this.ttlMs = ttlMs;
  }

  /** Number of warm connections ready to dispense. */
  get available(): number {
    return this.ready.length;
  }

  /** Start the pool and begin pre-connecting. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.fillTask = this.fillLoop();
  }

  /**
   * Get a connected TTS service with the given callbacks.
   *
   * Returns a warm connection if available (and not stale),
   * otherwise blocks to create a fresh one.
   */
  async get(onAudio: AudioCallback, onDone: DoneCallback): Promise<TTSService> {
    // Try to grab a warm, non-stale connection
    while (this.ready.length > 0) {
      const entry = this.ready.shift()!;
      const age = performance.now() - entry.createdAt;

      if (age < this.ttlMs) {
        entry.tts.bind(onAudio, onDone);
        log.info(`Dispensed warm connection (idle ${Math.round(age)}ms)`);
        this.triggerFill();
        return entry.tts;
      }

      log.info(`Discarded stale connection (idle ${Math.round(age)}ms)`);
      entry.tts.cancel();
    }

    // No warm connections available -- create fresh (blocking)
    log.info('Pool empty, connecting fresh...');
    const tts = new TTSService(onAudio, onDone);
    await tts.start();
    this.triggerFill();
    return tts;
  }

  /** Shut down pool and clean up all connections. */
  async stop(): Promise<void> {
    this.running = false;
    this.triggerFill(); // unblock fill loop

    if (this.fillTask) {
      await this.fillTask;
      this.fillTask = null;
    }

    for (const entry of this.ready) {
      entry.tts.cancel();
    }
    this.ready = [];
  }

  /** Signal the fill loop to check pool levels. */
  private triggerFill(): void {
    this.fillSignal?.();
  }

  /** Background loop that keeps the pool at target size. */
  private async fillLoop(): Promise<void> {
    while (this.running) {
      // Evict stale entries
      this.evictStale();

      // Fill to target
      while (this.running && this.ready.length < this.poolSize) {
        const tts = new TTSService(noopAudio, noopDone);
        try {
          await tts.start();
          if (!this.running) {
            tts.cancel();
            break;
          }
          this.ready.push({ tts, createdAt: performance.now() });
          log.info(`\u{1F525} Warm connection ready (${this.ready.length}/${this.poolSize})`);
        } catch (err) {
          log.error('Pre-connect failed', err);
          await sleep(1000); // back off
        }
      }

      if (!this.running) break;

      // Wait for a signal (dispensed/evicted/stop) or periodic staleness check
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.fillSignal = null;
          resolve();
        }, this.ttlMs / 2);
        this.fillSignal = () => {
          clearTimeout(timer);
          this.fillSignal = null;
          resolve();
        };
      });
    }
  }

  /** Remove connections that have been idle past TTL. */
  private evictStale(): void {
    const now = performance.now();
    const fresh: PoolEntry[] = [];

    for (const entry of this.ready) {
      const age = now - entry.createdAt;
      if (age < this.ttlMs) {
        fresh.push(entry);
      } else {
        log.info(`Evicted stale connection (idle ${Math.round(age)}ms)`);
        entry.tts.cancel();
      }
    }

    this.ready = fresh;
  }
}
