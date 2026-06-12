/**
 * Parsing Spotify links out of raw Slack message text.
 *
 * Slack wraps URLs as `<https://...|display text>` or just `<https://...>`, so we
 * must unwrap those first. We also tolerate locale prefixes (`/intl-de/`),
 * tracking params (`?si=...`), and the `spotify:track:...` URI form.
 */

export type SpotifyEntityType = 'track' | 'playlist' | 'album' | 'artist' | 'episode' | 'show';

export interface SpotifyRef {
  type: SpotifyEntityType;
  id: string;
  /** Canonical Spotify URI, e.g. spotify:track:abc123 — what the Web API expects. */
  uri: string;
}

const ID = '[A-Za-z0-9]+';

// Matches https://open.spotify.com/[intl-xx/]<type>/<id>[?...]
const URL_RE = new RegExp(
  `https?://open\\.spotify\\.com/(?:intl-[a-z]{2}/)?(track|playlist|album|artist|episode|show)/(${ID})`,
  'gi'
);

// Matches spotify:<type>:<id>
const URI_RE = new RegExp(`spotify:(track|playlist|album|artist|episode|show):(${ID})`, 'gi');

/**
 * Unwrap Slack's angle-bracket link markup so the URLs inside become plain text.
 * `<https://x|label>` -> `https://x`, `<https://x>` -> `https://x`.
 */
export function unwrapSlackLinks(text: string): string {
  return text.replace(/<([^<>|]+)(?:\|[^<>]*)?>/g, (_m, url) => ` ${url} `);
}

function toRef(type: string, id: string): SpotifyRef {
  const t = type.toLowerCase() as SpotifyEntityType;
  return { type: t, id, uri: `spotify:${t}:${id}` };
}

/** Extract every Spotify reference found in a block of (raw Slack) text. */
export function extractRefs(text: string): SpotifyRef[] {
  const unwrapped = unwrapSlackLinks(text);
  const refs: SpotifyRef[] = [];

  for (const m of unwrapped.matchAll(URL_RE)) refs.push(toRef(m[1], m[2]));
  for (const m of unwrapped.matchAll(URI_RE)) refs.push(toRef(m[1], m[2]));

  return refs;
}

/** First playlist reference in the text, if any. */
export function extractFirstPlaylist(text: string): SpotifyRef | undefined {
  return extractRefs(text).find(r => r.type === 'playlist');
}

/** All track references across several message bodies, de-duplicated by URI, order preserved. */
export function extractTrackUris(texts: string[]): string[] {
  const seen = new Set<string>();
  const uris: string[] = [];
  for (const text of texts) {
    for (const ref of extractRefs(text)) {
      if (ref.type !== 'track') continue;
      if (seen.has(ref.uri)) continue;
      seen.add(ref.uri);
      uris.push(ref.uri);
    }
  }
  return uris;
}

/** Non-track, non-playlist references (album/artist/etc) — used to warn the user. */
export function extractUnsupportedRefs(texts: string[]): SpotifyRef[] {
  const seen = new Set<string>();
  const out: SpotifyRef[] = [];
  for (const text of texts) {
    for (const ref of extractRefs(text)) {
      if (ref.type === 'track' || ref.type === 'playlist') continue;
      if (seen.has(ref.uri)) continue;
      seen.add(ref.uri);
      out.push(ref);
    }
  }
  return out;
}
