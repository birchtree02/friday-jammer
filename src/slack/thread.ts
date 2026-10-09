import type { WebClient } from '@slack/web-api';

/**
 * Fetch every message in a thread, returning their raw texts plus the root text.
 * Uses conversations.replies to pull the full thread history.
 *
 * Shared by the local Socket Mode entry point (index.ts) and the AWS Lambda
 * worker (lambda/worker.ts).
 */
export async function fetchThread(
  client: WebClient,
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
