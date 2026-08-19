#!/usr/bin/env node
// Health check. Answers one question honestly, per channel: is this channel actually
// going to publish something in the next 24 hours, or has it quietly stalled?
//
// A stalled 24/7 pipeline that reports nothing is worse than one that is obviously
// broken, so this exits non-zero when a live channel is about to go dark.
//
// A disabled channel is never a problem — it is a decision. Only channels with
// `enabled: true` are held to the standard.

import { countItems, listItems, STAGE_ORDER } from '../lib/store.js';
import { loadPlatforms } from '../lib/config.js';
import { loadChannels, channelPlatforms, channelEnv, envSuffix } from '../lib/channels.js';
import { optional } from '../lib/env.js';
import { logger, summary } from '../lib/log.js';

const log = logger('health');

const CREDENTIALS = {
  youtube: ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REFRESH_TOKEN'],
  instagram: ['INSTAGRAM_USER_ID', 'INSTAGRAM_ACCESS_TOKEN'],
  tiktok: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'TIKTOK_REFRESH_TOKEN'],
};

async function inspect(channel, platformSpecs) {
  const slug = channel.slug;
  const depth = {};
  for (const stage of [...STAGE_ORDER, 'failed']) {
    depth[stage] = await countItems(slug, stage);
  }

  const problems = [];
  const notes = [];

  // A staged channel is not failing at anything — it just has not been switched on.
  // Report the same gaps so you can see what going live would need, but never in
  // language that implies something broke.
  const live = channel.enabled !== false;

  const perDay = channel.cadence?.postsPerDay ?? 2;
  const runway = depth.ready / perDay;
  if (depth.ready === 0) {
    problems.push(
      live
        ? 'nothing ready to publish — this channel goes dark at its next slot'
        : 'no videos queued yet',
    );
  } else if (runway < 2) {
    notes.push(`${runway.toFixed(1)} days of runway in 04-ready`);
  }

  const products = (channel.sources?.manualProducts ?? []).filter((p) => p.enabled !== false);
  if (products.length === 0) {
    problems.push(
      live
        ? 'no enabled products in sources.manualProducts — nothing to make videos about'
        : 'no products added yet',
    );
  }

  for (const platform of channelPlatforms(channel, platformSpecs)) {
    const missing = (CREDENTIALS[platform] ?? []).filter((key) => !channelEnv(key, slug));
    if (missing.length) {
      problems.push(
        `${platform}: missing ${missing.map((k) => `${k}_${envSuffix(slug)}`).join(', ')}`,
      );
    }
  }

  if (depth.failed > 0) {
    const failed = await listItems(slug, 'failed');
    notes.push(
      `${depth.failed} in triage: ${failed.slice(0, 3).map((i) => `${i.id} (${i.error?.reason})`).join(', ')}`,
    );
  }

  return { slug, name: channel.channel.name, enabled: channel.enabled !== false, depth, problems, notes };
}

async function main() {
  const [channels, platformSpecs] = await Promise.all([loadChannels(), loadPlatforms()]);
  const reports = [];
  for (const channel of channels) {
    reports.push(await inspect(channel, platformSpecs));
  }

  const lines = ['### Pipeline health', ''];

  lines.push('| Channel | | brief | script | render | ready | published | failed |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const r of reports) {
    const mark = r.enabled ? 'live' : 'off';
    lines.push(
      `| ${r.name} | ${mark} | ${r.depth.brief} | ${r.depth.script} | ${r.depth.render} | ${r.depth.ready} | ${r.depth.published} | ${r.depth.failed} |`,
    );
  }
  lines.push('');

  // Only live channels can block. A staged channel with no credentials is expected.
  const blocking = reports.filter((r) => r.enabled && r.problems.length > 0);

  if (!optional('ANTHROPIC_API_KEY')) {
    lines.push('**Blocking (global):**', '- :x: ANTHROPIC_API_KEY is not set — no scripts can be written', '');
    log.error('ANTHROPIC_API_KEY is not set');
  }

  for (const r of reports) {
    if (r.problems.length === 0 && r.notes.length === 0) continue;
    lines.push(`**${r.name}**${r.enabled ? '' : ' _(staged, not live)_'}`);
    for (const p of r.problems) lines.push(`- ${r.enabled ? ':x:' : ':white_circle:'} ${p}`);
    for (const n of r.notes) lines.push(`- ${n}`);
    lines.push('');
  }

  if (blocking.length === 0 && optional('ANTHROPIC_API_KEY')) {
    lines.push(':white_check_mark: No blocking problems on live channels.');
  }

  const report = lines.join('\n');
  console.log(report);
  await summary(report);

  for (const r of blocking) {
    for (const p of r.problems) log.error(`${r.slug}: ${p}`);
  }
  if (blocking.length > 0 || !optional('ANTHROPIC_API_KEY')) process.exit(1);
}

main().catch((error) => {
  log.error('health check crashed', { error: error.message });
  console.error(error);
  process.exit(1);
});
