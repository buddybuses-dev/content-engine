// Source registry. A channel declares `sources.type`; everything downstream is
// unaware of the difference because both sources return the same brief shape.

import * as whop from './whop.js';
import * as topics from './topics.js';

const SOURCES = { whop, topics };

export function sourceFor(channel) {
  const type = channel.sources?.type ?? 'topics';
  const source = SOURCES[type];
  if (!source) {
    throw new Error(
      `Channel "${channel.slug}" declares sources.type "${type}". Available: ${Object.keys(SOURCES).join(', ')}`,
    );
  }
  return source;
}
