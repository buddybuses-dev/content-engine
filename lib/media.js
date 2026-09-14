// Per-channel media folders.
//
// Four channels means four different visual identities. B-roll that suits a Whop
// product review is wrong for a channel built on surprising facts, and sharing one
// folder guarantees the wrong clip ends up on the wrong channel eventually.
//
// So every media kind resolves per channel first, then falls back to a shared pool:
//
//   media/broll/clipvault-agency/   ← this channel's own footage, preferred
//   media/broll/                    ← shared pool, used when the channel has none
//
// The fallback is what keeps a single-channel setup simple and stops an empty channel
// folder from being a hard failure. Output is always per channel — there is no reason
// to mix finished renders.

import { readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from './store.js';

/** Search order for an input kind: the channel's own folder, then the shared pool. */
export function inputDirs(kind, channel) {
  const base = join(projectRoot(), 'media', kind);
  return [join(base, channel), base];
}

/** Where finished renders for this channel go. Always its own folder. */
export async function outputDir(channel) {
  const dir = join(projectRoot(), 'media', 'out', channel);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Every file of the given extensions across the channel's folder and the shared pool,
 * channel-specific first. Returns absolute paths, sorted within each tier so the
 * result is stable — the ffmpeg renderer hashes against this list, and a wobbling
 * order would mean re-running an item produced a different video.
 */
export async function listInputs(kind, channel, pattern) {
  const found = [];
  for (const dir of inputDirs(kind, channel)) {
    if (!existsSync(dir)) continue;
    const entries = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && pattern.test(e.name))
      .map((e) => e.name)
      .sort();
    found.push(...entries.map((name) => join(dir, name)));
  }
  return found;
}

/** Creates the per-channel media folders so a new channel needs no manual setup. */
export async function ensureChannelMedia(channel) {
  for (const kind of ['inbox', 'broll', 'music', 'out']) {
    await mkdir(join(projectRoot(), 'media', kind, channel), { recursive: true });
  }
}
