// Topic sourcing — for channels that are not selling anything.
//
// Three of the four channels are content channels, not affiliate channels. They have
// no product to review, so their brief starts from a topic and an angle instead.
//
// The output shape is identical to the Whop source. That is the whole point: every
// stage downstream — scripting, rendering, publishing, stats — stays unaware of where
// an idea came from. A brief is a brief.
//
// Topics are deliberately hand-written rather than scraped from a trends API. A trend
// feed produces videos about whatever is loud today, which is how a channel ends up
// with no identity. A list you maintain produces videos about what you can actually
// say something about.

import { logger } from '../lib/log.js';

const log = logger('source:topics');

/** Same normalised shape the Whop source returns, so nothing downstream branches. */
function normalize(raw) {
  return {
    type: 'topic',
    productId: String(raw.id ?? ''),
    name: raw.title ?? 'Untitled topic',
    url: raw.reference ?? '',
    affiliateUrl: '',
    priceLabel: '',
    category: raw.category ?? '',
    angleNotes: raw.angleNotes ?? '',
    rating: null,
    reviewCount: null,
  };
}

export function loadManual(sourcesConfig) {
  const topics = (sourcesConfig.topics ?? [])
    .filter((t) => t.enabled !== false)
    .map(normalize);
  log.info('loaded topics', { count: topics.length });
  return topics;
}

export function applyFilters(topics, sourcesConfig) {
  const banned = (sourcesConfig.exclude?.keywords ?? []).map((k) => k.toLowerCase());
  const bannedIds = new Set(sourcesConfig.exclude?.productIds ?? []);

  return topics.filter((topic) => {
    if (bannedIds.has(topic.productId)) return false;
    const haystack = `${topic.name} ${topic.category} ${topic.angleNotes}`.toLowerCase();
    const hit = banned.find((word) => haystack.includes(word));
    if (hit) {
      log.info('excluded by keyword', { topic: topic.name, keyword: hit });
      return false;
    }
    return true;
  });
}

export async function collect(sourcesConfig) {
  return applyFilters(loadManual(sourcesConfig), sourcesConfig);
}
