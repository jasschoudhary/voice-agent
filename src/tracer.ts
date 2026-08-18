/**
 * Lightweight span tracer -- port of shuo/tracer.py.
 *
 * Records begin/end spans and point-in-time markers for each agent turn.
 * Persists as JSON to <TRACE_DIR>/<call_id>.json on call end.
 * (The Python original wrote to /tmp/shuo; here the default is ./traces,
 * which also works on Windows. Override with the TRACE_DIR env var.)
 *
 * The JSON field names match the Python output byte-for-byte so existing
 * trace tooling keeps working.
 */

import fs from 'node:fs';
import path from 'node:path';

import { getLogger } from './log.ts';

const logger = getLogger('tracer');

export const TRACE_DIR = process.env.TRACE_DIR ?? path.join(process.cwd(), 'traces');

/** A named time range within a turn. */
interface Span {
  name: string;
  start_ms: number;
  end_ms: number | null;
}

/** A named point-in-time within a turn. */
interface Marker {
  name: string;
  time_ms: number;
}

/** All trace data for a single agent turn. */
interface Turn {
  turnNumber: number;
  transcript: string;
  t0: number; // performance.now() reference (not serialized)
  spans: Span[];
  markers: Marker[];
  cancelled: boolean;
}

/**
 * Records spans and markers for each agent turn.
 *
 * All timestamps are stored as milliseconds relative to the turn's t0.
 */
export class Tracer {
  private turns = new Map<number, Turn>();
  private turnCounter = 0;

  /** Start a new turn, returns turn number. */
  beginTurn(transcript: string): number {
    this.turnCounter += 1;
    this.turns.set(this.turnCounter, {
      turnNumber: this.turnCounter,
      transcript,
      t0: performance.now(),
      spans: [],
      markers: [],
      cancelled: false,
    });
    return this.turnCounter;
  }

  /** Begin a named span. */
  begin(turn: number, name: string): void {
    const t = this.turns.get(turn);
    if (!t) return;
    t.spans.push({ name, start_ms: performance.now() - t.t0, end_ms: null });
  }

  /** End a named span. */
  end(turn: number, name: string): void {
    const t = this.turns.get(turn);
    if (!t) return;
    const ms = performance.now() - t.t0;
    // Find the last span with this name that hasn't been ended
    for (let i = t.spans.length - 1; i >= 0; i--) {
      const span = t.spans[i]!;
      if (span.name === name && span.end_ms === null) {
        span.end_ms = ms;
        return;
      }
    }
  }

  /** Record a point-in-time marker. */
  mark(turn: number, name: string): void {
    const t = this.turns.get(turn);
    if (!t) return;
    t.markers.push({ name, time_ms: performance.now() - t.t0 });
  }

  /** Mark turn as cancelled and end all open spans at current time. */
  cancelTurn(turn: number): void {
    const t = this.turns.get(turn);
    if (!t) return;
    t.cancelled = true;
    const ms = performance.now() - t.t0;
    for (const span of t.spans) {
      if (span.end_ms === null) span.end_ms = ms;
    }
  }

  /** Write trace data to <TRACE_DIR>/<call_id>.json. */
  save(callId: string): string | null {
    if (this.turns.size === 0) return null;

    fs.mkdirSync(TRACE_DIR, { recursive: true });
    const safeId = callId.replace(/[^A-Za-z0-9_-]/g, '_');
    const filePath = path.join(TRACE_DIR, `${safeId}.json`);

    const data = {
      call_id: callId,
      turns: [...this.turns.values()]
        .sort((a, b) => a.turnNumber - b.turnNumber)
        .map((t) => ({
          turn: t.turnNumber,
          transcript: t.transcript,
          cancelled: t.cancelled,
          spans: t.spans,
          markers: t.markers,
        })),
    };

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    logger.info(`Trace saved to ${filePath}`);
    return filePath;
  }
}
