/**
 * Pure state machine.
 *
 * processEvent is the heart of the system:
 *     (State, Event) -> [State, Action[]]
 *
 * With Deepgram Flux handling turn detection, this is a trivial
 * conversation controller (~30 lines of logic). No I/O, no mutation --
 * all side effects are performed by the dispatch loop in conversation.ts.
 */

import type { Action, AppState, Event } from './types.ts';

/**
 * Pure state machine: (State, Event) -> [State, Actions]
 *
 * With Flux, this is just a simple router:
 * - media              -> feed audio to Flux
 * - flux_end_of_turn   -> start agent response
 * - flux_start_of_turn -> interrupt (barge-in)
 * - agent_turn_done    -> back to listening
 */
export function processEvent(state: AppState, event: Event): [AppState, Action[]] {
  switch (event.type) {
    case 'stream_start':
      return [{ ...state, streamSid: event.streamSid, phase: 'LISTENING' }, []];

    case 'stream_stop': {
      const actions: Action[] =
        state.phase === 'RESPONDING' ? [{ type: 'reset_agent_turn' }] : [];
      return [state, actions];
    }

    case 'media':
      return [state, [{ type: 'feed_flux', audio: event.audio }]];

    case 'flux_end_of_turn':
      if (event.transcript && state.phase === 'LISTENING') {
        return [
          { ...state, phase: 'RESPONDING' },
          [{ type: 'start_agent_turn', transcript: event.transcript }],
        ];
      }
      return [state, []];

    case 'flux_start_of_turn':
      if (state.phase === 'RESPONDING') {
        return [{ ...state, phase: 'LISTENING' }, [{ type: 'reset_agent_turn' }]];
      }
      return [state, []];

    case 'agent_turn_done':
      if (state.phase === 'RESPONDING') {
        return [{ ...state, phase: 'LISTENING' }, []];
      }
      return [state, []];
  }

  return [state, []];
}
