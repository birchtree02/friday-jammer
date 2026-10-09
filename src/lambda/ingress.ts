import * as crypto from 'crypto';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { loadSecrets } from './secrets';
import type { WorkerJob } from './types';

/**
 * Public entry point (Lambda Function URL) for Slack's HTTP-mode requests.
 *
 * Its only jobs are to prove the request came from Slack, acknowledge within
 * Slack's 3-second limit, and hand the work to the private worker function via
 * an async invoke. It never holds the Slack bot token or Spotify credentials.
 *
 * Lambda freezes as soon as the handler returns, so the slow part (reading the
 * thread, calling Spotify) can't run "after the ack" here — hence the worker.
 */

const SLASH_COMMAND = '/friday-jammer';
const MAX_SKEW_SECONDS = 60 * 5;

/** The subset of the Function URL (payload v2.0) event we use. */
interface FunctionUrlEvent {
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}

interface FunctionUrlResult {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

const lambda = new LambdaClient({});

export async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  await loadSecrets();

  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const workerFn = process.env.WORKER_FN;
  if (!signingSecret || !workerFn) {
    console.error('[ingress] missing SLACK_SIGNING_SECRET or WORKER_FN');
    return text(500, 'Server misconfigured');
  }

  const headers = lowerKeys(event.headers || {});
  const rawBody = event.body
    ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body)
    : '';

  if (!isValidSlackSignature(signingSecret, headers, rawBody)) {
    return text(401, 'Invalid signature');
  }

  // Slack retries events it thinks timed out. The work was already queued on
  // the first delivery, so swallow retries rather than processing twice.
  if (headers['x-slack-retry-num']) {
    return { statusCode: 200, headers: { 'x-slack-no-retry': '1' }, body: '' };
  }

  const contentType = headers['content-type'] || '';
  if (contentType.includes('application/json')) {
    return handleEvent(JSON.parse(rawBody), workerFn);
  }
  return handleCommand(new URLSearchParams(rawBody), workerFn);
}

// --- Events API (app_mention, url_verification) ---

async function handleEvent(payload: any, workerFn: string): Promise<FunctionUrlResult> {
  if (payload.type === 'url_verification') {
    return json(200, { challenge: payload.challenge });
  }

  const ev = payload.event;
  if (payload.type !== 'event_callback' || ev?.type !== 'app_mention') {
    return text(200, '');
  }
  if (!channelAllowed(ev.channel)) return text(200, '');
  // In Slack Connect channels, people from other organisations can @mention the
  // bot and Slack signs those events like any other. Only act for our own users.
  const userTeam = ev.user_team || ev.team;
  if (userTeam && userTeam !== payload.team_id) return text(200, '');

  const job: WorkerJob = {
    kind: 'mention',
    channel: ev.channel,
    threadTs: ev.thread_ts || ev.ts,
    triggerText: String(ev.text || '').replace(/<@[^>]+>\s*/, '').trim(),
  };
  await invokeWorker(workerFn, job);
  return text(200, '');
}

// --- Slash command (/friday-jammer) ---

async function handleCommand(form: URLSearchParams, workerFn: string): Promise<FunctionUrlResult> {
  if (form.get('command') !== SLASH_COMMAND) return text(200, '');

  const channel = form.get('channel_id') || '';
  if (!channelAllowed(channel)) {
    return ephemeral("This command isn't enabled in this channel.");
  }

  const triggerText = (form.get('text') || '').trim();
  const threadTs = form.get('thread_ts') || undefined;

  if (!threadTs && !triggerText) {
    return ephemeral(
      "Run me inside a thread (or `@friday-jammer` in the thread) so I can see the shared links, " +
      'or pass links directly: `/friday-jammer <playlist-link>`.'
    );
  }

  const job: WorkerJob = {
    kind: 'command',
    channel,
    threadTs,
    triggerText,
    responseUrl: form.get('response_url') || '',
  };
  await invokeWorker(workerFn, job);
  return ephemeral(':hourglass_flowing_sand: On it…');
}

// --- Helpers ---

/**
 * Verify Slack's v0 request signature: HMAC-SHA256 of `v0:<timestamp>:<body>`
 * with the signing secret, compared in constant time. Requests older than five
 * minutes are rejected to stop replays.
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */
export function isValidSlackSignature(
  signingSecret: string,
  headers: Record<string, string | undefined>,
  rawBody: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): boolean {
  const timestamp = headers['x-slack-request-timestamp'];
  const signature = headers['x-slack-signature'];
  if (!timestamp || !signature) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > MAX_SKEW_SECONDS) return false;

  const expected = 'v0=' + crypto
    .createHmac('sha256', signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest('hex');

  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Fails closed: unlike local Socket Mode, an unset or empty allowlist here
 * means no channel is allowed, so a missing allowed_channels can't open the bot
 * up to the whole workspace.
 */
function channelAllowed(channelId: string): boolean {
  const allow = (process.env.FRIDAY_JAMMER_CHANNELS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (allow.length === 0) console.error('[ingress] allowed_channels is empty; ignoring request');
  return allow.includes(channelId);
}

async function invokeWorker(workerFn: string, job: WorkerJob): Promise<void> {
  await lambda.send(new InvokeCommand({
    FunctionName: workerFn,
    InvocationType: 'Event', // async: returns as soon as the job is queued
    Payload: Buffer.from(JSON.stringify(job)),
  }));
}

function lowerKeys(h: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

function text(statusCode: number, body: string): FunctionUrlResult {
  return { statusCode, headers: { 'content-type': 'text/plain' }, body };
}

function json(statusCode: number, body: unknown): FunctionUrlResult {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function ephemeral(message: string): FunctionUrlResult {
  return json(200, { response_type: 'ephemeral', text: message });
}
