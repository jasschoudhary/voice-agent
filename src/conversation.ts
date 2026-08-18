/**
 * The main event loop.
 *
 * This is the explicit, readable loop that drives the entire system:
 *
 *     while (connected) {
 *       const event = await queue.get()                     // I/O (from queue)
 *       const [state, actions] = processEvent(state, event) // PURE
 *       for (const action of actions) dispatch(action)      // I/O
 *     }
 *
 * Events come from:
 * - Twilio WebSocket (audio packets)
 * - Deepgram Flux (turn events)
 * - Agent (playback complete)
 */

import type WebSocket from 'ws';
import type { RawData } from 'ws';

import { Agent } from './agent.ts';
import { Logger } from './log.ts';
import { FluxService } from './services/flux.ts';
import { TTSPool } from './services/ttsPool.ts';
import { parseTwilioMessage } from './services/twilioClient.ts';
import { processEvent } from './state.ts';
import { Tracer } from './tracer.ts';
import { initialState, type AppState, type Event } from './types.ts';
import { AsyncQueue } from './util.ts';

/**
 * Main event loop for a single call.
 *
 * 1. Create shared event queue
 * 2. Create Flux service (always-on STT + turn detection)
 * 3. Wire Twilio socket messages into the queue
 * 4. On stream start, create Agent
 * 5. Process events through pure state machine
 * 6. Dispatch actions inline
 */
export async function runConversationOverTwilio(websocket: WebSocket): Promise<void> {
  const eventLog = new Logger(false);
  const queue = new AsyncQueue<Event>();
  const tracer = new Tracer();

  let agent: Agent | null = null;
  const ttsPool = new TTSPool(1, 8000);
  let streamSid: string | null = null;

  // -- Flux callbacks (push events to queue) --------------------------------

  const flux = new FluxService(
    (transcript) => queue.put({ type: 'flux_end_of_turn', transcript }),
    () => queue.put({ type: 'flux_start_of_turn' }),
  );

  // -- Twilio WebSocket reader (push events to queue) ------------------------

  websocket.on('message', (raw: RawData) => {
    try {
      const data = JSON.parse(raw.toString());
      const event = parseTwilioMessage(data);
      if (event) queue.put(event);
    } catch (err) {
      eventLog.error('Twilio reader', err);
      queue.put({ type: 'stream_stop' });
    }
  });
  websocket.on('close', () => queue.put({ type: 'stream_stop' }));
  websocket.on('error', (err) => {
    eventLog.error('Twilio socket', err);
    queue.put({ type: 'stream_stop' });
  });

  // -- Initialize -------------------------------------------------------------

  let state: AppState = initialState;

  try {
    while (true) {
      // --- RECEIVE ----------------------------------------------------------
      const event = await queue.get();

      eventLog.event(event);

      // Initialize services on stream start
      if (event.type === 'stream_start') {
        streamSid = event.streamSid;
        await flux.start();
        ttsPool.start();
        agent = new Agent(
          websocket,
          event.streamSid,
          () => queue.put({ type: 'agent_turn_done' }),
          ttsPool,
          tracer,
        );
      }

      // --- UPDATE (pure) ------------------------------------------------------
      const oldPhase = state.phase;
      const [nextState, actions] = processEvent(state, event);
      state = nextState;
      eventLog.transition(oldPhase, state.phase);

      // --- DISPATCH (side effects) --------------------------------------------
      for (const action of actions) {
        eventLog.action(action);
        switch (action.type) {
          case 'feed_flux':
            flux.send(action.audio);
            break;

          case 'start_agent_turn':
            if (agent) await agent.startTurn(action.transcript);
            break;

          case 'reset_agent_turn':
            if (agent) await agent.cancelTurn();
            break;
        }
      }

      // --- EXIT CHECK ---------------------------------------------------------
      if (event.type === 'stream_stop') break;
    }
  } catch (err) {
    eventLog.error('Call loop', err);
    throw err;
  } finally {
    if (agent) await agent.cleanup();

    await ttsPool.stop();
    flux.stop();

    // Save trace
    tracer.save(streamSid ?? 'unknown');

    Logger.websocketDisconnected();
  }
}
