import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const providerWrites = vi.hoisted((): {
  destination: string; remaining: number; permissionRefused: boolean; onRace: (() => void) | null;
} => ({ destination: '', remaining: 0, permissionRefused: false, onRace: null }));

// The OS rename boundary races a real provider recreating its native state directory.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    if (String(args[0]).includes('.happier-link-') && String(args[1]) === providerWrites.destination
      && providerWrites.permissionRefused) throw Object.assign(new Error('Permission refused'), { code: 'EPERM' });
    if (String(args[0]).includes('.happier-link-') && String(args[1]) === providerWrites.destination
      && providerWrites.remaining-- > 0) {
      await actual.mkdir(args[1], { recursive: true });
      await actual.writeFile(`${String(args[1])}/provider-history.jsonl`, 'late provider state');
      providerWrites.onRace?.();
    }
    return await actual.rename(...args);
  } };
});

import { applyConnectedServiceStateSharingDescriptor } from './applyConnectedServiceStateSharingDescriptor';

const descriptor: Parameters<typeof applyConnectedServiceStateSharingDescriptor>[0]['descriptor'] = {
  providerId: 'codex', providerSupportStatus: 'supported',
  config: { supported: true, modes: ['isolated'], entries: [] },
  state: { supported: true, modes: ['shared'], entries: [{ path: 'sessions', mode: 'linked' }],
    symlinkUnavailableDegradePolicy: 'degrade_to_isolated' },
  authIsolation: { mode: 'materialized_home', secretEntries: ['auth.json'] },
};

describe('shared state link promotion', () => {
  it('propagates containing materialization cancellation during a recreated-directory race', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-state-promotion-cancellation-'));
    const controller = new AbortController();
    try {
      const sourceRoot = join(root, 'native');
      const targetRoot = join(root, 'materialized');
      await mkdir(join(sourceRoot, 'sessions'), { recursive: true });
      await mkdir(targetRoot);
      await writeFile(join(sourceRoot, 'sessions', 'retained.jsonl'), 'native history');
      providerWrites.destination = join(targetRoot, 'sessions');
      providerWrites.remaining = 6;
      providerWrites.onRace = () => controller.abort();
      const input = {
        descriptor, nativeSourceContext: { sourceRoot, sourceEnv: {} },
        target: { targetMaterializedRoot: targetRoot, targetMaterializedEnv: {} },
        configMode: 'isolated' as const, requestedStateMode: 'shared' as const, effectiveStateMode: 'shared' as const,
        cwd: root, signal: controller.signal,
      };
      await expect(applyConnectedServiceStateSharingDescriptor(input)).rejects.toMatchObject({ name: 'AbortError' });
      expect(await readFile(join(sourceRoot, 'sessions', 'retained.jsonl'), 'utf8')).toBe('native history');
    } finally {
      providerWrites.destination = '';
      providerWrites.remaining = 0;
      providerWrites.onRace = null;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves provider writes and completes after more than three promotion races', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-state-many-promotion-races-'));
    try {
      const sourceRoot = join(root, 'native');
      const targetRoot = join(root, 'materialized');
      await mkdir(join(sourceRoot, 'sessions'), { recursive: true });
      await mkdir(targetRoot);
      await writeFile(join(sourceRoot, 'sessions', 'retained.jsonl'), 'native history');
      providerWrites.destination = join(targetRoot, 'sessions');
      providerWrites.remaining = 6;
      await applyConnectedServiceStateSharingDescriptor({
        descriptor,
        nativeSourceContext: { sourceRoot, sourceEnv: {} },
        target: { targetMaterializedRoot: targetRoot, targetMaterializedEnv: {} },
        configMode: 'isolated', requestedStateMode: 'shared', effectiveStateMode: 'shared', cwd: root,
      });
      expect(await realpath(join(targetRoot, 'sessions'))).toBe(await realpath(join(sourceRoot, 'sessions')));
      expect(await readFile(join(sourceRoot, 'sessions', 'retained.jsonl'), 'utf8')).toBe('native history');
      const displaced = (await readdir(targetRoot)).filter((entry) => entry.startsWith('sessions.local-'));
      expect(displaced).toHaveLength(6);
      for (const entry of displaced) {
        expect(await readFile(join(targetRoot, entry, 'provider-history.jsonl'), 'utf8')).toBe('late provider state');
      }
    } finally {
      providerWrites.destination = '';
      providerWrites.remaining = 0;
      providerWrites.permissionRefused = false;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('surfaces permanent permission refusal without retrying it as a recreated directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-state-promotion-permission-'));
    try {
      const sourceRoot = join(root, 'native');
      const targetRoot = join(root, 'materialized');
      await mkdir(join(sourceRoot, 'sessions'), { recursive: true });
      await mkdir(targetRoot);
      await writeFile(join(sourceRoot, 'sessions', 'retained.jsonl'), 'native history');
      providerWrites.destination = join(targetRoot, 'sessions');
      providerWrites.permissionRefused = true;
      await expect(applyConnectedServiceStateSharingDescriptor({
        descriptor, nativeSourceContext: { sourceRoot, sourceEnv: {} },
        target: { targetMaterializedRoot: targetRoot, targetMaterializedEnv: {} },
        configMode: 'isolated', requestedStateMode: 'shared', effectiveStateMode: 'shared', cwd: root,
      })).rejects.toMatchObject({ code: 'EPERM' });
      expect(await readFile(join(sourceRoot, 'sessions', 'retained.jsonl'), 'utf8')).toBe('native history');
    } finally {
      providerWrites.destination = '';
      providerWrites.permissionRefused = false;
      await rm(root, { recursive: true, force: true });
    }
  });
});
