import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { readOrCreateDeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import { createNativeUsageCaptureStore, type NativeUsageCaptureState } from './nativeUsageCaptureState';

describe('native accounting capture custody', () => {
    it('retains normalized pending and its cursor across restart using device-only custody', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-native-usage-custody-'));
        try {
            const storage = await readOrCreateDeviceLocalSecretStorage({ path: join(directory, 'device.key') });
            const authority = { serverId: 'home', accountId: 'plain-account', machineId: 'machine' };
            const path = join(directory, 'capture.sealed');
            const store = createNativeUsageCaptureStore({ path, authority, storage });
            const state = { v: 1, authority, sources: [{
                sourceId: 'opaque-root', agent: { pluginId: 'happier.agent.claude', localId: 'claude' },
                source: { kind: 'claudeConfig', configDir: directory }, sourceKey: 'private-root', root: directory,
                supported: true, consented: true, cursor: 'completed-record-1', pending: [{
                    nativeSessionId: 'native-session', observedAt: 10,
                    observation: { provider: 'claude', source: 'native', scope: 'turn_delta', key: 'inference', modelId: 'model',
                        tokens: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 5 },
                        cost: null, contextUsedTokens: null, contextWindowTokens: null },
                }],
            }] } satisfies NativeUsageCaptureState;
            await store.save(state);
            const retainedState = { ...state, retiredCaptureMode: 'native', authority: { ...authority, retiredAuthority: true },
                sources: state.sources.map(source => ({ ...source, retiredSource: true,
                    agent: { ...source.agent, retiredAgent: true }, source: { ...source.source, retiredRoot: true },
                    pending: source.pending.map(pending => ({ ...pending, retiredPending: true,
                        observation: { ...pending.observation, retiredObservation: true,
                            tokens: { ...pending.observation.tokens, retiredTokens: 1 } } })) })) };
            await writeFile(path, storage.sealJson({ purpose: 'usage_accounting_capture', value: retainedState }), { mode: 0o600 });
            const restarted = createNativeUsageCaptureStore({ path, authority, storage });
            // Provider-native source JSON is opaque custody, unlike the typed capture fields.
            const openedState = { ...state, sources: state.sources.map(source => ({ ...source,
                source: { ...source.source, retiredRoot: true } })) };
            expect(await restarted.load()).toEqual(openedState);
            await expect(restarted.save(retainedState)).rejects.toThrow();
            const retainedBytes = await readFile(path, 'utf8');
            expect(retainedBytes).not.toContain('native-session');
            expect(retainedBytes).not.toContain(directory);
            await restarted.save({ ...openedState, sources: openedState.sources.map(source => ({ ...source, pending: [] })) });
            expect((await store.load()).sources[0]?.pending).toEqual([]);
            expect(storage.openJson({ purpose: 'usage_accounting_capture', ciphertext: await readFile(path, 'utf8') }))
                .toEqual({ ...openedState, sources: openedState.sources.map(source => ({ ...source, pending: [] })) });
            await expect(createNativeUsageCaptureStore({ path, storage, authority: { ...authority, accountId: 'other' } }).load())
                .rejects.toThrow(/authority/);
            await writeFile(path, 'corrupt-custody', { mode: 0o600 });
            await expect(restarted.load()).rejects.toThrow();
        } finally { await rm(directory, { recursive: true, force: true }); }
    });
});
