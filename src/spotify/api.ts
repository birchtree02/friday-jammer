import { SpotifyConfig } from '../config';
import { getAccessToken } from './auth';

/**
 * Thin Spotify Web API client covering exactly what the bot needs:
 *   - fetch a playlist's metadata (to check `collaborative`)
 *   - list a playlist's existing track URIs (so we don't re-add)
 *   - check / establish "following" (collaborator membership) of a playlist
 *   - add tracks in batches of 100
 *
 * All calls go through `request()`, which injects the bearer token and retries
 * on HTTP 429 honoring the Retry-After header.
 */

const API_BASE = 'https://api.spotify.com/v1';
const MAX_RETRIES = 5;

export interface PlaylistMeta {
  id: string;
  name: string;
  collaborative: boolean;
  ownerId: string;
  ownerName: string;
  externalUrl?: string;
}

async function request(
  cfg: SpotifyConfig,
  method: string,
  path: string,
  body?: unknown,
  attempt = 0
): Promise<Response> {
  const token = await getAccessToken(cfg);
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 429 && attempt < MAX_RETRIES) {
    const retryAfter = parseInt(res.headers.get('Retry-After') || '1', 10);
    await new Promise(r => setTimeout(r, (isNaN(retryAfter) ? 1 : retryAfter) * 1000 + 250));
    return request(cfg, method, path, body, attempt + 1);
  }

  return res;
}

async function requestJson<T>(cfg: SpotifyConfig, method: string, path: string, body?: unknown): Promise<T> {
  const res = await request(cfg, method, path, body);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new SpotifyApiError(res.status, `${method} ${path} -> ${res.status}: ${detail}`);
  }
  // Some endpoints (e.g. PUT followers) return empty bodies.
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export class SpotifyApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'SpotifyApiError';
  }
}

/** The bot account's own Spotify user id. */
export async function getMe(cfg: SpotifyConfig): Promise<{ id: string; displayName: string }> {
  const me = await requestJson<{ id: string; display_name?: string }>(cfg, 'GET', '/me');
  return { id: me.id, displayName: me.display_name || me.id };
}

export async function getPlaylist(cfg: SpotifyConfig, playlistId: string): Promise<PlaylistMeta> {
  const p = await requestJson<any>(
    cfg,
    'GET',
    `/playlists/${playlistId}?fields=id,name,collaborative,external_urls,owner(id,display_name)`
  );
  return {
    id: p.id,
    name: p.name,
    collaborative: !!p.collaborative,
    ownerId: p.owner?.id ?? '',
    ownerName: p.owner?.display_name || p.owner?.id || 'unknown',
    externalUrl: p.external_urls?.spotify,
  };
}

/** All track URIs already in the playlist (paginated, 100 per page). */
export async function getPlaylistTrackUris(cfg: SpotifyConfig, playlistId: string): Promise<Set<string>> {
  const uris = new Set<string>();
  let url: string | null = `/playlists/${playlistId}/tracks?fields=items(track(uri)),next&limit=100`;

  while (url) {
    const page: any = await requestJson<any>(cfg, 'GET', url);
    for (const item of page.items || []) {
      const uri = item?.track?.uri;
      if (uri) uris.add(uri);
    }
    // `next` is an absolute URL; strip the base so request() can re-add it.
    url = page.next ? page.next.replace(API_BASE, '') : null;
  }
  return uris;
}

/** Is the bot account currently following (a member/collaborator of) the playlist? */
export async function isFollowingPlaylist(cfg: SpotifyConfig, playlistId: string, userId: string): Promise<boolean> {
  const res = await requestJson<boolean[]>(
    cfg,
    'GET',
    `/playlists/${playlistId}/followers/contains?ids=${encodeURIComponent(userId)}`
  );
  return Array.isArray(res) ? !!res[0] : false;
}

/** Follow (save to library) the playlist. Required to edit a collaborative playlist. */
export async function followPlaylist(cfg: SpotifyConfig, playlistId: string): Promise<void> {
  await requestJson<void>(cfg, 'PUT', `/playlists/${playlistId}/followers`, { public: false });
}

/**
 * Add the given track URIs to the playlist in batches of 100 (API limit).
 * Returns the number of URIs submitted.
 */
export async function addTracks(cfg: SpotifyConfig, playlistId: string, uris: string[]): Promise<number> {
  for (let i = 0; i < uris.length; i += 100) {
    const batch = uris.slice(i, i + 100);
    await requestJson<void>(cfg, 'POST', `/playlists/${playlistId}/tracks`, { uris: batch });
  }
  return uris.length;
}
