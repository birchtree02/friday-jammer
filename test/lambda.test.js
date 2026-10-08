/**
 * Offline checks for the Lambda handlers (no AWS, Slack or Spotify calls).
 * Run with `npm run test:lambda` (builds dist-lambda first).
 */
const path = require('path'), crypto = require('crypto'), assert = require('assert');
const fork = path.resolve(__dirname, '..');
const { LambdaClient } = require(path.join(fork, 'node_modules/@aws-sdk/client-lambda'));
const invoked = [];
LambdaClient.prototype.send = async function (cmd) { invoked.push(JSON.parse(Buffer.from(cmd.input.Payload).toString())); return {}; };
process.env.SLACK_SIGNING_SECRET = 'shh'; process.env.WORKER_FN = 'worker'; process.env.FRIDAY_JAMMER_CHANNELS = 'C1';
const { handler } = require(path.join(fork, 'dist-lambda/ingress.js'));
const sign = (body, ts = Math.floor(Date.now()/1000), secret='shh') => ({
  'X-Slack-Request-Timestamp': String(ts),
  'X-Slack-Signature': 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex'),
});
(async () => {
  // url_verification
  let b = JSON.stringify({ type: 'url_verification', challenge: 'abc' });
  let r = await handler({ headers: { ...sign(b), 'content-type': 'application/json' }, body: b });
  assert.equal(r.statusCode, 200); assert.equal(JSON.parse(r.body).challenge, 'abc');
  // bad signature
  r = await handler({ headers: { ...sign(b, undefined, 'wrong'), 'content-type': 'application/json' }, body: b });
  assert.equal(r.statusCode, 401);
  // stale timestamp
  r = await handler({ headers: { ...sign(b, Math.floor(Date.now()/1000) - 600), 'content-type': 'application/json' }, body: b });
  assert.equal(r.statusCode, 401);
  // mention in allowed channel -> invoke
  b = JSON.stringify({ type: 'event_callback', team_id: 'T1', event: { type: 'app_mention', channel: 'C1', user_team: 'T1', ts: '1.1', thread_ts: '1.0', text: '<@U1> https://open.spotify.com/playlist/x' } });
  r = await handler({ headers: { ...sign(b), 'content-type': 'application/json' }, body: b });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(invoked.pop(), { kind: 'mention', channel: 'C1', threadTs: '1.0', triggerText: 'https://open.spotify.com/playlist/x' });
  // mention in disallowed channel -> no invoke
  b = JSON.stringify({ type: 'event_callback', event: { type: 'app_mention', channel: 'C2', ts: '1.1', text: 'hi' } });
  r = await handler({ headers: { ...sign(b), 'content-type': 'application/json' }, body: b });
  assert.equal(invoked.length, 0);
  // mention from another organisation (Slack Connect) -> no invoke
  b = JSON.stringify({ type: 'event_callback', team_id: 'T1', event: { type: 'app_mention', channel: 'C1', user_team: 'T2', ts: '1.1', text: '<@U1> https://open.spotify.com/playlist/x' } });
  r = await handler({ headers: { ...sign(b), 'content-type': 'application/json' }, body: b });
  assert.equal(r.statusCode, 200); assert.equal(invoked.length, 0);
  // empty allowlist -> nothing allowed
  process.env.FRIDAY_JAMMER_CHANNELS = '';
  b = JSON.stringify({ type: 'event_callback', event: { type: 'app_mention', channel: 'C1', ts: '1.1', text: '<@U1> https://open.spotify.com/playlist/x' } });
  r = await handler({ headers: { ...sign(b), 'content-type': 'application/json' }, body: b });
  assert.equal(invoked.length, 0);
  process.env.FRIDAY_JAMMER_CHANNELS = 'C1';
  // retry -> no invoke
  r = await handler({ headers: { ...sign(b), 'content-type': 'application/json', 'X-Slack-Retry-Num': '1' }, body: b });
  assert.equal(r.headers['x-slack-no-retry'], '1'); assert.equal(invoked.length, 0);
  // slash command, base64 body
  const form = 'command=%2Ffriday-jammer&channel_id=C1&text=https%3A%2F%2Fopen.spotify.com%2Fplaylist%2Fy&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2Fz';
  r = await handler({ headers: { ...sign(form), 'content-type': 'application/x-www-form-urlencoded' }, body: Buffer.from(form).toString('base64'), isBase64Encoded: true });
  assert.equal(JSON.parse(r.body).response_type, 'ephemeral');
  assert.equal(invoked.pop().responseUrl, 'https://hooks.slack.com/commands/z');
  // slash command with no text/thread -> immediate help, no invoke
  const f2 = 'command=%2Ffriday-jammer&channel_id=C1&text=&response_url=x';
  r = await handler({ headers: { ...sign(f2), 'content-type': 'application/x-www-form-urlencoded' }, body: f2 });
  assert.match(JSON.parse(r.body).text, /Run me inside a thread/); assert.equal(invoked.length, 0);
  console.log('ingress: 10 checks passed');

  // worker: slash command outside a thread with no playlist link -> warning via response_url
  // secrets come from worker.json in the secrets bucket
  const { S3Client } = require(path.join(fork, 'node_modules/@aws-sdk/client-s3'));
  const s3Reads = [];
  S3Client.prototype.send = async function (cmd) {
    s3Reads.push(cmd.input);
    const json = JSON.stringify({ slack_bot_token: 'xoxb-test', spotify_client_id: 'id', spotify_client_secret: 'secret', spotify_refresh_token: 'rt' });
    return { Body: { transformToString: async () => json } };
  };
  process.env.SECRETS_BUCKET = 'bucket'; process.env.SECRETS_KEY = 'worker.json';
  const posts = [];
  global.fetch = async (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; };
  const worker = require(path.join(fork, 'dist-lambda/worker.js'));
  await worker.handler({ kind: 'command', channel: 'C1', triggerText: 'no links here', responseUrl: 'https://hooks.slack.com/commands/z' });
  assert.equal(posts.length, 1); assert.match(posts[0].body.text, /No playlist link found/);
  assert.deepEqual(s3Reads, [{ Bucket: 'bucket', Key: 'worker.json' }]);
  assert.equal(process.env.SLACK_BOT_TOKEN, 'xoxb-test');
  // worker refuses non-Slack response_url
  await worker.handler({ kind: 'command', channel: 'C1', triggerText: 'x', responseUrl: 'https://evil.example/' });
  assert.equal(posts.length, 1);
  console.log('worker: 3 checks passed');
})().catch(e => { console.error(e); process.exit(1); });
