import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Configuration for the friday-jammer bot.
 *
 * Read from environment variables first, falling back to a YAML-ish file at
 * ~/.friday-jammer/config.yaml. The file is a simple `key: value` per line format
 * (no real YAML parser needed).
 *
 * Nothing secret is ever typed into Slack — credentials live only here.
 */

export const CONFIG_DIR = path.join(os.homedir(), '.friday-jammer');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.yaml');

export interface SlackConfig {
  botToken: string; // xoxb-...
  appToken: string; // xapp-... (Socket Mode)
  /** Optional channel allowlist (comma-separated channel IDs). Empty = all channels. */
  allowedChannels: string[];
}

export interface SpotifyConfig {
  clientId: string;
  clientSecret: string;
  /** OAuth redirect used by the one-time authorize flow. */
  redirectUri: string;
  /** Long-lived refresh token obtained via `npm run authorize`. */
  refreshToken?: string;
}

export interface Config {
  slack: SlackConfig;
  spotify: SpotifyConfig;
}

/** Parse the simple `key: value` file into a flat record. */
function readConfigFile(): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(CONFIG_PATH)) return out;
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function pick(env: string | undefined, file: string | undefined): string | undefined {
  return (env && env.length ? env : undefined) ?? (file && file.length ? file : undefined);
}

/**
 * Load the full config. `requireSpotifyRefresh` controls whether a missing
 * refresh token is fatal — the authorize flow loads config WITHOUT it (since
 * obtaining the refresh token is the whole point), while the bot REQUIRES it.
 */
export function loadConfig(opts: { requireSpotifyRefresh?: boolean } = {}): Config {
  const file = readConfigFile();

  const botToken = pick(process.env.SLACK_BOT_TOKEN, file.slack_bot_token);
  const appToken = pick(process.env.SLACK_APP_TOKEN, file.slack_app_token);
  const clientId = pick(process.env.SPOTIFY_CLIENT_ID, file.spotify_client_id);
  const clientSecret = pick(process.env.SPOTIFY_CLIENT_SECRET, file.spotify_client_secret);
  const redirectUri = pick(process.env.SPOTIFY_REDIRECT_URI, file.spotify_redirect_uri)
    || 'http://127.0.0.1:8888/callback';
  const refreshToken = pick(process.env.SPOTIFY_REFRESH_TOKEN, file.spotify_refresh_token);
  const allowedRaw = pick(process.env.FRIDAY_JAMMER_CHANNELS, file.allowed_channels) || '';
  const allowedChannels = allowedRaw.split(',').map(s => s.trim()).filter(Boolean);

  const missing: string[] = [];
  if (!botToken) missing.push('slack_bot_token (or SLACK_BOT_TOKEN)');
  if (!appToken) missing.push('slack_app_token (or SLACK_APP_TOKEN)');
  if (!clientId) missing.push('spotify_client_id (or SPOTIFY_CLIENT_ID)');
  if (!clientSecret) missing.push('spotify_client_secret (or SPOTIFY_CLIENT_SECRET)');
  if (opts.requireSpotifyRefresh && !refreshToken) {
    missing.push('spotify_refresh_token — run `npm run authorize` first');
  }

  if (missing.length) {
    throw new Error(
      `Missing configuration:\n  - ${missing.join('\n  - ')}\n\n` +
      `Set these as environment variables or in ${CONFIG_PATH}.\n` +
      `See README.md for the file format.`
    );
  }

  return {
    slack: { botToken: botToken!, appToken: appToken!, allowedChannels },
    spotify: { clientId: clientId!, clientSecret: clientSecret!, redirectUri, refreshToken },
  };
}

/**
 * Persist the obtained refresh token back into the config file, preserving any
 * existing keys. Creates the file (chmod 600) if it doesn't exist.
 */
export function saveRefreshToken(refreshToken: string): void {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });

  const file = readConfigFile();
  file.spotify_refresh_token = refreshToken;

  const body = Object.entries(file).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n';
  fs.writeFileSync(CONFIG_PATH, body, { mode: 0o600 });
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch { /* best effort */ }
}
