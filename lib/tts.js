// Voiceover generation. One provider today, behind an interface, because the voice is
// the single most brand-defining choice on the channel and swapping it should not
// touch the renderer.

import { writeFile } from 'node:fs/promises';
import { optional } from './env.js';
import { channelEnv, requireChannelEnv } from './channels.js';
import { request } from './http.js';
import { logger } from './log.js';

const log = logger('tts');

// The voice is the most recognisable thing about a channel, so it resolves per channel.
// Four channels sharing one voice would make them sound like one channel with four names.
// The API key is usually shared; the voice id should not be.
export async function synthesize(text, outputPath, channelSlug) {
  const provider = optional('TTS_PROVIDER', 'elevenlabs');
  if (provider !== 'elevenlabs') {
    throw new Error(`Unsupported TTS_PROVIDER "${provider}". Supported: elevenlabs.`);
  }

  const apiKey = requireChannelEnv('ELEVENLABS_API_KEY', channelSlug);
  const voiceId = requireChannelEnv('ELEVENLABS_VOICE_ID', channelSlug);
  const modelId = channelEnv('ELEVENLABS_MODEL_ID', channelSlug) ?? 'eleven_multilingual_v2';

  const response = await request(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true },
      }),
      timeoutMs: 180_000,
    },
  );

  const audio = Buffer.from(await response.arrayBuffer());
  await writeFile(outputPath, audio);
  log.info('voiceover written', { channel: channelSlug, outputPath, bytes: audio.length });
  return outputPath;
}
