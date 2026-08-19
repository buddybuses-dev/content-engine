#!/usr/bin/env node
// Stage 5 — MEASURE. Pull performance back onto the items that produced it.
//
// This closes the loop: each channel's sources list decides what gets made, and these
// numbers are the only honest input for changing that decision. Stats are written onto
// the published items and committed, so the history is queryable with git alone.

import { listItems, saveItem } from '../lib/store.js';
import { loadPlatforms } from '../lib/config.js';
import { enabledChannels, channelPlatforms, requireChannelEnv, channelEnv } from '../lib/channels.js';
import { optional } from '../lib/env.js';
import { requestJson } from '../lib/http.js';
import { logger, summary } from '../lib/log.js';

const log = logger('5-stats');
const META_API = `https://graph.facebook.com/${optional('META_API_VERSION', 'v21.0')}`;

async function youtubeToken(channelSlug) {
  const payload = await requestJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: requireChannelEnv('YOUTUBE_CLIENT_ID', channelSlug),
      client_secret: requireChannelEnv('YOUTUBE_CLIENT_SECRET', channelSlug),
      refresh_token: requireChannelEnv('YOUTUBE_REFRESH_TOKEN', channelSlug),
      grant_type: 'refresh_token',
    }),
  });
  return payload.access_token;
}

async function youtubeStats(videoIds, channelSlug) {
  if (videoIds.length === 0) return {};
  const token = await youtubeToken(channelSlug);
  const payload = await requestJson(
    `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videoIds.join(',')}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const out = {};
  for (const video of payload?.items ?? []) {
    out[video.id] = {
      views: Number(video.statistics.viewCount ?? 0),
      likes: Number(video.statistics.likeCount ?? 0),
      comments: Number(video.statistics.commentCount ?? 0),
    };
  }
  return out;
}

async function instagramStats(mediaId, channelSlug) {
  const token = requireChannelEnv('INSTAGRAM_ACCESS_TOKEN', channelSlug);
  const payload = await requestJson(
    `${META_API}/${mediaId}/insights?metric=views,likes,comments,shares,saved&access_token=${encodeURIComponent(token)}`,
  );
  const out = {};
  for (const metric of payload?.data ?? []) {
    out[metric.name] = metric.values?.[0]?.value ?? 0;
  }
  return out;
}

async function collectChannel(channel, platformSpecs) {
  const slug = channel.slug;
  const active = channelPlatforms(channel, platformSpecs);
  const items = await listItems(slug, 'published');
  if (items.length === 0) return { channel: slug, rows: [] };

  // Batch the YouTube lookup — one request for every video beats one per video.
  let ytStats = {};
  const ytIds = items.map((i) => i.publish?.youtube?.remoteId).filter(Boolean);
  if (active.includes('youtube') && ytIds.length && channelEnv('YOUTUBE_REFRESH_TOKEN', slug)) {
    try {
      ytStats = await youtubeStats(ytIds.slice(0, 50), slug);
    } catch (error) {
      log.warn('youtube stats unavailable', { channel: slug, error: error.message });
    }
  }

  const rows = [];
  for (const item of items) {
    const collected = { collectedAt: new Date().toISOString() };

    const ytId = item.publish?.youtube?.remoteId;
    if (ytId && ytStats[ytId]) collected.youtube = ytStats[ytId];

    const igId = item.publish?.instagram?.remoteId;
    if (active.includes('instagram') && igId && channelEnv('INSTAGRAM_ACCESS_TOKEN', slug)) {
      try {
        collected.instagram = await instagramStats(igId, slug);
      } catch (error) {
        log.warn('instagram insights unavailable', { channel: slug, id: item.id, error: error.message });
      }
    }

    if (Object.keys(collected).length > 1) {
      item.stats = collected;
      await saveItem(item);
      rows.push({
        channel: slug,
        title: item.title,
        youtube: collected.youtube?.views ?? '-',
        instagram: collected.instagram?.views ?? '-',
      });
    }
  }

  return { channel: slug, rows };
}

async function main() {
  const [channels, platformSpecs] = await Promise.all([enabledChannels(), loadPlatforms()]);

  const allRows = [];
  for (const channel of channels) {
    try {
      const { rows } = await collectChannel(channel, platformSpecs);
      allRows.push(...rows);
    } catch (error) {
      log.error('channel failed', { channel: channel.slug, error: error.message });
    }
  }

  if (allRows.length === 0) {
    await summary('### Stats\nNothing published yet.\n');
    return;
  }

  allRows.sort((a, b) => (Number(b.youtube) || 0) - (Number(a.youtube) || 0));
  await summary(
    [
      '### Stats',
      '',
      '| Channel | Video | YouTube views | Instagram views |',
      '| --- | --- | ---: | ---: |',
      ...allRows.slice(0, 25).map((r) => `| ${r.channel} | ${r.title} | ${r.youtube} | ${r.instagram} |`),
      '',
    ].join('\n'),
  );
  log.info('stats collected', { items: allRows.length });
}

main().catch((error) => {
  log.error('stage failed', { error: error.message });
  console.error(error);
  process.exit(1);
});
