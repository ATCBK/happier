import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { getDefaultModelPackId, parseModelPackManifest } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { normalizeVoiceFixtureTranscript, readVoiceFixture } from '../../../../../../packages/tests/src/testkit/voice/voiceFixture';

import { voiceInferenceRuntimeEngine } from './packagedVoiceInferenceRuntime';

const modelDir = process.env.HAPPIER_ZIPFORMER_MODEL_DIR?.trim() ?? '';
const manifestPath = process.env.HAPPIER_ZIPFORMER_MANIFEST_PATH?.trim() ?? '';
const fixtureRoot = new URL('../../../../../../packages/tests/fixtures/voice/', import.meta.url);
const integrationEnabled = modelDir.length > 0 && manifestPath.length > 0;

describe.runIf(integrationEnabled)('packaged Zipformer runtime integration', () => {
  it('recognizes the complete natural-speech reference and releases the production runtime', async () => {
    const { metadata: fixture } = await readVoiceFixture('natural-librispeech-61-70968-0000-16k');
    if (!fixture.expectedTranscript) throw new Error('natural speech acceptance fixture is missing');
    const fixtureWav = fileURLToPath(new URL(fixture.file, fixtureRoot));
    const manifest = parseModelPackManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
    expect(manifest.packId).toBe('sherpa-onnx-streaming-zipformer-en-2023-06-26');
    expect(manifest.packId).toBe(getDefaultModelPackId('stt_sherpa'));
    const common = {
      packId: manifest.packId,
      packDir: modelDir,
      manifest,
    } as const;

    const warmStartedAt = performance.now();
    await voiceInferenceRuntimeEngine.warmModel(common);
    const warmMs = performance.now() - warmStartedAt;

    try {
      const inferenceStartedAt = performance.now();
      const result = await voiceInferenceRuntimeEngine.transcribeAudio({
        requestId: 'zipformer-real-fixture',
        filePath: fixtureWav,
        inputMimeType: 'audio/wav',
        language: 'en',
        normalization: {
          inputTransport: 'upload_transfer',
          strategy: 'ui_pretranscoded_pcm16_fallback',
          systemFfmpegAllowed: false,
        },
        ...common,
      });
      const inferenceMs = performance.now() - inferenceStartedAt;

      expect(normalizeVoiceFixtureTranscript(result.text)).toBe(normalizeVoiceFixtureTranscript(fixture.expectedTranscript));
      expect(warmMs).toBeGreaterThan(0);
      expect(inferenceMs).toBeGreaterThan(0);
    } finally {
      await voiceInferenceRuntimeEngine.releaseModel(common);
    }
  }, 120_000);
});
