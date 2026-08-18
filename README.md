# voice-agent

A voice agent framework in ~700 lines of TypeScript.

```bash
npm start -- +1234567890
```

```
🚀 Server starting on port 3040
✓  Ready https://brew.sentinal.ngrok-free.app
📞 Calling +1234567890...
✓  Call initiated SID: CA094f2e...
🔌 WebSocket connected
▶  Stream started SID: MZ8a3b1f...
← Flux EndOfTurn "Hey, how's it going?"
◆ LISTENING → RESPONDING
→ Start Agent "Hey, how's it going?"
← Agent turn done
◆ RESPONDING → LISTENING
```

## How it works

Two abstractions, one pure function:

- **Deepgram Flux** — always-on STT + turn detection over a single WebSocket
- **Agent** — self-contained LLM → TTS → Player pipeline, owns conversation history
- **`processEvent(state, event) → [state, actions]`** — the entire state machine in ~30 lines

Everything streams. LLM tokens feed TTS immediately, TTS audio feeds Twilio immediately. If you interrupt (barge-in), the agent cancels everything and clears the audio buffer instantly.

```
LISTENING ──EndOfTurn──→ RESPONDING ──Done──→ LISTENING
    ↑                        │
    └────StartOfTurn─────────┘  (barge-in)
```

All events (Twilio audio frames, Flux turn events, agent-done) funnel into one
`AsyncQueue` consumed by a single loop, so every state machine decision is
serialized — no races by construction:

```ts
while (connected) {
  const event = await queue.get();                      // I/O in
  const [state, actions] = processEvent(state, event);  // PURE decision
  for (const action of actions) dispatch(action);       // I/O out
}
```

## Project structure

```
src/
  types.ts              # Immutable state, events, actions (discriminated unions)
  state.ts              # Pure state machine (~30 lines)
  conversation.ts       # Main event loop
  agent.ts              # LLM → TTS → Player pipeline
  log.ts                # Colored logging
  server.ts             # Express endpoints + WebSocket
  bench.ts              # /bench/ttft endpoint
  tracer.ts             # Per-turn latency spans (saved to ./traces)
  main.ts               # Entry point
  util.ts               # AsyncQueue, sleep, waitForOpen
  services/
    flux.ts             # Deepgram Flux (STT + turns, raw WebSocket)
    llm.ts              # Groq llama-3.3-70b streaming (OpenAI-compatible)
    tts.ts              # ElevenLabs WebSocket streaming
    ttsPool.ts          # TTS connection pool (warm spares)
    player.ts           # Audio playback to Twilio
    twilioClient.ts     # Outbound calls + message parsing
tests/
  state.test.ts         # Pure state machine tests (no I/O, no mocks)
```

## Setup

Requires **Node 22.18+** (runs TypeScript directly via type stripping — no build
step), [ngrok](https://ngrok.com/), and API keys for Twilio, Deepgram, Groq, and
ElevenLabs.

```bash
npm install
copy .env.example .env   # fill in your keys   (cp on macOS/Linux)
ngrok http 3040          # in another terminal
```

Put the ngrok `https://...` URL into `TWILIO_PUBLIC_URL` in `.env`, then:

```bash
npm start -- +1234567890     # outbound: calls you
npm start                    # server-only: waits for inbound calls
```

For inbound calls, set your Twilio number's "A call comes in" webhook to
`{TWILIO_PUBLIC_URL}/twiml`.

### Endpoints

| Route | Purpose |
|---|---|
| `GET /health` | Health check |
| `GET/POST /twiml` | TwiML that tells Twilio to open the media WebSocket |
| `WS /ws` | Twilio media stream |
| `GET /call/+15551234567` | Trigger an outbound call |
| `GET /trace/latest` | Most recent call's latency trace (JSON) |
| `GET /bench/ttft?models=...&runs=5` | TTFT benchmark across models |

## Tests

```bash
npm test           # pure state machine tests, no network
npm run typecheck  # tsc --noEmit
```

## Differences from the Python original

Deliberate, all documented in code:

- **`GROQ_API_KEY` is required, `OPENAI_API_KEY` is optional.** The Python
  original required `OPENAI_API_KEY` at startup but the conversation LLM is
  Groq; only `/bench/ttft` uses OpenAI. This port checks for what it uses.
- **Endpoints are configurable instead of pinned to Europe.** The Python code
  hardcoded Deepgram's EU endpoint and Twilio's Frankfurt edge. Here the
  defaults are Deepgram US and Twilio auto-routing; set `DEEPGRAM_BASE_URL`
  and `TWILIO_EDGE` (e.g. `singapore`) to tune for your region.
- **Traces go to `./traces`** instead of `tmp` (works on Windows).
  Override with `TRACE_DIR`.
- **No SDKs for Deepgram/ElevenLabs** — both protocols are plain JSON over a
  WebSocket, so the port talks to them with `ws` directly.
- **Cancellation** uses `AbortController` + cooperative flags instead of
  Python's `task.cancel()`, since JS tasks can't be force-cancelled.


## Possible improvements

- Use Twilio [`mark` messages](https://www.twilio.com/docs/voice/media-streams)
  instead of paced sending to get an exact playback-done signal.
- Flux is English-only (`flux-general-en`).
