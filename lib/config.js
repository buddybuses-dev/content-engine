// Global configuration — the parts that are the same for every channel.
//
// Anything that differs per channel (identity, voice, cadence, product list, platform
// opt-outs) lives in config/channels/<slug>.json and is loaded by lib/channels.js.
// Platform limits are here because they are facts about YouTube, Instagram and TikTok,
// not choices any channel gets to make.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectRoot } from './store.js';

const cache = new Map();

async function load(name) {
  if (cache.has(name)) return cache.get(name);
  const path = join(projectRoot(), 'config', name);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Could not load config/${name}: ${error.message}`);
  }
  cache.set(name, parsed);
  return parsed;
}

export const loadPlatforms = () => load('platforms.json');

/** Platforms enabled globally. A channel may opt out of any of them, never opt in beyond them. */
export async function enabledPlatforms() {
  const platforms = await loadPlatforms();
  return Object.entries(platforms)
    .filter(([key, value]) => !key.startsWith('$') && value?.enabled)
    .map(([key]) => key);
}
