/**
 * ElevenLabs Text-to-Speech service with WebSocket streaming.
 *
 * Sends text chunks, receives audio chunks via callback.
 * Audio is returned as base64-encoded mulaw at 8kHz for Twilio.
 */

import WebSocket from 'ws';

import { ServiceLogger } from '../log.ts';
import { sleep, waitForOpen } from '../util.ts';

const log = new ServiceLogger('TTS');

export type AudioCallback = (audioBase64: string) => Promise<void> | void;
export type DoneCallback = () => Promise<void> | void;

export class TTSService {
  private onAudio: AudioCallback;
  private onDone: DoneCallback;

  private ws: WebSocket | null = null;
  private running = false;

  constructor(onAudio: AudioCallback, onDone: DoneCallback) {
    this.onAudio = onAudio;
    this.onDone = onDone;
  }

  get isActive(): boolean {
    return this.running && this.ws !== null;
  }

  /** Rebind callbacks (used by connection pool to assign per-turn handlers). */
  bind(onAudio: AudioCallback, onDone: DoneCallback): void {
    this.onAudio = onAudio;
    this.onDone = onDone;
  }

  /** Open WebSocket connection to ElevenLabs. */
  async start(): Promise<void> {
    if (this.running) return;

    const voiceId = process.env.ELEVENLABS_VOICE_ID ?? '21m00Tcm4TlvDq8ikWAM';
    const url =
      `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input` +
      '?model_id=eleven_turbo_v2_5&output_format=ulaw_8000';

    try {
      const ws = new WebSocket(url);
      await waitForOpen(ws);

      this.ws = ws;
      this.running = true;

      ws.on('message', (data) => this.handleMessage(data.toString()));
      ws.on('error', (err) => log.error('Socket error', err));
      ws.on('close', () => {
        // Closed while a turn is active -> report done so the turn can't hang
        if (this.running) {
          this.running = false;
          void this.onDone();
        }
      });

      ws.send(
        JSON.stringify({
          text: ' ',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          xi_api_key: process.env.ELEVENLABS_API_KEY ?? '',
        }),
      );

      log.connected();
    } catch (err) {
      log.error('Connection failed', err);
      throw err;
    }
  }

  /** Send text chunk for synthesis. */
  send(text: string): void {
    if (!this.ws || !this.running) return;
    try {
      this.ws.send(JSON.stringify({ text, try_trigger_generation: true }));
    } catch (err) {
      log.error('Send failed', err);
    }
  }

  /** Force synthesis of any buffered text. */
  flush(): void {
    if (!this.ws || !this.running) return;
    try {
      this.ws.send(JSON.stringify({ text: '', flush: true }));
    } catch (err) {
      log.error('Flush failed', err);
    }
  }

  /** Close connection gracefully after flushing. */
  async stop(): Promise<void> {
    if (!this.running) return;
    try {
      this.flush();
      await sleep(200);
    } catch (err) {
      log.error('Stop failed', err);
    } finally {
      this.cleanup();
    }
    log.disconnected();
  }

  /** Abort connection immediately. */
  cancel(): void {
    this.running = false;
    this.cleanup();
    log.cancelled();
  }

  private cleanup(): void {
    this.running = false;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // already closed
      }
      this.ws = null;
    }
  }

  /** Parse and handle ElevenLabs response. */
  private handleMessage(message: string): void {
    if (!this.running) return;
    try {
      const data = JSON.parse(message) as { audio?: string; isFinal?: boolean };

      if (data.audio) {
        void this.onAudio(data.audio);
      }
      if (data.isFinal) {
        void this.onDone();
      }
    } catch {
      log.error(`Invalid JSON: ${message.slice(0, 100)}`);
    }
  }
}
