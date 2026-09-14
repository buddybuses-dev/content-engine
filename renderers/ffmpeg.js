// ffmpeg renderer — fully automated vertical video from b-roll + TTS + burned captions.
//
// Runs on a GitHub Actions ubuntu runner (ffmpeg is preinstalled) and on station D.
// It is deliberately simple: one background clip, one voice track, one caption layer.
// A predictable 40-second video that ships every day beats an elaborate one that
// needs a human every time.
//
// Requires: media/broll/*.mp4 (your own or licensed stock), ELEVENLABS_* credentials.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { listInputs, outputDir } from '../lib/media.js';
import { synthesize } from '../lib/tts.js';
import { optional } from '../lib/env.js';
import { logger } from '../lib/log.js';

const run = promisify(execFile);
const log = logger('render:ffmpeg');

export const name = 'ffmpeg';

const WIDTH = 1080;
const HEIGHT = 1920;

async function probeDurationSec(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ]);
  const seconds = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(seconds)) throw new Error(`Could not read duration of ${file}`);
  return seconds;
}

/**
 * Deterministic pick, so re-running an item reproduces the same video.
 * The channel's own clips come first, then the shared pool.
 */
async function pickBroll(item) {
  const files = await listInputs('broll', item.channel, /\.(mp4|mov|m4v)$/i);
  if (files.length === 0) {
    throw new Error(
      `No b-roll for "${item.channel}". Add a vertical clip you have the rights to use to ` +
        `media/broll/${item.channel}/ (this channel only) or media/broll/ (shared by all channels).`,
    );
  }
  const hash = createHash('sha256').update(item.id).digest();
  return files[hash.readUInt32BE(0) % files.length];
}

async function pickMusic(item) {
  const files = await listInputs('music', item.channel, /\.(mp3|m4a|wav)$/i);
  return files[0] ?? null;
}

/**
 * Caption track from the script beats. Timings come from the beat durations, then get
 * scaled to the real voiceover length so text never runs past the audio.
 */
function buildSrt(item, actualDurationSec) {
  const beats = item.script.beats;
  const planned = beats.reduce((total, beat) => total + (beat.seconds ?? 0), 0) || actualDurationSec;
  const scale = actualDurationSec / planned;

  const pad = (n, width = 2) => String(Math.floor(n)).padStart(width, '0');
  const stamp = (seconds) => {
    const ms = Math.round((seconds - Math.floor(seconds)) * 1000);
    return `${pad(seconds / 3600)}:${pad((seconds / 60) % 60)}:${pad(seconds % 60)},${pad(ms, 3)}`;
  };

  let cursor = 0;
  return beats
    .map((beat, index) => {
      const start = cursor;
      cursor += (beat.seconds ?? 0) * scale;
      const text = (beat.onScreen || beat.spoken || '').toUpperCase();
      return `${index + 1}\n${stamp(start)} --> ${stamp(Math.min(cursor, actualDurationSec))}\n${text}\n`;
    })
    .join('\n');
}

export async function render(item) {
  const outDir = await outputDir(item.channel);

  const voicePath = join(outDir, `${item.id}.mp3`);
  const srtPath = join(outDir, `${item.id}.srt`);
  const videoPath = join(outDir, `${item.id}.mp4`);

  await synthesize(item.script.voiceover, voicePath, item.channel);
  const durationSec = await probeDurationSec(voicePath);
  log.info('voiceover length', { channel: item.channel, id: item.id, durationSec: durationSec.toFixed(1) });

  await writeFile(srtPath, buildSrt(item, durationSec), 'utf8');

  const broll = await pickBroll(item);
  const music = await pickMusic(item);
  const musicVolume = optional('MUSIC_VOLUME', '0.08');
  const fontSize = optional('CAPTION_FONT_SIZE', '64');

  // Background: loop the clip, fill 1080x1920 by cover-cropping, burn in captions.
  const videoFilter = [
    `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase`,
    `crop=${WIDTH}:${HEIGHT}`,
    'setsar=1',
    `subtitles='${srtPath.replace(/'/g, "'\\\\''")}':force_style='FontName=DejaVu Sans,Fontsize=${fontSize},Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=4,Shadow=0,Alignment=2,MarginV=260'`,
  ].join(',');

  const args = [
    '-y',
    '-stream_loop', '-1', '-i', broll,
    '-i', voicePath,
  ];
  if (music) args.push('-stream_loop', '-1', '-i', music);

  args.push('-filter_complex');
  if (music) {
    args.push(
      `[0:v]${videoFilter}[v];[2:a]volume=${musicVolume}[bed];[1:a][bed]amix=inputs=2:duration=first:dropout_transition=0[a]`,
    );
    args.push('-map', '[v]', '-map', '[a]');
  } else {
    args.push(`[0:v]${videoFilter}[v]`);
    args.push('-map', '[v]', '-map', '1:a');
  }

  args.push(
    '-t', String(durationSec),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-r', '30',
    '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart',
    videoPath,
  );

  log.info('encoding', { id: item.id, broll, music: music ?? 'none' });
  await run('ffmpeg', args, { maxBuffer: 32 * 1024 * 1024 });

  await unlink(srtPath).catch(() => {});
  return { videoPath, renderer: name, durationSec: Math.round(durationSec), broll, voicePath };
}

export function waitingHint() {
  return 'ffmpeg renderer produces on demand; nothing to wait for.';
}
