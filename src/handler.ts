import { Config } from './config';
import { extractFirstPlaylist, extractTrackUris, extractUnsupportedRefs } from './spotify/links';
import {
  getMe, getPlaylist, getPlaylistTrackUris, isFollowingPlaylist, followPlaylist, addTracks,
  SpotifyApiError, PlaylistMeta,
} from './spotify/api';

/**
 * Orchestrates a single invocation: figure out the target playlist, gather track
 * links from the thread, attempt to add the not-yet-present tracks, and follow the
 * playlist on success.
 *
 * Write permission is decided by Spotify, not by us: the `collaborative` flag is
 * unreliable (it reads false for the newer invite-based collaboration UI), so
 * rather than pre-judge, we attempt the add and treat an HTTP 403 as the real
 * "you can't write here" signal. We add BEFORE following so that a playlist we
 * can't write to is never left cluttering the bot account's library. The bot
 * still never creates playlists.
 *
 * Slack specifics (fetching the thread, posting replies) live in index.ts. This
 * module takes the already-collected message texts and returns a reply string.
 */

export interface JamRequest {
  /** Raw text of the command / mention that triggered the bot. */
  triggerText: string;
  /** Raw text of the thread's root message (may equal triggerText if not in a thread). */
  rootText: string;
  /** Raw text of every message in the thread, in order. */
  threadTexts: string[];
}

export async function runJam(cfg: Config, req: JamRequest): Promise<string> {
  const spotify = cfg.spotify;

  // 1. Resolve the target playlist: prefer the trigger text, fall back to the thread root.
  const playlistRef = extractFirstPlaylist(req.triggerText) || extractFirstPlaylist(req.rootText);
  if (!playlistRef) {
    return [
      ":warning: No playlist link found.",
      "Either pass one when you trigger me — `/friday-jammer <playlist-link>` or `@friday-jammer <playlist-link>` —",
      "or make sure the message that started this thread contains a Spotify playlist link.",
    ].join('\n');
  }

  // 2. Fetch playlist metadata + identify the bot account. We no longer gate on the
  //    `collaborative` flag — Spotify decides write permission, signalled by a 403
  //    on the add below.
  let meta: PlaylistMeta;
  try {
    meta = await getPlaylist(spotify, playlistRef.id);
  } catch (err) {
    if (err instanceof SpotifyApiError && err.status === 404) {
      return `:warning: I couldn't find that playlist (it may be private or the link is wrong): \`${playlistRef.id}\``;
    }
    throw err;
  }

  const me = await getMe(spotify);
  const botOwnsPlaylist = meta.ownerId === me.id;

  // 3. Gather track links from the whole thread, de-duplicated.
  const candidateUris = extractTrackUris(req.threadTexts);
  const unsupported = extractUnsupportedRefs(req.threadTexts);

  if (candidateUris.length === 0) {
    const extra = unsupported.length
      ? ` I did see ${unsupported.length} album/artist/other link(s), but I only add individual *track* links.`
      : '';
    return `:information_source: I didn't find any Spotify *track* links in this thread to add to *"${meta.name}"*.${extra}`;
  }

  // 4. Read existing tracks and add only the new ones. The add is the real
  //    permission check: a 403 means the bot account can't write to this playlist.
  const existing = await getPlaylistTrackUris(spotify, meta.id);
  const toAdd = candidateUris.filter(uri => !existing.has(uri));
  const alreadyPresent = candidateUris.length - toAdd.length;

  if (toAdd.length > 0) {
    try {
      await addTracks(spotify, meta.id, toAdd);
    } catch (err) {
      if (err instanceof SpotifyApiError && err.status === 403) {
        return notWritableMessage(meta);
      }
      throw err;
    }
  }

  // 5. Follow the playlist only AFTER a successful write — this is the "add the
  //    shared playlist to the library" step, and doing it last means a playlist we
  //    couldn't write to never gets left in the bot account's library. Skipped when
  //    the bot owns it (an owned playlist is already there and can't self-follow).
  let justFollowed = false;
  if (!botOwnsPlaylist) {
    try {
      const alreadyFollowing = await isFollowingPlaylist(spotify, meta.id, me.id);
      if (!alreadyFollowing) {
        await followPlaylist(spotify, meta.id);
        justFollowed = true;
      }
    } catch (err) {
      // Non-fatal: the tracks were already added. Log and carry on.
      console.error(`[handler] follow after add failed for ${meta.id}: ${(err as Error).message}`);
    }
  }

  // 6. Build the summary reply.
  return formatSummary({
    playlistName: meta.name,
    playlistUrl: meta.externalUrl,
    added: toAdd.length,
    alreadyPresent,
    unsupported: unsupported.length,
    justFollowed,
  });
}

/** Reply shown when Spotify rejects the add with a 403 (bot account can't write here). */
function notWritableMessage(meta: PlaylistMeta): string {
  return [
    `:no_entry: I couldn't add to *"${meta.name}"* — Spotify won't let my account write to it.`,
    "To fix this, the owner needs to make me a collaborator: open the playlist's *Invite collaborators*",
    "link and have my Spotify account join it. (I never create playlists, so I'll only add to ones I can edit.)",
  ].join('\n');
}

function formatSummary(s: {
  playlistName: string;
  playlistUrl?: string;
  added: number;
  alreadyPresent: number;
  unsupported: number;
  justFollowed: boolean;
}): string {
  const target = s.playlistUrl ? `<${s.playlistUrl}|${s.playlistName}>` : `*${s.playlistName}*`;
  const parts: string[] = [];

  if (s.added > 0) parts.push(`:white_check_mark: added *${s.added}* track${s.added === 1 ? '' : 's'}`);
  else parts.push(`:white_check_mark: nothing new to add`);

  if (s.alreadyPresent > 0) parts.push(`:fast_forward: *${s.alreadyPresent}* already in the playlist`);
  if (s.unsupported > 0) parts.push(`:warning: ignored *${s.unsupported}* non-track link${s.unsupported === 1 ? '' : 's'} (album/artist/etc)`);

  const header = `:musical_note: ${target}`;
  const followNote = s.justFollowed ? `\n_Added the playlist to my library so I could contribute to it._` : '';
  return `${header}\n${parts.join(' · ')}${followNote}`;
}
