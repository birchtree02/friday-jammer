#!/usr/bin/env node
import { loadConfig } from './config';
import { extractFirstPlaylist } from './spotify/links';
import { getAccessToken } from './spotify/auth';
import { getMe } from './spotify/api';

/**
 * Read-only diagnostic: given a playlist link (or id), print exactly what the
 * Spotify Web API reports, the bot account identity, and the decision the bot
 * would make. Makes NO writes — never follows, never adds.
 *
 *   npm run diagnose -- <playlist-link-or-id>
 */

async function main() {
  const arg = process.argv.slice(2).join(' ').trim();
  if (!arg) {
    console.error('Usage: npm run diagnose -- <playlist-link-or-id>');
    process.exit(1);
  }

  const cfg = loadConfig({ requireSpotifyRefresh: true });

  const ref = extractFirstPlaylist(arg);
  const playlistId = ref?.id || (/^[A-Za-z0-9]+$/.test(arg) ? arg : undefined);
  console.log(`Parsed playlist id:  ${playlistId ?? '(could not parse a playlist link from input)'}`);
  if (!playlistId) {
    console.log('\nThe link did not match open.spotify.com/playlist/<id>. If it is a');
    console.log('spotify.link/... short link, open it in a browser and copy the real URL.');
    process.exit(1);
  }

  const token = await getAccessToken(cfg.spotify);

  // Raw playlist fetch so we can see public + collaborative + owner together.
  const res = await fetch(
    `https://api.spotify.com/v1/playlists/${playlistId}?fields=id,name,public,collaborative,owner(id,display_name)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  console.log(`\nGET /playlists/${playlistId} -> HTTP ${res.status}`);
  if (!res.ok) {
    console.log(await res.text().catch(() => ''));
    if (res.status === 404) {
      console.log('\n404 usually means: the token lacks playlist-read-private scope, OR the');
      console.log('playlist is private and not owned by / shared with the bot account.');
    }
    process.exit(1);
  }

  const p: any = await res.json();
  const me = await getMe(cfg.spotify);

  // Is the bot account in the followers list?
  const followRes = await fetch(
    `https://api.spotify.com/v1/playlists/${playlistId}/followers/contains?ids=${encodeURIComponent(me.id)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const following = followRes.ok ? (await followRes.json())[0] : 'unknown';

  const ownerIsBot = p.owner?.id === me.id;

  console.log('\n--- Playlist (as the API sees it) ---');
  console.log(`  name:          ${p.name}`);
  console.log(`  public:        ${p.public}`);
  console.log(`  collaborative: ${p.collaborative}   <-- the field the bot checks`);
  console.log(`  owner.id:      ${p.owner?.id}  (${p.owner?.display_name})`);

  console.log('\n--- Bot account (the authorized Spotify identity) ---');
  console.log(`  id:            ${me.id}  (${me.displayName})`);
  console.log(`  owns playlist: ${ownerIsBot}`);
  console.log(`  following:     ${following}`);

  console.log('\n--- What the bot would do today ---');
  if (!p.collaborative) {
    console.log('  :no_entry: REFUSE — collaborative=false, so handler.ts blocks it.');
    if (ownerIsBot) {
      console.log('  But you OWN this playlist, so the API would actually let the bot write to it.');
      console.log('  This is the false-negative: the collaborative flag is unreliable via the API.');
    }
  } else {
    console.log('  :white_check_mark: PROCEED — would follow (if needed) and add new tracks.');
  }
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
