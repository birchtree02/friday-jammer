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

## Deploying to AWS (serverless)

For an always-available bot that's only used occasionally, run it on AWS Lambda
in Slack **HTTP mode** instead of Socket Mode. It costs effectively nothing at
this volume (well inside Lambda's free allowance) and there's no server to patch.

```
Slack ──signed POST──▶ Ingress λ (public Function URL) ──async invoke──▶ Worker λ (private)
                         verifies signature, acks <3s                    reads thread, runs
                         reads: signing secret only                      runJam(), replies
                                                                         reads: bot token,
                                                                         Spotify creds
```

- `src/lambda/ingress.ts` verifies Slack's HMAC signature (rejecting requests
  older than 5 minutes), drops Slack retries, applies the channel allowlist,
  ignores mentions from other organisations in Slack Connect channels,
  queues the job and returns 200.
- `src/lambda/worker.ts` reuses `fetchThread()` and `runJam()` and posts the
  result in the thread (mentions) or to the `response_url` (slash command).
- Secrets live in a private, encrypted S3 bucket the stack creates, as two
  JSON objects: `ingress.json` and `worker.json`. Each function's IAM role, and
  the bucket policy, allow reading only its own object, so the public function
  never sees the bot token or Spotify credentials.

The template's defaults fit the Cloudsoft Training account (see
[Shared accounts](#shared-accounts)): roles sit under the IAM path
`/training/friday-jammer/` with the `TrainingDeveloperPolicy` permissions
boundary, and secrets go in S3 because that boundary allows neither SSM
Parameter Store nor Secrets Manager. In an account without that boundary,
deploy with `PermissionsBoundaryPolicy` empty.

### Prerequisites

AWS CLI and [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
configured for the target account. Examples use `eu-west-2` and assume
`AWS_PROFILE` is set to that account's profile (for the Training account, your
`TrainingDeveloper` SSO profile).

### 1. Authorize Spotify locally (one time)

Follow steps 2–4 of *Setup* above on your laptop to get `spotify_refresh_token`
into `~/.friday-jammer/config.yaml`. The consent screen needs a browser and the
localhost redirect, so this step can't run in Lambda. Use a dedicated Spotify
account for the bot, not a personal one. The Spotify account that owns the
developer app needs Premium: Spotify stops development-mode apps working for
owners without it.

### 2. Build and deploy

```bash
npm install
npm run test:lambda     # builds dist-lambda/ and runs offline checks
sam deploy --guided --region eu-west-2 --stack-name friday-jammer \
  --capabilities CAPABILITY_IAM --tags app=friday-jammer
```

Accept the defaults unless the account needs otherwise: see *Concurrency*
under [Shared accounts](#shared-accounts) for `ReservedConcurrency`.

The stack prints `SecretsBucket` and `SlackRequestUrl` outputs. The functions
reply with errors until step 3 is done.

### 3. Upload the secrets

Get the **Signing Secret** from the Slack app's *Basic Information* page. Each
value is read at a hidden prompt and streamed straight to S3, so nothing ends up
in shell history or on disk:

```bash
BUCKET=$(aws cloudformation describe-stacks --region eu-west-2 --stack-name friday-jammer \
  --query "Stacks[0].Outputs[?OutputKey=='SecretsBucket'].OutputValue" --output text)

upload() {  # upload <object> <key>...
  local obj=$1; shift
  python3 -c 'import getpass, json, sys
print(json.dumps({k: getpass.getpass(k + ": ") for k in sys.argv[1:]}))' "$@" |
    aws s3 cp - "s3://$BUCKET/$obj" --region eu-west-2
}

# allowed_channels: comma-separated channel IDs the bot may work in. If it's
# empty, the Lambda deployment ignores every request.
upload ingress.json slack_signing_secret allowed_channels
upload worker.json slack_bot_token spotify_client_id spotify_client_secret spotify_refresh_token
```

### 4. Point Slack at it

Open `slack-app-manifest.http.yaml`, replace both `REQUEST_URL` placeholders
with `SlackRequestUrl`, and paste it into the app's *App Manifest* page. Slack
verifies the URL immediately. Reinstall the app if Slack asks.

Socket Mode is now off for this app, so stop any local `npm start` instance. To
go back to running locally, re-apply `slack-app-manifest.yaml`.

### Updating

`npm run build:lambda && sam deploy`. To change a secret, re-run the `upload`
line for its object (it replaces the whole object, so enter every value again).
It's picked up on the next cold start, or force it by redeploying.

To remove the bot, empty the secrets bucket (`aws s3 rm "s3://$BUCKET" --recursive`)
and then `sam delete --stack-name friday-jammer --region eu-west-2`.

### Logs

```bash
sam logs --stack-name friday-jammer --region eu-west-2 --tail
```

Logs are kept for 14 days.

### Shared accounts

In the Cloudsoft Training account, every `TrainingDeveloper` can update any
Lambda function's code and take over any role under `/training/`. That's how
the account is meant to work, but it means anyone in it who sets out to can get
the bot's secrets. What the setup does and doesn't cover:

- **Stopped:** stumbling across the secrets. They aren't in the console or in
  function settings, and the bucket policy denies reading them to everyone but
  the two functions, overriding the read-only access everyone has.
- **Not stopped:** someone deliberately changing a function or its role to
  get them. Those changes show up in CloudTrail.
- **What a leak would expose:** the Spotify credentials control only the bot's
  Spotify account. The Slack bot token can post as the bot and read the history
  of channels it's in, so keep the bot out of private channels. Then it can
  read nothing Cloudsoft staff can't already.
- **If a secret leaks:** reset the client secret in the Spotify developer
  dashboard and remove the app's access from the bot's Spotify account, then
  run `npm run authorize` again. Regenerate the Slack signing secret and
  reinstall the app to get a new bot token. Then re-upload both objects.
- **Account resets.** If the account gets wiped (e.g. with aws-nuke), the bot
  goes with it and Slack requests fail until it's redeployed. To bring it
  back, repeat steps 2–4: the stack gets a new bucket and a new Function URL,
  so the secrets must be uploaded again and the manifest updated with the new
  URL.
- **Concurrency.** Check the region's limit with
  `aws lambda get-account-settings` (`AccountLimit.ConcurrentExecutions`). At
  1000 or more, keep `ReservedConcurrency=true`, so a flood on the public URL
  can't take capacity from everyone else's functions. At 10, nothing can be
  reserved: deploy with `false` and the bot shares those 10 slots with the
  rest of the account, or ask for the limit to be raised. Don't raise the
  limit and use `false`, which leaves the bot uncapped.

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
