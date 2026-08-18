/**
 * Audio player for streaming audio to Twilio.
 *
 * Manages its own independent playback loop that drips audio
 * chunks at the correct rate, regardless of other activity.
 *
 * Features:
 * - Independent playback loop (not affected by incoming messages)
 * - Can be topped up with audio chunks dynamically (for streaming TTS)
 * - Instant stop and clear on interrupt
 * - Callback when playback completes
 */

import WebSocket from 'ws';

import { ServiceLogger } from '../log.ts';
import { sleep } from '../util.ts';

const log = new ServiceLogger('Player');

export class AudioPlayer {
  private ws: WebSocket;
  private streamSid: string;
  private onDone: (() => void) | null;

  private chunks: string[] = [];
  private index = 0;
  private running = false;
  private ttsDone = false;
  private task: Promise<void> | null = null;

  constructor(ws: WebSocket, streamSid: string, onDone: (() => void) | null = null) {
    this.ws = ws;
    this.streamSid = streamSid;
    this.onDone = onDone;
  }

  get isPlaying(): boolean {
    return this.running && this.task !== null;
  }

  /** Add an audio chunk to the playback queue (starts the loop if needed). */
  sendChunk(chunk: string): void {
    if (!this.running) this.start();
    this.chunks.push(chunk);
  }

  /** Signal that TTS is complete -- no more chunks coming. */
  markTtsDone(): void {
    this.ttsDone = true;
  }

  /** Stop playback immediately and clear Twilio's buffer. */
  async stopAndClear(): Promise<void> {
    this.running = false;

    if (this.task) {
      // The loop notices running=false within one sleep tick (<=20ms)
      await this.task;
      this.task = null;
    }

    this.chunks = [];
    this.index = 0;
    this.ttsDone = false;

    this.sendClear();
  }

  /** Start the playback loop. */
  private start(): void {
    this.chunks = [];
    this.index = 0;
    this.running = true;
    this.ttsDone = false;

    this.task = this.playbackLoop();
  }

  /** Independent loop that drips audio at ~20ms intervals. */
  private async playbackLoop(): Promise<void> {
    try {
      while (this.running) {
        if (this.index < this.chunks.length) {
          this.sendAudio(this.chunks[this.index]!);
          this.index += 1;
          await sleep(20);
        } else if (this.ttsDone) {
          break;
        } else {
          await sleep(10);
        }
      }

      if (this.running) {
        this.running = false;
        this.onDone?.();
      }
    } catch (err) {
      log.error('Playback failed', err);
      this.running = false;
    }
  }

  /** Send a single audio chunk to Twilio. */
  private sendAudio(payload: string): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        event: 'media',
        streamSid: this.streamSid,
        media: { payload },
      }),
    );
  }

  /** Send clear message to Twilio to flush its audio buffer. */
  private sendClear(): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        event: 'clear',
        streamSid: this.streamSid,
      }),
    );
  }
}
