/**
 * Twilio service -- outbound calls and WebSocket message parsing.
 */

import twilio from 'twilio';

import { Logger } from '../log.ts';
import type { Event } from '../types.ts';

/**
 * Initiate an outbound call using Twilio.
 *
 * @param toNumber Phone number to call in E.164 format (+1234567890)
 * @returns Call SID
 */
export async function makeOutboundCall(toNumber: string): Promise<string> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;
  const publicUrl = process.env.TWILIO_PUBLIC_URL;

  if (!accountSid || !authToken || !fromNumber || !publicUrl) {
    throw new Error('Missing required Twilio environment variables');
  }

  // Optionally pin a Twilio edge close to this server (e.g. "singapore",
  // "frankfurt"). The Python original hardcoded frankfurt.
  const edge = process.env.TWILIO_EDGE;
  const client = edge
    ? twilio(accountSid, authToken, { edge })
    : twilio(accountSid, authToken);

  const call = await client.calls.create({
    to: toNumber,
    from: fromNumber,
    url: `${publicUrl}/twiml`,
    record: true,
  });

  return call.sid;
}

/** Shape of the JSON frames Twilio sends over the media stream WebSocket. */
interface TwilioStreamMessage {
  event?: string;
  start?: { streamSid?: string };
  media?: { payload?: string };
}

/** Parse raw Twilio WebSocket message into typed Event. */
export function parseTwilioMessage(data: TwilioStreamMessage): Event | null {
  switch (data.event) {
    case 'connected':
      Logger.websocketConnected();
      return null;

    case 'start': {
      const streamSid = data.start?.streamSid;
      return streamSid ? { type: 'stream_start', streamSid } : null;
    }

    case 'media': {
      const payload = data.media?.payload;
      return payload ? { type: 'media', audio: Buffer.from(payload, 'base64') } : null;
    }

    case 'stop':
      return { type: 'stream_stop' };

    default:
      return null;
  }
}
