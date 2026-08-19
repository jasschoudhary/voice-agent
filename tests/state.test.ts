/**
 * Unit tests for the pure processEvent function.
 *
 * These tests verify the state machine
 * logic without any I/O. With Deepgram Flux handling turn detection, the
 * state machine is a simple conversation controller.
 *
 * Run with: node --test tests/
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { processEvent } from '../src/state.ts';
import type { AppState } from '../src/types.ts';
import { initialState } from '../src/types.ts';

// =============================================================================
// FIXTURES
// =============================================================================

/** State after stream has started. */
const listeningState: AppState = { phase: 'LISTENING', streamSid: 'test-stream-sid' };

/** State while agent is responding. */
const respondingState: AppState = { phase: 'RESPONDING', streamSid: 'test-stream-sid' };

// =============================================================================
// STREAM LIFECYCLE
// =============================================================================

describe('stream lifecycle', () => {
  it('stream_start sets the streamSid', () => {
    const [newState, actions] = processEvent(initialState, {
      type: 'stream_start',
      streamSid: 'new-stream-123',
    });

    assert.equal(newState.streamSid, 'new-stream-123');
    assert.equal(newState.phase, 'LISTENING');
    assert.deepEqual(actions, []);
  });

  it('stream_start resets to LISTENING even if RESPONDING', () => {
    const state: AppState = { phase: 'RESPONDING', streamSid: 'old' };
    const [newState] = processEvent(state, { type: 'stream_start', streamSid: 'new' });

    assert.equal(newState.phase, 'LISTENING');
    assert.equal(newState.streamSid, 'new');
  });

  it('stream_stop resets agent turn if responding', () => {
    const [, actions] = processEvent(respondingState, { type: 'stream_stop' });

    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.type, 'reset_agent_turn');
  });

  it('stream_stop produces no actions when listening', () => {
    const [, actions] = processEvent(listeningState, { type: 'stream_stop' });

    assert.deepEqual(actions, []);
  });
});

// =============================================================================
// MEDIA ROUTING
// =============================================================================

describe('media routing', () => {
  it('media always produces feed_flux', () => {
    const audio = Buffer.from([0x00, 0x01, 0x02]);
    const [, actions] = processEvent(listeningState, { type: 'media', audio });

    assert.equal(actions.length, 1);
    const action = actions[0]!;
    assert.equal(action.type, 'feed_flux');
    assert.ok(action.type === 'feed_flux' && action.audio.equals(audio));
  });

  it('media feeds Flux in any phase', () => {
    const [, actions] = processEvent(respondingState, {
      type: 'media',
      audio: Buffer.from([0xff]),
    });

    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.type, 'feed_flux');
  });

  it('media does not change application state', () => {
    const [newState] = processEvent(listeningState, {
      type: 'media',
      audio: Buffer.from([0x00]),
    });

    assert.deepEqual(newState, listeningState);
  });
});

// =============================================================================
// FLUX TURN EVENTS
// =============================================================================

describe('flux end of turn', () => {
  it('end of turn with transcript starts agent turn', () => {
    const [newState, actions] = processEvent(listeningState, {
      type: 'flux_end_of_turn',
      transcript: 'Hello, how are you?',
    });

    assert.equal(newState.phase, 'RESPONDING');
    assert.equal(actions.length, 1);
    const action = actions[0]!;
    assert.equal(action.type, 'start_agent_turn');
    assert.ok(action.type === 'start_agent_turn' && action.transcript === 'Hello, how are you?');
  });

  it('empty transcript is ignored', () => {
    const [newState, actions] = processEvent(listeningState, {
      type: 'flux_end_of_turn',
      transcript: '',
    });

    assert.equal(newState.phase, 'LISTENING');
    assert.deepEqual(actions, []);
  });

  it('end of turn is ignored if already responding', () => {
    const [newState, actions] = processEvent(respondingState, {
      type: 'flux_end_of_turn',
      transcript: 'Interrupt text',
    });

    assert.equal(newState.phase, 'RESPONDING'); // unchanged
    assert.deepEqual(actions, []);
  });
});

describe('flux start of turn', () => {
  it('start of turn during RESPONDING triggers barge-in', () => {
    const [newState, actions] = processEvent(respondingState, {
      type: 'flux_start_of_turn',
    });

    assert.equal(newState.phase, 'LISTENING');
    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.type, 'reset_agent_turn');
  });

  it('start of turn during LISTENING is a no-op', () => {
    const [newState, actions] = processEvent(listeningState, {
      type: 'flux_start_of_turn',
    });

    assert.equal(newState.phase, 'LISTENING');
    assert.deepEqual(actions, []);
  });
});

// =============================================================================
// AGENT TURN DONE
// =============================================================================

describe('agent turn done', () => {
  it('done transitions back to LISTENING', () => {
    const [newState, actions] = processEvent(respondingState, { type: 'agent_turn_done' });

    assert.equal(newState.phase, 'LISTENING');
    assert.deepEqual(actions, []);
  });

  it('done is ignored if already listening', () => {
    const [newState, actions] = processEvent(listeningState, { type: 'agent_turn_done' });

    assert.equal(newState.phase, 'LISTENING');
    assert.deepEqual(actions, []);
  });
});

// =============================================================================
// COMPLETE FLOW
// =============================================================================

describe('complete flow', () => {
  it('full conversation turn: EndOfTurn -> agent responds -> done', () => {
    let state = listeningState;

    // Flux detects end of user turn
    let actions;
    [state, actions] = processEvent(state, { type: 'flux_end_of_turn', transcript: 'Hello' });
    assert.equal(state.phase, 'RESPONDING');
    assert.ok(actions.some((a) => a.type === 'start_agent_turn'));

    // Agent finishes speaking
    [state, actions] = processEvent(state, { type: 'agent_turn_done' });
    assert.equal(state.phase, 'LISTENING');
    assert.deepEqual(actions, []);
  });

  it('barge-in: agent responding -> StartOfTurn -> reset', () => {
    let state = listeningState;

    // Start responding
    [state] = processEvent(state, { type: 'flux_end_of_turn', transcript: 'Hello' });
    assert.equal(state.phase, 'RESPONDING');

    // User interrupts
    let actions;
    [state, actions] = processEvent(state, { type: 'flux_start_of_turn' });
    assert.equal(state.phase, 'LISTENING');
    assert.ok(actions.some((a) => a.type === 'reset_agent_turn'));
  });

  it('multiple turns work correctly', () => {
    let state = listeningState;

    // Turn 1
    [state] = processEvent(state, { type: 'flux_end_of_turn', transcript: 'Hi' });
    assert.equal(state.phase, 'RESPONDING');
    [state] = processEvent(state, { type: 'agent_turn_done' });
    assert.equal(state.phase, 'LISTENING');

    // Turn 2
    [state] = processEvent(state, { type: 'flux_end_of_turn', transcript: 'How are you?' });
    assert.equal(state.phase, 'RESPONDING');
    [state] = processEvent(state, { type: 'agent_turn_done' });
    assert.equal(state.phase, 'LISTENING');
  });

  it('audio is always forwarded to Flux', () => {
    // While listening
    let [, actions] = processEvent(listeningState, {
      type: 'media',
      audio: Buffer.from([0x00]),
    });
    assert.equal(actions[0]!.type, 'feed_flux');

    // While responding
    const responding: AppState = { ...listeningState, phase: 'RESPONDING' };
    [, actions] = processEvent(responding, { type: 'media', audio: Buffer.from([0x00]) });
    assert.equal(actions[0]!.type, 'feed_flux');
  });

  it('after barge-in, a new turn can start', () => {
    let state = listeningState;

    // Start turn
    [state] = processEvent(state, { type: 'flux_end_of_turn', transcript: 'Hello' });
    assert.equal(state.phase, 'RESPONDING');

    // Interrupt
    let actions;
    [state, actions] = processEvent(state, { type: 'flux_start_of_turn' });
    assert.equal(state.phase, 'LISTENING');
    assert.ok(actions.some((a) => a.type === 'reset_agent_turn'));

    // New turn after interrupt
    [state, actions] = processEvent(state, {
      type: 'flux_end_of_turn',
      transcript: 'Never mind, goodbye',
    });
    assert.equal(state.phase, 'RESPONDING');
    const action = actions[0]!;
    assert.equal(action.type, 'start_agent_turn');
    assert.ok(action.type === 'start_agent_turn' && action.transcript === 'Never mind, goodbye');
  });
});

// =============================================================================
// EDGE CASES
// =============================================================================

describe('edge cases', () => {
  it('state updates do not mutate the original', () => {
    const [newState] = processEvent(initialState, {
      type: 'stream_start',
      streamSid: 'new-sid',
    });

    assert.equal(initialState.streamSid, null);
    assert.equal(newState.streamSid, 'new-sid');
  });

  it('stream_stop in LISTENING is safe', () => {
    const [, actions] = processEvent(listeningState, { type: 'stream_stop' });
    assert.deepEqual(actions, []);
  });

  it('agent_turn_done in wrong phase is safe', () => {
    const [newState, actions] = processEvent(listeningState, { type: 'agent_turn_done' });
    assert.equal(newState.phase, 'LISTENING');
    assert.deepEqual(actions, []);
  });

  it('flux_start_of_turn in LISTENING is normal (user talking)', () => {
    const [newState, actions] = processEvent(listeningState, { type: 'flux_start_of_turn' });
    assert.equal(newState.phase, 'LISTENING');
    assert.deepEqual(actions, []);
  });

  it('end of turn before stream starts still works', () => {
    const [newState, actions] = processEvent(initialState, {
      type: 'flux_end_of_turn',
      transcript: 'test',
    });
    assert.equal(newState.phase, 'RESPONDING');
    assert.equal(actions.length, 1);
  });
});
