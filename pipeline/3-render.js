#!/usr/bin/env node
// Stage 3 — RENDER. Script to finished vertical video, per channel.
//
// A null return from the renderer means "not ready", not "broken": with the manual
// renderer that is the normal state while you are still editing. Only a thrown error
// sends an item to triage.

import { activeRenderer } from '../renderers/index.js';
import { enabledChannels } from '../lib/channels.js';
import { listItems, advance, fail } from '../lib/store.js';
import { isDryRun, optional } from '../lib/env.js';
import { logger, summary } from '../lib/log.js';

const log = logger('3-render');

async function renderChannel(channel, renderer, batchSize) {
  const slug = channel.slug;
  const items = (await listItems(slug, 'render')).slice(0, batchSize);
  if (items.length === 0) return { channel: slug, rendered: 0, waiting: 0, failed: 0 };

  let rendered = 0;
  let waiting = 0;
  let failed = 0;

  for (const item of items) {
    try {
      if (isDryRun()) {
        log.info('DRY_RUN — would render', { channel: slug, id: item.id, renderer: renderer.name });
        continue;
      }

      const media = await renderer.render(item);
      if (!media) {
        waiting += 1;
        log.info('waiting on media', { channel: slug, id: item.id, hint: renderer.waitingHint(item) });
        continue;
      }

      item.media = { ...media, renderedAt: new Date().toISOString() };
      await advance(item, 'ready', `rendered by ${renderer.name}`);
      rendered += 1;
      log.info('rendered', { channel: slug, id: item.id, videoPath: media.videoPath });
    } catch (error) {
      log.error('render failed', { channel: slug, id: item.id, error: error.message });
      await fail(item, 'render error', error);
      failed += 1;
    }
  }

  return { channel: slug, rendered, waiting, failed };
}

async function main() {
  const renderer = activeRenderer();
  const channels = await enabledChannels();
  const batchSize = Number(optional('RENDER_BATCH_SIZE', '3'));

  const results = [];
  for (const channel of channels) {
    try {
      results.push(await renderChannel(channel, renderer, batchSize));
    } catch (error) {
      log.error('channel failed', { channel: channel.slug, error: error.message });
      results.push({ channel: channel.slug, rendered: 0, waiting: 0, failed: 0, note: error.message });
    }
  }

  await summary(
    [
      `### Render (${renderer.name})`,
      '',
      '| Channel | Rendered | Waiting on media | Failed |',
      '| --- | ---: | ---: | ---: |',
      ...results.map((r) => `| ${r.channel} | ${r.rendered} | ${r.waiting} | ${r.failed} |`),
      '',
    ].join('\n'),
  );
}

main().catch((error) => {
  log.error('stage failed', { error: error.message });
  console.error(error);
  process.exit(1);
});
