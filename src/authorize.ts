#!/usr/bin/env node
import * as http from 'http';
import { randomBytes } from 'crypto';
import { exec } from 'child_process';
import { URL } from 'url';
import { loadConfig, saveRefreshToken, CONFIG_PATH } from './config';
import { exchangeCodeForTokens } from './spotify/auth';

/**
 * One-time Spotify authorization flow.
 *
 * Spotify has no static "API key" — editing playlists requires a user-authorized
 * OAuth token. This script:
 *   1. opens the Spotify consent screen in your browser,
 *   2. runs a tiny localhost server to catch the redirect with the auth code,
 *   3. exchanges the code for a refresh token,
 *   4. saves the refresh token into ~/.friday-jammer/config.yaml.
 *
 * After this runs once, the bot can mint access tokens unattended.
 *
 * Scopes:
 *   playlist-modify-public / playlist-modify-private — add tracks
 *   playlist-read-private / playlist-read-collaborative — read existing tracks & collab flag
 *   playlist-modify-private also covers following a playlist privately
 */

const SCOPES = [
  'playlist-modify-public',
  'playlist-modify-private',
  'playlist-read-private',
  'playlist-read-collaborative',
].join(' ');

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? `open "${url}"` :
    process.platform === 'win32' ? `start "" "${url}"` :
    `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) {
      console.log('\nCould not open your browser automatically. Open this URL manually:\n');
      console.log(url + '\n');
    }
  });
}

async function main() {
  // Don't require an existing refresh token — obtaining it is the whole point.
  const config = loadConfig({ requireSpotifyRefresh: false });
  const { spotify } = config;

  const redirect = new URL(spotify.redirectUri);
  const port = redirect.port ? parseInt(redirect.port, 10) : 8888;
  const callbackPath = redirect.pathname || '/callback';
  const state = randomBytes(16).toString('hex');

  const authUrl = new URL('https://accounts.spotify.com/authorize');
  authUrl.searchParams.set('client_id', spotify.clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', spotify.redirectUri);
  authUrl.searchParams.set('scope', SCOPES);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('show_dialog', 'true');

  const server = http.createServer(async (rawReq, res) => {
    const reqUrl = new URL(rawReq.url || '/', `http://127.0.0.1:${port}`);
    if (reqUrl.pathname !== callbackPath) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const code = reqUrl.searchParams.get('code');
    const returnedState = reqUrl.searchParams.get('state');
    const error = reqUrl.searchParams.get('error');

    const finish = (statusCode: number, message: string) => {
      res.writeHead(statusCode, { 'Content-Type': 'text/html' });
      res.end(`<html><body style="font-family:sans-serif;padding:2rem"><h2>${message}</h2><p>You can close this tab.</p></body></html>`);
    };

    if (error) {
      finish(400, `Authorization failed: ${error}`);
      console.error(`\n:x: Spotify returned an error: ${error}`);
      server.close();
      process.exit(1);
    }
    if (!code || returnedState !== state) {
      finish(400, 'Invalid response (state mismatch).');
      console.error('\nState mismatch or missing code — aborting for safety.');
      server.close();
      process.exit(1);
    }

    try {
      const { refreshToken } = await exchangeCodeForTokens(spotify, code);
      saveRefreshToken(refreshToken);
      finish(200, 'friday-jammer is authorized! 🎉');
      console.log(`\n✅ Authorized. Refresh token saved to ${CONFIG_PATH}`);
      console.log('You can now run `npm start` (or `npm run tmux-start`).');
      server.close();
      process.exit(0);
    } catch (err: any) {
      finish(500, 'Token exchange failed — check the terminal.');
      console.error(`\n❌ Token exchange failed: ${err.message}`);
      server.close();
      process.exit(1);
    }
  });

  server.listen(port, () => {
    console.log(`\nfriday-jammer authorization`);
    console.log(`Listening for the Spotify redirect on ${spotify.redirectUri}`);
    console.log(`\nMake sure this exact redirect URI is registered in your Spotify app settings:`);
    console.log(`  ${spotify.redirectUri}\n`);
    console.log('Opening the Spotify consent screen in your browser...');
    openBrowser(authUrl.toString());
  });
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
