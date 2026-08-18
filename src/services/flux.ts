/**
 * Deepgram Flux service -- always-on STT + turn detection.
 *
 * A single persistent WebSocket to Deepgram's v2 listen API. Receives all
 * Twilio audio continuously and emits turn events. Uses a raw WebSocket
 * instead of an SDK: the Flux protocol is plain JSON messages (TurnInfo)
 * over one socket, so no dependency is needed.
 */

import WebSocket from 'ws';

import { ServiceLogger } from '../log.ts';
import { waitForOpen } from '../util.ts';

const log = new ServiceLogger('Flux');

// The Python original pinned wss://api.eu.deepgram.com; the US endpoint is
// the default here. Set DEEPGRAM_BASE_URL to override.
const DEFAULT_BASE_URL = 'wss://api.deepgram.com';

/**
 * Deepgram Flux streaming service.
 *
 * Audio format: mulaw 8kHz (direct from Twilio, no conversion needed).
 * Turn events: StartOfTurn (barge-in), EndOfTurn (with transcript).
 */
export class FluxService {
  private onEndOfTurn: (transcript: string) => void;
  private onStartOfTurn: () => void;

  private ws: WebSocket | null = null;
  private running = false;

  constructor(onEndOfTurn: (transcript: string) => void, onStartOfTurn: () => void) {
    this.onEndOfTurn = onEndOfTurn;
    this.onStartOfTurn = onStartOfTurn;
  }

  get isActive(): boolean {
    return this.running && this.ws !== null;
  }

  /** Connect to Deepgram Flux (always-on for the duration of the call). */
  async start(): Promise<void> {
    if (this.running) return;

    const base = process.env.DEEPGRAM_BASE_URL ?? DEFAULT_BASE_URL;
    const url = `${base}/v2/listen?model=flux-general-en&encoding=mulaw&sample_rate=8000`;

    try {
      const ws = new WebSocket(url, {
        headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY ?? ''}` },
      });
      await waitForOpen(ws);

      ws.on('message', (data) => this.handleMessage(data.toString()));
      ws.on('error', (err) => log.error('Deepgram: ' + String(err)));

      this.ws = ws;
      this.running = true;
      log.connected();
    } catch (err) {
      log.error('Connection failed', err);
      this.cleanup();
      throw err;
    }
  }

  /** Send audio chunk to Deepgram Flux. */
  send(audio: Buffer): void {
    if (!this.ws || !this.running) return;
    try {
      this.ws.send(audio);
    } catch (err) {
      log.error('Send failed', err);
    }
  }

  /** Disconnect from Deepgram Flux. */
  stop(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'CloseStream' }));
      } catch {
        // socket already closing
      }
    }
    this.cleanup();
    log.disconnected();
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

  /** Handle Flux messages -- parse TurnInfo events. */
  private handleMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw) as { type?: string; event?: string; transcript?: string };

      if (msg.type === 'TurnInfo') {
        if (msg.event === 'EndOfTurn') {
          this.onEndOfTurn((msg.transcript ?? '').trim());
        } else if (msg.event === 'StartOfTurn') {
          this.onStartOfTurn();
        }
      } else if (msg.type === 'Error') {
        log.error('Deepgram: ' + raw);
      }
    } catch (err) {
      log.error('Message handling failed', err);
    }
  }
}
