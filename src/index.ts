import { App } from '@slack/bolt';
import { loadConfig } from './config';
import { runJam, JamRequest } from './handler';

/**
 * friday-jammer — a Slack bot (Socket Mode, runs locally) that adds the Spotify
 * track links shared in a thread to a collaborative playlist.
 *
 * Triggers:
 *   • /friday-jammer [playlist-link]      slash command (private response)
 *   • @friday-jammer [playlist-link]      mention in a thread (public reply)
 *
 * If no playlist link is supplied, the bot looks for one in the message that
 * started the thread. It only ever adds to *collaborative* playlists.
 *
 * The Slack integration uses Socket Mode with env-or-file config and a
 * retry-on-start loop.
 */

const config = loadConfig({ requireSpotifyRefresh: true });

const app = new App({
  token: config.slack.botToken,
  appToken: config.slack.appToken,
  socketMode: true,
});

function channelAllowed(channelId: string): boolean {
  const allow = config.slack.allowedChannels;
  return allow.length === 0 || allow.includes(channelId);
}

/**
 * Fetch every message in a thread, returning their raw texts plus the root text.
 * Uses conversations.replies to pull the full thread history.
 */
async function fetchThread(
  client: any,
  channel: string,
  threadTs: string
): Promise<{ rootText: string; threadTexts: string[] }> {
  const texts: string[] = [];
  let cursor: string | undefined;
  let rootText = '';

  do {
    const res: any = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 200,
      cursor,
    });
    for (const m of res.messages || []) {
      const text = m.text || '';
      texts.push(text);
      if (m.ts === threadTs) rootText = text;
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return { rootText, threadTexts: texts };
}

// --- Slash command: /friday-jammer [playlist-link] ---

app.command('/friday-jammer', async ({ command, ack, respond, client }) => {
  await ack();

  if (!channelAllowed(command.channel_id)) {
    return respond("This command isn't enabled in this channel.");
  }

  const triggerText = (command.text || '').trim();
  // Slash commands don't reliably carry thread context. Use thread_ts if present,
  // otherwise operate on the channel-level "thread" rooted at the command (no replies).
  const threadTs = (command as any).thread_ts as string | undefined;

  try {
    let req: JamRequest;
    if (threadTs) {
      const { rootText, threadTexts } = await fetchThread(client, command.channel_id, threadTs);
      req = { triggerText, rootText, threadTexts };
    } else {
      // No thread — can only act on links the user typed into the command itself.
      req = { triggerText, rootText: triggerText, threadTexts: [triggerText] };
    }

    if (!threadTs && !triggerText) {
      return respond(
        "Run me inside a thread (or `@friday-jammer` in the thread) so I can see the shared links, " +
        "or pass links directly: `/friday-jammer <playlist-link>`."
      );
    }

    const result = await runJam(config, req);
    await respond(result);
  } catch (err: any) {
    console.error('[error] command handler:', err);
    await respond(`:warning: Error: ${err?.message || 'unknown error'}`);
  }
});

// --- Mention: @friday-jammer [playlist-link] (primary thread trigger) ---

app.event('app_mention', async ({ event, say, client }) => {
  if (!channelAllowed(event.channel)) return;

  const threadTs = event.thread_ts || event.ts;
  const triggerText = (event.text || '').replace(/<@[^>]+>\s*/, '').trim();

  try {
    const { rootText, threadTexts } = await fetchThread(client, event.channel, threadTs);
    const req: JamRequest = { triggerText, rootText, threadTexts };
    const result = await runJam(config, req);
    await say({ text: result, thread_ts: threadTs });
  } catch (err: any) {
    console.error('[error] mention handler:', err);
    await say({ text: `:warning: Error: ${err?.message || 'unknown error'}`, thread_ts: threadTs });
  }
});

// --- Startup (retry loop) ---

process.on('uncaughtException', (err) => {
  console.error(`[error] uncaught exception (will continue): ${err.message}`);
});

(async () => {
  while (true) {
    try {
      await app.start();
      const chans = config.slack.allowedChannels.length
        ? config.slack.allowedChannels.join(', ')
        : 'all channels';
      console.log(`⚡ friday-jammer connected (channels: ${chans})`);
      break;
    } catch (err: any) {
      console.error(`[error] failed to start, retrying in 5s: ${err.message}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
})();
