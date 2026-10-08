import { WebClient } from '@slack/web-api';
import { loadConfig, Config } from '../config';
import { runJam, JamRequest } from '../handler';
import { fetchThread } from '../slack/thread';
import { loadSecrets } from './secrets';
import type { WorkerJob } from './types';

/**
 * Private worker (no Function URL; only the ingress function may invoke it).
 *
 * Receives a job from the ingress function, reads the Slack thread, runs the
 * existing playlist logic (runJam) and posts the result back to Slack.
 */

let config: Config | undefined;
let slack: WebClient | undefined;

async function init(): Promise<{ config: Config; slack: WebClient }> {
  if (!config || !slack) {
    await loadSecrets();
    config = loadConfig({ requireSpotifyRefresh: true });
    slack = new WebClient(config.slack.botToken);
  }
  return { config, slack };
}

export async function handler(job: WorkerJob): Promise<void> {
  const { config, slack } = await init();

  let reply: string;
  try {
    let req: JamRequest;
    if (job.threadTs) {
      const { rootText, threadTexts } = await fetchThread(slack, job.channel, job.threadTs);
      req = { triggerText: job.triggerText, rootText, threadTexts };
    } else {
      // Slash command outside a thread: only the links typed into the command.
      req = { triggerText: job.triggerText, rootText: job.triggerText, threadTexts: [job.triggerText] };
    }
    reply = await runJam(config, req);
  } catch (err: any) {
    console.error(`[worker] ${job.kind} failed:`, err);
    reply = `:warning: Error: ${err?.message || 'unknown error'}`;
  }

  if (job.kind === 'mention') {
    await slack.chat.postMessage({ channel: job.channel, thread_ts: job.threadTs, text: reply });
  } else {
    await postToResponseUrl(job.responseUrl, reply);
  }
}

async function postToResponseUrl(url: string, text: string): Promise<void> {
  // Only ever post back to Slack's own hooks endpoint.
  if (!url.startsWith('https://hooks.slack.com/')) {
    console.error('[worker] refusing to post to unexpected response_url');
    return;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response_type: 'ephemeral', replace_original: true, text }),
  });
  if (!res.ok) console.error(`[worker] response_url POST failed (${res.status})`);
}
