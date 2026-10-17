import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderHook } from '@/dev/testkit';
import { useNativeModelPackState } from './useNativeModelPackState.native';

const boundary = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  failDelete: false,
  fetch: vi.fn<typeof fetch>(),
  alert: vi.fn<typeof import('react-native')['Alert']['alert']>(),
}));

// OS dialogs, network and device files are boundaries; the hook and installer stay real.
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock(
    { platformOS: 'android' }, { Alert: { alert: boundary.alert } }));
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo/fetch', () => ({ fetch: boundary.fetch }));
vi.mock('expo-file-system', () => {
  const uri = (parts: Array<string | { uri: string }>) =>
    parts.map(part => (typeof part === 'string' ? part : part.uri).replace(/\/$/, '')).join('/');
  return {
    Paths: { document: 'file:///docs' },
    Directory: class {
      uri: string;
      constructor(...parts: Array<string | { uri: string }>) { this.uri = uri(parts); }
      get exists() { return [...boundary.files.keys()].some(path => path.startsWith(`${this.uri}/`)); }
      get size() {
        return [...boundary.files].reduce((bytes, [path, data]) =>
          bytes + (path.startsWith(`${this.uri}/`) ? data.length : 0), 0);
      }
      create() {}
      delete() {
        if (boundary.failDelete) throw new Error('storage_delete_failed');
        for (const path of boundary.files.keys()) if (path.startsWith(`${this.uri}/`)) boundary.files.delete(path);
      }
    },
    File: class {
      uri: string;
      constructor(...parts: Array<string | { uri: string }>) { this.uri = uri(parts); }
      get exists() { return boundary.files.has(this.uri); }
      async text() { return new TextDecoder().decode(boundary.files.get(this.uri)); }
    },
  };
});

const root = 'file:///docs/happier/voice';
const packId = 'cancellation-test';
const manifest = (hash: string) => ({
  packId, kind: 'stt_sherpa', model: 'zipformer', version: '1',
  files: [{ path: 'model.bin', url: 'https://example.test/model.bin', sha256: hash.repeat(64), sizeBytes: 3 }],
});

describe('native model pack cancellation through device storage', () => {
  beforeEach(() => {
    boundary.files.clear();
    boundary.failDelete = false;
    boundary.fetch.mockReset();
    boundary.alert.mockReset().mockImplementation((_title, _message, buttons) => {
      buttons?.find(button => button.style !== 'cancel')?.onPress?.();
    });
  });

  it.each(['prepare', 'update'] as const)('reports storage failure while cancelling %s and refreshes disk state', async operation => {
    const installed = operation === 'update';
    const partialFile = installed
      ? `${root}/modelPackUpdates/${packId}/model.bin`
      : `${root}/modelPacks/${packId}/model.bin`;
    boundary.files.set(partialFile, new Uint8Array([1, 2, 3]));
    if (installed) {
      boundary.files.set(`${root}/modelPacks/${packId}/pack.json`,
        new TextEncoder().encode(JSON.stringify({ manifest: manifest('a') })));
      boundary.files.set(`${root}/modelPacks/${packId}/model.bin`, new Uint8Array([9, 9, 9]));
      boundary.fetch.mockResolvedValueOnce(Response.json(manifest('b')));
    }
    const requested = createDeferred<void>();
    boundary.fetch.mockImplementation((_url, options) => new Promise<Response>((_resolve, reject) => {
      const signal = options?.signal;
      if (!signal) throw new Error('Expected installer cancellation signal');
      requested.resolve();
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const hook = await renderHook(useNativeModelPackState, { initialProps: {
      role: 'stt' as const, packId, manifestUrl: 'https://example.test/manifest.json',
    } });
    await act(async () => {
      if (installed) hook.getCurrent().checkForUpdates();
      else void hook.getCurrent().prepareModel();
      await requested.promise;
    });
    expect(hook.getCurrent().modelStatus).toBe('downloading');
    // The retained-byte count must be refreshed after the cleanup failure.
    boundary.files.set(partialFile, new Uint8Array([1, 2, 3, 4]));
    boundary.failDelete = true;
    await act(async () => { hook.getCurrent().cancelPrepare(); });
    await vi.waitFor(() => expect(boundary.alert.mock.calls.some(call =>
      String(call[1]).includes('storage_delete_failed'))).toBe(true));
    expect(hook.getCurrent().installed).toBe(installed);
    expect(hook.getCurrent().installSummary?.partialBytes).toBe(installed ? 0 : 4);
    expect(hook.getCurrent().modelStatus).toBe(installed ? 'ready' : 'error');
    expect(boundary.files.has(partialFile)).toBe(true);
  });
});
