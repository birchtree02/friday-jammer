import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

/**
 * Load secrets from the stack's private S3 bucket into process.env, once per
 * cold start.
 *
 * Each Lambda reads a single JSON object (SECRETS_KEY in SECRETS_BUCKET):
 * ingress.json holds the signing secret and channel allowlist, worker.json the
 * bot token and Spotify credentials. Each role, and the bucket policy, allow
 * only that function's own object, so the public ingress function never sees
 * the bot token or the Spotify credentials.
 *
 * S3 rather than SSM Parameter Store or Secrets Manager because the Training
 * account's permissions boundary allows neither for the functions' roles.
 *
 * If SECRETS_BUCKET is unset (local testing), nothing is fetched and whatever
 * is already in the environment is used.
 */

/** JSON key → environment variable read by config.ts. */
export const SECRET_ENV: Record<string, string> = {
  slack_signing_secret: 'SLACK_SIGNING_SECRET',
  slack_bot_token: 'SLACK_BOT_TOKEN',
  spotify_client_id: 'SPOTIFY_CLIENT_ID',
  spotify_client_secret: 'SPOTIFY_CLIENT_SECRET',
  spotify_refresh_token: 'SPOTIFY_REFRESH_TOKEN',
  allowed_channels: 'FRIDAY_JAMMER_CHANNELS',
};

let loaded: Promise<void> | undefined;

export function loadSecrets(): Promise<void> {
  if (!loaded) {
    loaded = fetchSecrets().catch(err => {
      loaded = undefined; // let the next invocation retry
      throw err;
    });
  }
  return loaded;
}

async function fetchSecrets(): Promise<void> {
  const bucket = process.env.SECRETS_BUCKET;
  const key = process.env.SECRETS_KEY;
  if (!bucket || !key) return;

  const res = await new S3Client({}).send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const values = JSON.parse(await res.Body!.transformToString()) as Record<string, unknown>;

  for (const [name, value] of Object.entries(values)) {
    const envName = SECRET_ENV[name];
    if (!envName) {
      console.error(`[secrets] ignoring unknown key "${name}" in ${key}`);
      continue;
    }
    if (typeof value === 'string') process.env[envName] = value;
  }
  // Missing optional values (e.g. allowed_channels) are fine; required ones
  // are reported by loadConfig() / the ingress check with a clear message.
}
