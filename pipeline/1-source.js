#!/usr/bin/env node
// Stage 1 — SOURCE. Turn vetted Whop products into content briefs, per channel.
//
// Idempotent by design: a product already somewhere in that channel's queue is never
// briefed twice, so this can run every few hours without the queue filling with
// duplicates. The same product may legitimately appear on two channels — the check is
// scoped per channel, not global.

import { sourceFor } from '../sources/index.js';
import { enabledChannels } from '../lib/channels.js';
import {
  createItem,
  saveItem,
  listItems,
  countItems,
  ensureChannelQueue,
  STAGE_ORDER,
} from '../lib/store.js';
import { logger, summary } from '../lib/log.js';

const log = logger('1-source');

async function seenProductIds(channelSlug) {
  const ids = new Set();
  for (const stage of [...STAGE_ORDER, 'failed']) {
    for (const item of await listItems(channelSlug, stage)) {
      if (item.source?.productId) ids.add(item.source.productId);
    }
  }
  return ids;
}

async function sourceChannel(channel) {
  const slug = channel.slug;
  await ensureChannelQueue(slug);

  const sources = channel.sources ?? {};
  const maxNew = sources.discovery?.maxNewItemsPerRun ?? 5;
  const maxDepth = channel.cadence?.maxQueueDepth ?? 40;

  const pending =
    (await countItems(slug, 'brief')) +
    (await countItems(slug, 'script')) +
    (await countItems(slug, 'render'));

  if (pending >= maxDepth) {
    log.info('queue at capacity, sourcing nothing', { channel: slug, pending, maxDepth });
    return { channel: slug, candidates: 0, created: 0, note: `at capacity (${pending}/${maxDepth})` };
  }

  const source = sourceFor(channel);
  const products = await source.collect(sources, slug);
  if (products.length === 0) {
    log.warn('nothing to source', { channel: slug, sourceType: sources.type ?? 'topics' });
    return {
      channel: slug,
      candidates: 0,
      created: 0,
      note: sources.type === 'whop' ? 'no products configured' : 'no topics configured',
    };
  }

  const seen = await seenProductIds(slug);
  const fresh = products
    .filter((p) => !seen.has(p.productId))
    .slice(0, Math.min(maxNew, maxDepth - pending));

  for (const product of fresh) {
    const item = createItem({
      channel: slug,
      title: product.name,
      source: product,
      brief: {
        angleNotes: product.angleNotes,
        priceLabel: product.priceLabel,
        category: product.category,
      },
    });
    await saveItem(item);
    log.info('briefed', { channel: slug, id: item.id, product: product.name });
  }

  const skipped = products.length - fresh.length;
  return {
    channel: slug,
    candidates: products.length,
    created: fresh.length,
    note: skipped > 0 ? `${skipped} already in pipeline` : '',
  };
}

async function main() {
  const channels = await enabledChannels();
  log.info('sourcing', { channels: channels.map((c) => c.slug) });

  const results = [];
  for (const channel of channels) {
    try {
      results.push(await sourceChannel(channel));
    } catch (error) {
      // One channel's bad config must not stop the others from producing.
      log.error('channel failed', { channel: channel.slug, error: error.message });
      results.push({
        channel: channel.slug,
        candidates: 0,
        created: 0,
        note: `ERROR: ${error.message}`,
      });
    }
  }

  await summary(
    [
      '### Source',
      '',
      '| Channel | Candidates | New briefs | Note |',
      '| --- | ---: | ---: | --- |',
      ...results.map((r) => `| ${r.channel} | ${r.candidates} | ${r.created} | ${r.note || '—'} |`),
      '',
    ].join('\n'),
  );
}

main().catch((error) => {
  log.error('stage failed', { error: error.message });
  console.error(error);
  process.exit(1);
});
