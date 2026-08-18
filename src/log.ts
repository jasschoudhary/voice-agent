/**
 * Centralized colored logging -- port of shuo/log.py.
 *
 * Provides:
 * - getLogger for plain named loggers
 * - Logger for consistent event/lifecycle/action logging
 * - ServiceLogger for individual services
 */

import type { Action, Event, Phase } from './types.ts';

// =============================================================================
// COLORS
// =============================================================================

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const WHITE = '\x1b[37m';
const BRIGHT_RED = '\x1b[91m';
const BRIGHT_GREEN = '\x1b[92m';
const BRIGHT_BLUE = '\x1b[94m';
const BRIGHT_MAGENTA = '\x1b[95m';
const BRIGHT_CYAN = '\x1b[96m';

/** Debug-level lines (disconnected/cancelled/...) print only when LOG_DEBUG=1. */
const DEBUG = process.env.LOG_DEBUG === '1';

function c(color: string, text: string): string {
  return color + text + RESET;
}

function quote(text: string, color: string = WHITE): string {
  return c(color, `"${text}"`);
}

/** Millisecond-precision timestamps for latency debugging. */
function timestamp(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function emit(msg: string): void {
  console.log(`${c(DIM, timestamp())} │ ${msg}`);
}

// =============================================================================
// PLAIN NAMED LOGGERS
// =============================================================================

export interface NamedLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

export function getLogger(_name: string): NamedLogger {
  return {
    info: (msg) => emit(msg),
    warn: (msg) => emit(c(YELLOW, msg)),
    error: (msg) => emit(c(RED, msg)),
    debug: (msg) => {
      if (DEBUG) emit(c(DIM, msg));
    },
  };
}

// =============================================================================
// LOGGER (unified lifecycle + event + action logging)
// =============================================================================

/**
 * Unified logger.
 *
 * Static methods   -- lifecycle events (server, call, websocket, stream)
 * Instance methods -- event/action/transition logging in the conversation loop
 */
export class Logger {
  private verbose: boolean;

  constructor(verbose = false) {
    this.verbose = verbose;
  }

  // -- Lifecycle (static) ------------------------------------------------

  static serverStarting(port: number): void {
    emit(`\u{1F680} ${c(CYAN, `Server starting on port ${port}`)}`);
  }

  static serverReady(url: string): void {
    emit(`${c(GREEN, '✓  Ready')} ${c(DIM, url)}`);
  }

  static callInitiating(phone: string): void {
    emit(`\u{1F4DE} ${c(CYAN, `Calling ${phone}...`)}`);
  }

  static callInitiated(sid: string): void {
    emit(`${c(GREEN, '✓  Call initiated')} ${c(DIM, `SID: ${sid.slice(0, 8)}...`)}`);
  }

  static websocketConnected(): void {
    emit(`\u{1F50C} ${c(CYAN, 'WebSocket connected')}`);
  }

  static websocketDisconnected(): void {
    emit(`\u{1F50C} ${c(DIM, 'WebSocket disconnected')}`);
  }

  static shutdown(): void {
    emit(`\u{1F44B} ${c(DIM, 'Shutting down')}`);
  }

  // -- Instance methods (conversation loop) --------------------------------

  /** Log an incoming event. */
  event(event: Event): void {
    switch (event.type) {
      case 'media':
        if (this.verbose && DEBUG) {
          emit(c(DIM, `← MediaEvent (${event.audio.length} bytes)`));
        }
        return;

      case 'stream_start':
        emit(
          `${c(GREEN, '▶  Stream started')} ` +
            c(DIM, `SID: ${event.streamSid.slice(0, 8)}...`),
        );
        return;

      case 'stream_stop':
        emit(`⏹  ${c(DIM, 'Stream stopped')}`);
        return;

      case 'flux_end_of_turn': {
        let text = event.transcript;
        if (text.length > 60) text = text.slice(0, 57) + '...';
        emit(
          `${c(GREEN, '←')} ${c(BRIGHT_BLUE, 'Flux')} ` +
            `${c(GREEN, 'EndOfTurn')} ${quote(text)}`,
        );
        return;
      }

      case 'flux_start_of_turn':
        emit(
          `${c(BRIGHT_RED, '⚡')} ${c(BRIGHT_BLUE, 'Flux')} ` +
            `${c(BRIGHT_RED, 'StartOfTurn')} ${c(DIM, '(barge-in)')}`,
        );
        return;

      case 'agent_turn_done':
        emit(`${c(GREEN, '←')} ${c(DIM, 'Agent turn done')}`);
        return;
    }
  }

  /** Log an outgoing action. */
  action(action: Action): void {
    switch (action.type) {
      case 'feed_flux':
        if (this.verbose && DEBUG) {
          emit(c(DIM, `→ FeedFlux (${action.audio.length} bytes)`));
        }
        return;

      case 'start_agent_turn': {
        let msg = action.transcript;
        if (msg.length > 40) msg = msg.slice(0, 37) + '...';
        emit(
          `${c(YELLOW, '→')} ${c(YELLOW, 'Start')} ` +
            `${c(BRIGHT_CYAN, 'Agent')} ${quote(msg, DIM)}`,
        );
        return;
      }

      case 'reset_agent_turn':
        emit(`${c(YELLOW, '→')} ${c(BRIGHT_RED, 'Reset')} ${c(BRIGHT_CYAN, 'Agent')}`);
        return;
    }
  }

  /** Log a phase transition (magenta). */
  transition(oldPhase: Phase, newPhase: Phase): void {
    if (oldPhase !== newPhase) {
      emit(
        `${c(MAGENTA, '◆')} ${c(DIM, oldPhase)} ` +
          `${c(MAGENTA, '→')} ${c(BRIGHT_MAGENTA, newPhase)}`,
      );
    }
  }

  /** Log an error (red). */
  error(msg: string, err?: unknown): void {
    if (err !== undefined) {
      emit(`${c(RED, `✗ ${msg}:`)} ${c(DIM, String(err))}`);
    } else {
      emit(c(RED, `✗ ${msg}`));
    }
  }
}

// =============================================================================
// SERVICE LOGGING
// =============================================================================

const SERVICE_COLORS: Record<string, string> = {
  Flux: BRIGHT_BLUE,
  LLM: BRIGHT_MAGENTA,
  TTS: BRIGHT_CYAN,
  TTSPool: BRIGHT_CYAN,
  Player: WHITE,
  Agent: BRIGHT_GREEN,
};

/** Logger for individual services (Flux, LLM, TTS, Player, Agent). */
export class ServiceLogger {
  private name: string;
  private color: string;

  constructor(serviceName: string) {
    this.name = serviceName;
    this.color = SERVICE_COLORS[serviceName] ?? WHITE;
  }

  connected(): void {
    emit(`${c(GREEN, '✓')} ${c(this.color, this.name)} ${c(DIM, 'connected')}`);
  }

  disconnected(): void {
    if (DEBUG) emit(c(DIM, `○ ${this.name} disconnected`));
  }

  cancelled(): void {
    if (DEBUG) emit(c(DIM, `○ ${this.name} cancelled`));
  }

  info(msg: string): void {
    emit(`  ${c(this.color, `${this.name}:`)} ${msg}`);
  }

  debug(msg: string): void {
    if (DEBUG) emit(`  ${c(DIM, `${this.name}: ${msg}`)}`);
  }

  error(msg: string, err?: unknown): void {
    if (err !== undefined) {
      emit(
        `${c(RED, '✗')} ${c(this.color, `${this.name}:`)} ${msg} ` +
          c(DIM, `(${String(err)})`),
      );
    } else {
      emit(`${c(RED, '✗')} ${c(this.color, `${this.name}:`)} ${msg}`);
    }
  }
}
