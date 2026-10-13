import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createMemFs, createMemNativeDownload } from '@/voice/modelPacks/installerTestFs';
import { ensureModelPackInstalled } from '@/voice/modelPacks/installer.native';

let filesystem: ReturnType<typeof createMemFs>;

// Only Expo's filesystem is substituted; readiness reconciles through the real installer.
vi.mock('expo-file-system', () => ({
  get Directory() { return filesystem.fs.Directory; },
  get File() { return filesystem.fs.File; },
  Paths: { document: 'file:///docs/' },
}));

const { readVoiceDictationNativeModelReadiness } = await import('./voiceDictationNativeModelReadiness.native');

describe('readVoiceDictationNativeModelReadiness (native)', () => {
  beforeEach(() => {
    filesystem = createMemFs();
  });

  it('uses the installer-owned status for the exact selected pack', async () => {
    const bytes = new Uint8Array([1]);
    const manifest = { packId: 'selected-stt-pack', kind: 'stt_sherpa', model: 'zipformer', version: 'v1',
      files: [{ path: 'model.onnx', url: 'https://example.com/model.onnx', sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') }] };
    const fetchImpl: typeof fetch = async (input) => new URL(String(input)).pathname.endsWith('manifest.json')
      ? Response.json(manifest) : new Response(bytes);
    await ensureModelPackInstalled({ packId: manifest.packId, mode: 'download_if_missing',
      manifestUrl: 'https://example.com/manifest.json', timeoutMs: null, signal: new AbortController().signal },
      { fs: filesystem.fs, fetch: fetchImpl, download: createMemNativeDownload(filesystem.fs, fetchImpl) });

    await expect(readVoiceDictationNativeModelReadiness('selected-stt-pack')).resolves.toBe('ready');
    await expect(readVoiceDictationNativeModelReadiness('another-stt-pack')).resolves.toBe('missing');
  });

  it('reports a selected but uninstalled pack as missing and does not invent a default for no selection', async () => {
    const inspectFile = vi.spyOn(filesystem.fs.File.prototype, 'exists', 'get');
    try {
      await expect(readVoiceDictationNativeModelReadiness('missing-stt-pack')).resolves.toBe('missing');
      const selectedPackReads = inspectFile.mock.calls.length;
      expect(selectedPackReads).toBeGreaterThan(0);
      await expect(readVoiceDictationNativeModelReadiness(null)).resolves.toBe('unknown');
      expect(inspectFile).toHaveBeenCalledTimes(selectedPackReads);
      expect(filesystem.files.size).toBe(0);
    } finally {
      inspectFile.mockRestore();
    }
  });
});
