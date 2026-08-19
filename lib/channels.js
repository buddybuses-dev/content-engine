// The channel registry.
//
// Each channel is one file under config/channels/. Adding a channel is adding a file —
// no code changes, no registration list to keep in sync. The pipeline stages iterate
// whatever is enabled here, so pausing a channel is flipping `enabled` to false.
//
// Credentials are the interesting part. Four YouTube channels means four refresh
// tokens, and they cannot all be called YOUTUBE_REFRESH_TOKEN. The rule is:
//
//   YOUTUBE_REFRESH_TOKEN_WEALTHVAULT_INSIDER   ← channel-specific, wins
//   YOUTUBE_REFRESH_TOKEN                       ← shared fallback
//
// The fallback exists so a single-channel setup needs no suffixes at all, and so
// genuinely shared credentials (an Anthropic key, a Whop key) are written once.

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot, slugify } from './store.js';
import { optional } from './env.js';

const CHANNELS_DIR = join(projectRoot(), 'config', 'channels');

let cache;

export async function loadChannels() {
  if (cache) return cache;
  if (!existsSync(CHANNELS_DIR)) {
    throw new Error(`No channel configuration found at ${CHANNELS_DIR}. See docs/SETUP.md.`);
  }

  const files = (await readdir(CHANNELS_DIR)).filter((f) => f.endsWith('.json')).sort();
  if (files.length === 0) {
    throw new Error(`config/channels/ is empty — the pipeline has no channel to write for.`);
  }

  const channels = [];
  for (const file of files) {
    const raw = await readFile(join(CHANNELS_DIR, file), 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`config/channels/${file} is not valid JSON: ${error.message}`);
    }

    // The filename is the slug. That keeps the slug visible in the queue path, the
    // env var suffix, and the file listing without a chance of them disagreeing.
    const slug = file.replace(/\.json$/, '');
    if (slug !== slugify(slug)) {
      throw new Error(`config/channels/${file}: filename must be a lowercase slug (got "${slug}")`);
    }

    validate(parsed, file);
    channels.push({ ...parsed, slug });
  }

  cache = channels;
  return channels;
}

function validate(channel, file) {
  const missing = [];
  if (!channel.channel?.name) missing.push('channel.name');
  if (!channel.channel?.niche) missing.push('channel.niche');
  if (!channel.channel?.audience) missing.push('channel.audience');
  if (!channel.voice?.persona) missing.push('voice.persona');
  if (missing.length) {
    throw new Error(`config/channels/${file} is missing required fields: ${missing.join(', ')}`);
  }
  if (channel.channel.name === 'CHANGE ME') {
    throw new Error(`config/channels/${file} still has the placeholder channel name.`);
  }
}

export async function enabledChannels() {
  const channels = await loadChannels();
  const active = channels.filter((c) => c.enabled !== false);
  if (active.length === 0) {
    throw new Error('Every channel in config/channels/ is disabled — nothing to do.');
  }
  return active;
}

export async function findChannel(slug) {
  const channel = (await loadChannels()).find((c) => c.slug === slug);
  if (!channel) throw new Error(`No channel config named "${slug}" in config/channels/`);
  return channel;
}

/** `wealthvault-insider` → `WEALTHVAULT_INSIDER` */
export function envSuffix(slug) {
  return slug.toUpperCase().replace(/-/g, '_');
}

/**
 * Reads a credential for one channel: the channel-specific variable if present,
 * otherwise the shared one. Returns undefined when neither is set — callers decide
 * whether that is fatal.
 */
export function channelEnv(name, channelSlug) {
  return optional(`${name}_${envSuffix(channelSlug)}`) ?? optional(name);
}

export function requireChannelEnv(name, channelSlug) {
  const value = channelEnv(name, channelSlug);
  if (!value) {
    throw new Error(
      `Missing credential ${name} for channel "${channelSlug}". Set ` +
        `${name}_${envSuffix(channelSlug)} (channel-specific) or ${name} (shared) — see docs/SETUP.md.`,
    );
  }
  return value;
}

/** Which platforms this channel publishes to, honouring both channel and global toggles. */
export function channelPlatforms(channel, platformSpecs) {
  return Object.entries(platformSpecs)
    .filter(([key, spec]) => !key.startsWith('$') && spec?.enabled)
    .filter(([key]) => channel.platforms?.[key]?.enabled !== false)
    .map(([key]) => key);
}

export function findBannedClaims(text, channel) {
  const patterns = channel.compliance?.bannedClaimPatterns ?? [];
  const violations = [];
  for (const pattern of patterns) {
    if (new RegExp(pattern, 'i').test(text)) violations.push(pattern);
  }
  return violations;
}
