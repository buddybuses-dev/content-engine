#!/usr/bin/env node
// Stage 2 — SCRIPT. Brief in, shootable script and per-platform captions out.
//
// The platform limits from config/platforms.json are handed to the model as a hard
// spec AND re-checked afterwards. Models drift on character counts; the validator is
// what actually keeps an over-long title from reaching the YouTube API.

import { generateJson } from '../lib/llm.js';
import { loadPlatforms } from '../lib/config.js';
import { enabledChannels, channelPlatforms, findBannedClaims } from '../lib/channels.js';
import { listItems, advance, fail } from '../lib/store.js';
import { isDryRun, optional } from '../lib/env.js';
import { logger, summary } from '../lib/log.js';

const log = logger('2-script');

const scriptSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['hook', 'beats', 'cta', 'voiceover', 'captions'],
  properties: {
    hook: { type: 'string', description: 'First spoken line. Concrete detail or number. Max 12 words.' },
    beats: {
      type: 'array',
      minItems: 2,
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['spoken', 'onScreen', 'seconds'],
        properties: {
          spoken: { type: 'string' },
          onScreen: { type: 'string', description: 'Short caption burned into frame. Max 6 words.' },
          seconds: { type: 'number' },
        },
      },
    },
    cta: { type: 'string', description: 'One line. No urgency language, no fake scarcity.' },
    voiceover: { type: 'string', description: 'The full narration as one continuous block, ready for TTS.' },
    captions: {
      type: 'object',
      additionalProperties: false,
      required: ['youtube', 'instagram', 'tiktok'],
      properties: {
        youtube: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'description', 'tags'],
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
          },
        },
        instagram: {
          type: 'object',
          additionalProperties: false,
          required: ['caption', 'hashtags'],
          properties: {
            caption: { type: 'string' },
            hashtags: { type: 'array', items: { type: 'string' } },
          },
        },
        tiktok: {
          type: 'object',
          additionalProperties: false,
          required: ['caption', 'hashtags'],
          properties: {
            caption: { type: 'string' },
            hashtags: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
};

function buildSystem(channel, platforms) {
  return [
    `You write short-form video scripts for "${channel.channel.name}", a ${channel.channel.language} channel.`,
    `Niche: ${channel.channel.niche}`,
    `Audience: ${channel.channel.audience}`,
    `The channel's promise to the viewer: ${channel.channel.promise}`,
    '',
    `Persona: ${channel.voice.persona}`,
    '',
    'Always:',
    ...channel.voice.do.map((rule) => `- ${rule}`),
    '',
    'Never:',
    ...channel.voice.dont.map((rule) => `- ${rule}`),
    '',
    'Hard limits you must respect exactly:',
    `- YouTube title: <= ${platforms.youtube.titleMaxChars} characters`,
    `- YouTube description: <= ${platforms.youtube.descriptionMaxChars} characters`,
    `- YouTube tags: <= ${platforms.youtube.maxTags} tags`,
    `- Instagram caption: <= ${platforms.instagram.captionMaxChars} characters, <= ${platforms.instagram.maxHashtags} hashtags`,
    `- TikTok caption: <= ${platforms.tiktok.captionMaxChars} characters, <= ${platforms.tiktok.maxHashtags} hashtags`,
    `- Total spoken runtime: between ${platforms.youtube.minDurationSec} and ${platforms.youtube.maxDurationSec} seconds`,
    '',
    'This is affiliate content. Be useful and accurate about what the product is and who',
    'it is not for. Do not invent features, prices, user counts, testimonials or results.',
    'If you do not know something, write around it rather than guessing.',
  ].join('\n');
}

function buildPrompt(item) {
  const { source, brief } = item;
  return [
    'Write one short-form video for this product.',
    '',
    `Product: ${source.name}`,
    source.priceLabel ? `Price: ${source.priceLabel}` : null,
    source.category ? `Category: ${source.category}` : null,
    source.url ? `URL: ${source.url}` : null,
    brief.angleNotes ? `\nMy own notes from vetting it:\n${brief.angleNotes}` : null,
    '',
    'Pick ONE angle and commit to it. The hook must be something a scrolling viewer',
    'would stop for — a specific number, an unexpected constraint, or a named mistake.',
    'The onScreen text is burned into the frame, so keep it short enough to read at a glance.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Post-generation guardrail. Returns a list of human-readable problems. */
function validate(script, channel, platforms, activePlatforms) {
  const problems = [];
  const { captions } = script;

  if (activePlatforms.includes('youtube')) {
    if (captions.youtube.title.length > platforms.youtube.titleMaxChars) {
      problems.push(`YouTube title is ${captions.youtube.title.length} chars (max ${platforms.youtube.titleMaxChars})`);
    }
    if (captions.youtube.description.length > platforms.youtube.descriptionMaxChars) {
      problems.push('YouTube description exceeds limit');
    }
    if (captions.youtube.tags.length > platforms.youtube.maxTags) {
      problems.push(`YouTube has ${captions.youtube.tags.length} tags (max ${platforms.youtube.maxTags})`);
    }
  }
  for (const key of ['instagram', 'tiktok']) {
    if (!activePlatforms.includes(key)) continue;
    const spec = platforms[key];
    const caption = captions[key];
    if (caption.caption.length > spec.captionMaxChars) problems.push(`${key} caption exceeds ${spec.captionMaxChars} chars`);
    if (caption.hashtags.length > spec.maxHashtags) problems.push(`${key} has ${caption.hashtags.length} hashtags (max ${spec.maxHashtags})`);
  }

  const runtime = script.beats.reduce((total, beat) => total + (beat.seconds ?? 0), 0);
  const maxRuntime = Math.min(
    ...activePlatforms.map((p) => platforms[p].maxDurationSec).filter(Number.isFinite),
  );
  if (runtime > maxRuntime) problems.push(`Script runs ${runtime}s, longest allowed is ${maxRuntime}s`);

  const allText = [script.hook, script.voiceover, script.cta, ...Object.values(captions).map((c) => c.caption ?? c.description ?? '')].join(' ');
  const banned = findBannedClaims(allText, channel);
  if (banned.length) problems.push(`Contains banned claim patterns: ${banned.join(', ')}`);

  return problems;
}

/** Disclosure is appended by us, not by the model, so it can never be edited away. */
function appendDisclosure(script, channel, item) {
  if (!channel.compliance?.requireDisclosureWhenAffiliate) return script;
  if (!item.source?.affiliateUrl) return script;
  const note = channel.compliance.affiliateDisclosure;
  script.captions.youtube.description = `${note}\n\n${script.captions.youtube.description}`;
  script.captions.instagram.caption = `${note}\n\n${script.captions.instagram.caption}`;
  script.captions.tiktok.caption = `${note}\n\n${script.captions.tiktok.caption}`;
  return script;
}

async function scriptChannel(channel, platforms, batchSize) {
  const slug = channel.slug;
  const activePlatforms = channelPlatforms(channel, platforms);
  const items = (await listItems(slug, 'brief')).slice(0, batchSize);

  if (items.length === 0) return { channel: slug, written: 0, failed: 0 };

  // Built once per channel: the system prompt is the channel's identity, and keeping
  // it byte-identical across items in a batch is what makes prompt caching pay off.
  const system = buildSystem(channel, platforms);
  let written = 0;
  let failed = 0;

  for (const item of items) {
    try {
      if (isDryRun()) {
        log.info('DRY_RUN — would write script', { channel: slug, id: item.id });
        continue;
      }

      let script = await generateJson({
        system,
        prompt: buildPrompt(item),
        schema: scriptSchema,
        effort: 'high',
      });

      const problems = validate(script, channel, platforms, activePlatforms);
      if (problems.length) {
        // One correction pass. If the model cannot hit its own spec twice, the item
        // is a triage problem, not a retry problem.
        log.warn('script failed validation, requesting correction', { id: item.id, problems });
        script = await generateJson({
          system,
          prompt: `${buildPrompt(item)}\n\nYour previous attempt had these problems. Fix all of them:\n${problems.map((p) => `- ${p}`).join('\n')}`,
          schema: scriptSchema,
          effort: 'high',
        });
        const stillBroken = validate(script, channel, platforms, activePlatforms);
        if (stillBroken.length) {
          await fail(item, 'script validation failed twice', new Error(stillBroken.join('; ')));
          failed += 1;
          continue;
        }
      }

      script = appendDisclosure(script, channel, item);
      item.script = { hook: script.hook, beats: script.beats, cta: script.cta, voiceover: script.voiceover };
      item.captions = script.captions;
      item.plannedDurationSec = script.beats.reduce((t, b) => t + (b.seconds ?? 0), 0);
      await advance(item, 'render', 'script written');
      written += 1;
      log.info('scripted', { channel: slug, id: item.id, seconds: item.plannedDurationSec });
    } catch (error) {
      log.error('scripting failed', { channel: slug, id: item.id, error: error.message });
      await fail(item, 'script generation error', error);
      failed += 1;
    }
  }

  return { channel: slug, written, failed };
}

async function main() {
  const [channels, platforms] = await Promise.all([enabledChannels(), loadPlatforms()]);
  const batchSize = Number(optional('SCRIPT_BATCH_SIZE', '4'));

  const results = [];
  for (const channel of channels) {
    try {
      results.push(await scriptChannel(channel, platforms, batchSize));
    } catch (error) {
      log.error('channel failed', { channel: channel.slug, error: error.message });
      results.push({ channel: channel.slug, written: 0, failed: 0, note: error.message });
    }
  }

  const total = results.reduce((sum, r) => sum + r.written, 0);
  if (total === 0 && results.every((r) => r.failed === 0)) {
    log.info('nothing to script');
  }

  await summary(
    [
      '### Script',
      '',
      '| Channel | Written | Failed | Note |',
      '| --- | ---: | ---: | --- |',
      ...results.map((r) => `| ${r.channel} | ${r.written} | ${r.failed} | ${r.note ?? '—'} |`),
      '',
    ].join('\n'),
  );
}

main().catch((error) => {
  log.error('stage failed', { error: error.message });
  console.error(error);
  process.exit(1);
});
