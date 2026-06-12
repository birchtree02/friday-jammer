import { SpotifyConfig } from '../config';

/**
 * Exchange the long-lived refresh token for a short-lived access token, caching
 * it until shortly before expiry. The bot runs as a single Spotify identity, so
 * one cached token is shared across all requests.
 */

const TOKEN_URL = 'https://accounts.spotify.com/api/token';

let cachedToken: string | undefined;
let cachedExpiry = 0; // epoch ms

function basicAuth(cfg: SpotifyConfig): string {
  return Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
}

export async function getAccessToken(cfg: SpotifyConfig): Promise<string> {
  if (!cfg.refreshToken) {
    throw new Error('No Spotify refresh token configured. Run `npm run authorize` first.');
  }
  // Reuse cached token while it has >60s of life left.
  if (cachedToken && Date.now() < cachedExpiry - 60_000) return cachedToken;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: cfg.refreshToken,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth(cfg)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Spotify token refresh failed (${res.status}): ${detail}`);
  }

  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = json.access_token;
  cachedExpiry = Date.now() + json.expires_in * 1000;
  return cachedToken;
}

/** Exchange an authorization code for tokens — used only by the one-time authorize flow. */
export async function exchangeCodeForTokens(
  cfg: SpotifyConfig,
  code: string
): Promise<{ accessToken: string; refreshToken: string }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth(cfg)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Spotify code exchange failed (${res.status}): ${detail}`);
  }

  const json = (await res.json()) as { access_token: string; refresh_token: string };
  if (!json.refresh_token) {
    throw new Error('Spotify did not return a refresh token. Ensure the authorize request used the correct scopes and a fresh consent.');
  }
  return { accessToken: json.access_token, refreshToken: json.refresh_token };
}

/** Reset the in-memory token cache (used by tests / forced refresh). */
export function clearTokenCache(): void {
  cachedToken = undefined;
  cachedExpiry = 0;
}
