/**
 * Type definitions for the voice agent.
 *
 * State, events, and actions are readonly discriminated unions -- the
 * TypeScript equivalent of shuo's frozen dataclasses. The `type` tag gives
 * the state machine exhaustive switch checking at compile time.
 *
 * Conversation history lives in Agent, not in AppState.
 */

// =============================================================================
// STATE
// =============================================================================

/** Current phase of the conversation. */
export type Phase =
  | 'LISTENING'   // Waiting for user / user speaking
  | 'RESPONDING'; // Agent active (LLM -> TTS -> Playback)

/**
 * Application state -- just routing information.
 *
 * Conversation history is owned by Agent, not tracked here.
 */
export interface AppState {
  readonly phase: Phase;
  readonly streamSid: string | null;
}

export const initialState: AppState = {
  phase: 'LISTENING',
  streamSid: null,
};

// =============================================================================
// EVENTS (inputs to the system)
// =============================================================================

/** Twilio stream started. */
export interface StreamStartEvent {
  readonly type: 'stream_start';
  readonly streamSid: string;
}

/** Twilio stream ended. */
export interface StreamStopEvent {
  readonly type: 'stream_stop';
}

/** Audio data received from Twilio. */
export interface MediaEvent {
  readonly type: 'media';
  readonly audio: Buffer;
}

/** Deepgram Flux detected user started speaking (barge-in). */
export interface FluxStartOfTurnEvent {
  readonly type: 'flux_start_of_turn';
}

/** Deepgram Flux detected user finished speaking. */
export interface FluxEndOfTurnEvent {
  readonly type: 'flux_end_of_turn';
  readonly transcript: string;
}

/** Agent finished speaking (playback complete). */
export interface AgentTurnDoneEvent {
  readonly type: 'agent_turn_done';
}

export type Event =
  | StreamStartEvent
  | StreamStopEvent
  | MediaEvent
  | FluxStartOfTurnEvent
  | FluxEndOfTurnEvent
  | AgentTurnDoneEvent;

// =============================================================================
// ACTIONS (outputs from the system)
// =============================================================================

/** Send audio to Deepgram Flux. */
export interface FeedFluxAction {
  readonly type: 'feed_flux';
  readonly audio: Buffer;
}

/** Start agent response pipeline. */
export interface StartAgentTurnAction {
  readonly type: 'start_agent_turn';
  readonly transcript: string;
}

/** Cancel agent response and clear Twilio buffer. */
export interface ResetAgentTurnAction {
  readonly type: 'reset_agent_turn';
}

export type Action =
  | FeedFluxAction
  | StartAgentTurnAction
  | ResetAgentTurnAction;
