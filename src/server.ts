/**
 * HTTP + WebSocket server.
 *
 * Endpoints:
 * - GET  /health        - Health check
 * - GET/POST /twiml     - Returns TwiML for Twilio to connect WebSocket
 * - WS   /ws            - Media stream endpoint
 * - GET  /trace/latest  - Returns the most recent call trace as JSON
 * - GET  /call/:number  - Initiate an outbound call
 * - GET  /bench/ttft    - Benchmark TTFT across OpenAI-compatible models
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import express from 'express';
import type { Request, Response } from 'express';
import { WebSocketServer } from 'ws';

import { mountBench } from './bench.ts';
import { runConversationOverTwilio } from './conversation.ts';
import { getLogger } from './log.ts';
import { makeOutboundCall } from './services/twilioClient.ts';
import { TRACE_DIR } from './tracer.ts';

const logger = getLogger('server');

// -- Graceful shutdown / connection draining ---------------------------------
let draining = false; // Set true on SIGTERM -- reject new calls
let activeCalls = 0;  // Count of live WebSocket conversations

export function setDraining(): void {
  draining = true;
}

export function getActiveCalls(): number {
  return activeCalls;
}

export const app = express();

/** Health check endpoint. */
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

/**
 * Return TwiML instructing Twilio to connect a WebSocket stream.
 *
 * Twilio calls this URL when the call is answered.
 * During graceful shutdown, rejects new calls so they don't get cut off.
 */
const twimlHandler = (_req: Request, res: Response): void => {
  if (draining) {
    // Reject new calls during shutdown -- Twilio will play a message and hang up
    logger.info('Draining — rejecting new inbound call');
    res.type('application/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say>Sorry, we are updating. Please call back in a moment.</Say>
    <Hangup/>
</Response>`,
    );
    return;
  }

  const publicUrl = process.env.TWILIO_PUBLIC_URL ?? '';
  const wsUrl =
    publicUrl.replace('https://', 'wss://').replace('http://', 'ws://') + '/ws';

  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect record="record-from-answer-dual">
        <Stream url="${wsUrl}" track="inbound_track" />
    </Connect>
</Response>`,
  );
};
app.get('/twiml', twimlHandler);
app.post('/twiml', twimlHandler);

/** Return the most recent call trace as JSON. */
app.get('/trace/latest', (_req: Request, res: Response) => {
  if (!fs.existsSync(TRACE_DIR)) {
    res.status(404).json({ error: 'No traces found' });
    return;
  }

  const traces = fs
    .readdirSync(TRACE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(TRACE_DIR, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  if (traces.length === 0) {
    res.status(404).json({ error: 'No traces found' });
    return;
  }

  res.type('application/json').send(fs.readFileSync(traces[0]!, 'utf8'));
});

/**
 * Initiate an outbound call.
 *
 * Usage:
 *     curl https://your-server/call/+1234567890
 */
app.get('/call/:phoneNumber', async (req: Request, res: Response) => {
  let phoneNumber = String(req.params.phoneNumber ?? '');
  if (!phoneNumber.startsWith('+')) {
    phoneNumber = `+${phoneNumber}`;
  }
  try {
    const callSid = await makeOutboundCall(phoneNumber);
    res.json({ status: 'calling', to: phoneNumber, call_sid: callSid });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

mountBench(app);

/**
 * Create the HTTP server with the WebSocket endpoint attached.
 *
 * /ws handles the bidirectional audio stream for a single call and
 * tracks active connections for graceful shutdown draining.
 */
export function createServer(): http.Server {
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    activeCalls += 1;
    logger.info(`Call connected  (active: ${activeCalls})`);

    void runConversationOverTwilio(ws)
      .catch((err) => logger.error(`WebSocket error: ${String(err)}`))
      .finally(() => {
        try {
          ws.close();
        } catch {
          // already closed
        }
        activeCalls -= 1;
        logger.info(`Call ended  (active: ${activeCalls})`);
      });
  });

  return server;
}
