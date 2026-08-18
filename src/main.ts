#!/usr/bin/env node
/**
 * voice-agent -- entry point (port of shuo's main.py).
 *
 * Usage:
 *     node src/main.ts                  # server-only mode (inbound calls)
 *     node src/main.ts +1234567890      # outbound call mode
 *
 * Server-only mode starts the server and waits for inbound calls.
 * Outbound mode additionally initiates a call to the specified number.
 */

import { getLogger, Logger } from './log.ts';
import { createServer, getActiveCalls, setDraining } from './server.ts';
import { makeOutboundCall } from './services/twilioClient.ts';
import { sleep } from './util.ts';

// Load environment variables from .env if present
try {
  process.loadEnvFile();
} catch {
  // no .env file -- rely on the process environment
}

const logger = getLogger('main');

// Note: the Python original required OPENAI_API_KEY here even though the
// conversation LLM is Groq. Fixed in this port: GROQ_API_KEY is required,
// OPENAI_API_KEY is optional (only the /bench/ttft endpoint uses it).
const REQUIRED_VARS = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER',
  'TWILIO_PUBLIC_URL',
  'DEEPGRAM_API_KEY',
  'GROQ_API_KEY',
  'ELEVENLABS_API_KEY',
];

/** Check that all required environment variables are set. */
function checkEnvironment(): boolean {
  const missing = REQUIRED_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    logger.error(`Missing environment variables: ${missing.join(', ')}`);
    return false;
  }
  return true;
}

// Max time (seconds) to wait for active calls to finish before forced exit.
const DRAIN_TIMEOUT_S = Number.parseInt(process.env.DRAIN_TIMEOUT ?? '300', 10);

async function main(): Promise<void> {
  let phoneNumber: string | null = null;

  if (process.argv.length >= 3) {
    phoneNumber = process.argv[2]!;
    if (!phoneNumber.startsWith('+')) {
      console.error('Error: Phone number must start with +');
      process.exit(1);
    }
  }

  // Check environment
  if (!checkEnvironment()) {
    process.exit(1);
  }

  const port = Number.parseInt(process.env.PORT ?? '3040', 10);
  const publicUrl = process.env.TWILIO_PUBLIC_URL ?? '';

  // Start server
  Logger.serverStarting(port);
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(port, '0.0.0.0', resolve));
  Logger.serverReady(publicUrl);

  const shutdown = (): void => {
    server.close();
    process.exit(0);
  };

  // -- Graceful shutdown on SIGTERM -----------------------------------------
  // Railway (and Docker) send SIGTERM before killing the container.
  // We stop accepting new calls and wait for active ones to finish.
  process.on('SIGTERM', () => {
    void (async () => {
      logger.info('SIGTERM received — starting graceful drain');
      setDraining();

      if (getActiveCalls() <= 0) {
        logger.info('No active calls — shutting down now');
        shutdown();
        return;
      }

      logger.info(
        `Waiting up to ${DRAIN_TIMEOUT_S}s for ${getActiveCalls()} active call(s) to finish...`,
      );

      const deadline = Date.now() + DRAIN_TIMEOUT_S * 1000;
      while (getActiveCalls() > 0 && Date.now() < deadline) {
        await sleep(1000);
      }

      const remaining = getActiveCalls();
      if (remaining > 0) {
        logger.warn(`Drain timeout — ${remaining} call(s) still active, forcing exit`);
      } else {
        logger.info('All calls drained — shutting down cleanly');
      }

      shutdown();
    })();
  });

  process.on('SIGINT', () => {
    Logger.shutdown();
    process.exit(0);
  });

  if (phoneNumber) {
    // Outbound call mode
    Logger.callInitiating(phoneNumber);
    try {
      const callSid = await makeOutboundCall(phoneNumber);
      Logger.callInitiated(callSid);
      logger.info('Waiting for call to connect... (Ctrl+C to end)');
    } catch (err) {
      logger.error(`Error: ${String(err)}`);
      process.exit(1);
    }
  } else {
    // Server-only mode -- wait for inbound calls
    logger.info('Server-only mode — waiting for inbound calls (Ctrl+C to end)');
  }

  // The listening HTTP server keeps the event loop alive from here.
}

void main();
