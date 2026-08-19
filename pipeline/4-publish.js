#!/usr/bin/env node
// Stage 4 — PUBLISH. Ready video out to every enabled platform, per channel.
//
// Three properties this stage must have, because it is the only irreversible one:
//
//   1. Never double-post. Each platform result is written back to the item as soon as
//      it lands, so a re-run after a partial failure resumes on the platforms that
//      have not published yet and skips the ones that have.
//
//   2. Never exceed a channel's own cadence. The queue can hold forty videos; that is
//      not a reason to post forty times. The limits in each channel config are
//      enforced here, not left to the scheduler.
//
//   3. Never let one channel take another down. Channels are fully independent: a
//      channel with expired credentials fails alone, and the rest still publish.
//
// One item per channel per run. That keeps a single run's blast radius small and makes
// the cadence arithmetic trivial to reason about.

import { publisherFor } from '../publishers/index.js';
import { loadPlatforms } from '../lib/config.js';
import { enabledChannels, channelPlatforms } from '../lib/channels.js';
import { listItems, saveItem, advance, fail } from '../lib/store.js';
import { isDryRun } from '../lib/env.js';
import { logger, summary } from '../lib/log.js';

const log = logger('4-publish');

/** How many posts this channel already made today, and when its most recent one was. */
async function recentActivity(channelSlug) {
  const published = await listItems(channelSlug, 'published');
  const today = new Date().toISOString().slice(0, 10);
  let todayCount = 0;
  let latest = 0;

  for (const item of published) {
    for (const result of Object.values(item.publish ?? {})) {
      if (!result?.publishedAt) continue;
      const at = Date.parse(result.publishedAt);
      if (Number.isFinite(at)) latest = Math.max(latest, at);
      if (result.publishedAt.slice(0, 10) === today) {
        todayCount += 1;
        break; // one item published to three platforms is one post, not three
      }
    }
  }
  return { todayCount, latest };
}

async function publishChannel(channel, platformSpecs) {
  const slug = channel.slug;
  const cadence = channel.cadence ?? {};
  const active = channelPlatforms(channel, platformSpecs);

  if (active.length === 0) {
    return { channel: slug, status: 'no platforms enabled', results: [], errors: [] };
  }

  const { todayCount, latest } = await recentActivity(slug);

  const maxPerDay = cadence.postsPerDay ?? 2;
  if (todayCount >= maxPerDay) {
    log.info('daily cadence reached', { channel: slug, todayCount, maxPerDay });
    return { channel: slug, status: `daily limit reached (${todayCount}/${maxPerDay})`, results: [], errors: [] };
  }

  const minGapMs = (cadence.minMinutesBetweenPosts ?? 0) * 60_000;
  const sinceLast = Date.now() - latest;
  if (latest && sinceLast < minGapMs) {
    const waitMin = Math.ceil((minGapMs - sinceLast) / 60_000);
    log.info('too soon since last post', { channel: slug, waitMin });
    return { channel: slug, status: `too soon — ${waitMin} min to go`, results: [], errors: [] };
  }

  const queue = await listItems(slug, 'ready');
  if (queue.length === 0) {
    return { channel: slug, status: 'nothing ready', results: [], errors: [] };
  }

  // Oldest first: a video that has been waiting is more likely to go stale.
  const item = queue.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  const results = [];
  const errors = [];

  for (const platform of active) {
    if (item.publish?.[platform]?.remoteId) {
      log.info('already published, skipping', { channel: slug, id: item.id, platform });
      continue;
    }

    try {
      if (isDryRun()) {
        log.info('DRY_RUN — would publish', { channel: slug, id: item.id, platform });
        results.push(`${platform} (dry run)`);
        continue;
      }

      const result = await publisherFor(platform).publish(item, platformSpecs[platform]);

      // Persist immediately. If the next platform throws, this one stays recorded.
      item.publish = { ...(item.publish ?? {}), [platform]: result };
      item.history.push({ at: result.publishedAt, event: `published:${platform}`, detail: result.url });
      await saveItem(item);

      results.push(`${platform} → ${result.url}`);
    } catch (error) {
      log.error('publish failed', { channel: slug, id: item.id, platform, error: error.message });
      errors.push(`${platform}: ${error.message}`);
    }
  }

  if (results.length === 0 && errors.length > 0) {
    await fail(item, 'all platforms failed', new Error(errors.join(' | ')));
    return { channel: slug, status: 'all platforms failed', title: item.title, results, errors };
  }

  if (errors.length > 0) {
    // Partial success is still success — the item advances, and the platforms that
    // failed are retried on the next run because their result slot is still empty.
    item.partialErrors = errors;
    log.warn('partial publish', { channel: slug, id: item.id, errors });
  }

  if (!isDryRun()) await advance(item, 'published', results.join('; '));

  return { channel: slug, status: 'published', title: item.title, results, errors };
}

async function main() {
  const [channels, platformSpecs] = await Promise.all([enabledChannels(), loadPlatforms()]);

  const outcomes = [];
  for (const channel of channels) {
    try {
      outcomes.push(await publishChannel(channel, platformSpecs));
    } catch (error) {
      log.error('channel failed', { channel: channel.slug, error: error.message });
      outcomes.push({ channel: channel.slug, status: `ERROR: ${error.message}`, results: [], errors: [] });
    }
  }

  const lines = ['### Publish', ''];
  for (const outcome of outcomes) {
    lines.push(`**${outcome.channel}** — ${outcome.status}`);
    if (outcome.title) lines.push(`  ${outcome.title}`);
    for (const result of outcome.results) lines.push(`  - ${result}`);
    for (const error of outcome.errors) lines.push(`  - :warning: ${error}`);
    lines.push('');
  }
  await summary(lines.join('\n'));

  // Only a total wipeout is worth failing the workflow over. One channel out of four
  // failing is a notification, not a broken pipeline.
  const anyPublished = outcomes.some((o) => o.results.length > 0);
  const allErrored = outcomes.every((o) => o.errors.length > 0 || o.status.startsWith('ERROR'));
  if (!anyPublished && allErrored) process.exitCode = 1;
}

main().catch((error) => {
  log.error('stage failed', { error: error.message });
  console.error(error);
  process.exit(1);
});
