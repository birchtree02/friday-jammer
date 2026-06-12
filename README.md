# friday-jammer

A Slack bot that scoops up the Spotify track links shared in a thread and adds them
to a **collaborative** Spotify playlist. Runs locally on your machine over Slack's
Socket Mode — no public URL or webhooks needed.

The Slack integration uses Socket Mode with env-or-file config and retry-on-start.
There's no AI involved — link parsing is regex and the Spotify work is plain Web API
calls.

## What it does

Trigger it in a Slack thread with either:

- `/friday-jammer [playlist-link]` — slash command (responds privately)
- `@friday-jammer [playlist-link]` — mention (replies in the thread)

Then it:

1. Resolves the **target playlist** — the link you passed, or, if you passed none,
   the first playlist link in the message that started the thread.
2. **Refuses unless the playlist is collaborative.** It never adds to a
   non-collaborative playlist, even one owned by the connected account, and it
   never creates new playlists.
3. Collects every Spotify **track** link in the thread (de-duplicated).
4. **Follows** the playlist (adds it to the bot account's library) if not already —
   required to contribute to a collaborative playlist.
5. Adds only the tracks **not already present** (batched, 100 at a time).
6. Replies with a summary: added / already-present / ignored.

## Important: how Spotify auth works

Spotify has **no static "API key."** Editing playlists needs a *user-authorized*
OAuth token. So you:

1. Create a Spotify app at <https://developer.spotify.com/dashboard> to get a
   **Client ID** and **Client Secret**.
2. Add a redirect URI to that app — by default `http://127.0.0.1:8888/callback`.
3. Run the one-time `npm run authorize` flow (below), which logs you in and stores
   a **refresh token**. After that the bot runs unattended.

The bot acts as a **single Spotify identity** — whichever account you authorize.
Every track add is attributed to that account, regardless of which Slack user
triggered it.

## Setup

### 1. Create the Slack app

At <https://api.slack.com/apps> → *Create New App* → *From scratch*.

- **Socket Mode**: enable it. Generate an **App-Level Token** with the
  `connections:write` scope → this is your `xapp-...` token.
- **OAuth & Permissions** → Bot Token Scopes:
  - `commands`
  - `app_mentions:read`
  - `channels:history` (and `groups:history` for private channels)
  - `chat:write`
- **Slash Commands** → create `/friday-jammer` (Request URL is ignored in Socket
  Mode, but the command must exist).
- **Event Subscriptions** → subscribe to bot event `app_mention`.
- Install the app to your workspace → copy the **Bot User OAuth Token** (`xoxb-...`).

### 2. Configure credentials

Create `~/.friday-jammer/config.yaml` (the file is `key: value`, one per line):

```yaml
slack_bot_token: xoxb-...
slack_app_token: xapp-...
spotify_client_id: your-spotify-client-id
spotify_client_secret: your-spotify-client-secret
# optional — defaults to http://127.0.0.1:8888/callback
spotify_redirect_uri: http://127.0.0.1:8888/callback
# optional — comma-separated channel IDs to restrict the bot to; empty = all
allowed_channels:
```

`chmod 600 ~/.friday-jammer/config.yaml`. Every value can alternatively be supplied
as an environment variable (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`,
`SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI`,
`FRIDAY_JAMMER_CHANNELS`).

### 3. Install & build

```bash
npm install
npm run build
```

### 4. Authorize Spotify (one time)

```bash
npm run authorize
```

This opens the Spotify consent screen, catches the redirect, and writes
`spotify_refresh_token` into your config file.

### 5. Run

```bash
npm start
# or run detached in tmux:
npm run tmux-start    # npm run tmux-stop / tmux-bounce
```

## Notes & limitations

- **Collaborative-only** is a hard rule — by design, so the connected account
  isn't spammed with arbitrary shared playlists.
- The bot stays **following** collaborative playlists it edits (membership is what
  lets it keep contributing).
- Dedup is by exact track URI, so the *same song released on two different albums*
  is treated as two different tracks.
- Album / artist / podcast links are ignored (with a note); only individual
  **track** links are added.
- Slash commands don't always carry thread context — `@friday-jammer` in the thread
  is the most reliable trigger.
