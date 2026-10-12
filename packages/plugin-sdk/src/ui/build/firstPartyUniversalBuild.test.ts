import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

import { buildUniversalPluginUiArtifacts } from './buildUniversalUiArtifacts.js';

const firstPartyArtifactCounts = Object.freeze({
    channels: 2,
    inspector: 1,
    posthog: 2,
    'scm-azure-devops': 2,
    'scm-bitbucket': 2,
    'scm-github': 2,
    'scm-gitlab': 2,
    sentry: 2,
    triage: 5,
});

const firstPartyVoiceArtifactCounts = Object.freeze({
    codex: 1,
    elevenlabs: 1,
    openai: 1,
    xai: 1,
});

describe('first-party universal Plugin UI artifacts', () => {
    it('builds all 20 declared artifacts through the one esbuild compiler', async () => {
        const repositoryRoot = resolve(import.meta.dirname, '../../../../..');
        let total = 0;
        for (const [pluginId, expectedCount] of Object.entries(firstPartyArtifactCounts)) {
            const result = await buildUniversalPluginUiArtifacts(
                resolve(repositoryRoot, 'packages/plugins', pluginId),
            );
            expect(result.manifest.version).toBe(2);
            expect(result.manifest.entries).toHaveLength(expectedCount);
            expect(result.manifest.entries.every((entry) => (
                entry.tier === 'reactNative'
                && entry.files.length === 1
                && entry.entry.endsWith('/entry.cjs.bundle')
                && entry.builtWith.bundler === 'esbuild'
            ))).toBe(true);
            total += result.manifest.entries.length;
        }
        expect(total).toBe(20);
    }, 120_000);

    it.each(Object.entries(firstPartyVoiceArtifactCounts))('builds %s client voice activation through the same compiler', async (pluginId, expectedCount) => {
        const repositoryRoot = resolve(import.meta.dirname, '../../../../..');
        const sourcePackages = ['plugin-sdk', 'protocol', 'agents', 'cli-common', 'triage-protocol'];
        // Repository test tooling is outside the SDK compilation root. Load
        // its existing resolver at the test-runner boundary, not into SDK emit.
        const { resolveWorkspacePackageSource }: {
            resolveWorkspacePackageSource: (
                specifier: string, packageName: string, sourceRoot: string,
                options: Readonly<{ exportConditions: readonly string[] }>,
            ) => string | null;
        } = await import(resolve(repositoryRoot, 'scripts/testing/vitestWorkspacePackageResolution.ts'));
        const result = await buildUniversalPluginUiArtifacts(
            resolve(repositoryRoot, 'packages/plugins', pluginId),
            undefined,
            {
                exportConditions: ['happier-source'],
                resolveSourceImport: (specifier) => {
                    for (const packageName of sourcePackages) {
                        const source = resolveWorkspacePackageSource(
                            specifier, `@happier-dev/${packageName}`,
                            resolve(repositoryRoot, 'packages', packageName, 'src'),
                            { exportConditions: ['happier-source'] },
                        );
                        if (source) return source;
                    }
                    return undefined;
                },
            },
        );
        expect(result.manifest.entries).toHaveLength(expectedCount);
        const artifact = result.manifest.entries[0]!;
        expect(artifact).toMatchObject({
            tier: 'reactNative',
            executable: { exports: ['activate'] },
        });
        const bytes = await readFile(resolve(result.artifactsRoot, artifact.entry), 'utf8');
        for (const platform of ['web', 'ios', 'android']) {
            // Evaluate the actual published CommonJS graph. Only the native
            // platform module is a host boundary; provider/SDK internals stay real.
            const module = { exports: {} as Record<string, unknown> };
            new Function('module', 'exports', 'require', bytes)(module, module.exports, (specifier: string) => {
                if (specifier === 'react-native') return { Platform: { OS: platform } };
                throw new Error(`Unexpected host dependency: ${specifier}`);
            });
            const activate = module.exports.activate;
            expect(activate).toBeTypeOf('function');
            if (typeof activate !== 'function') throw new Error('voice_activation_missing');
            const register = vi.fn();
            activate({ voiceProviders: { register } });
            expect(register.mock.calls).toEqual([[expect.any(String), expect.objectContaining({
                kind: 'conversation',
                microphoneMode: pluginId === 'elevenlabs' ? 'provider_managed' : pluginId === 'xai' ? 'host_pcm' : 'host_webrtc',
            })]]);
            if (pluginId === 'elevenlabs' && platform === 'web') {
                // Exercise Start in the actual CommonJS graph. Only host media,
                // browser permissions and the vendor socket are boundaries.
                const runtime: unknown = register.mock.calls[0]?.[1];
                if (!runtime || typeof runtime !== 'object'
                    || !('createConnection' in runtime) || typeof runtime.createConnection !== 'function') {
                    throw new Error('voice_connection_factory_missing');
                }
                let open: (() => Promise<void>) | undefined;
                const vendorBoundary = Object.assign(new Error('vendor socket boundary'), {
                    code: 'voice_test_vendor_socket_boundary',
                });
                vi.stubGlobal('WebSocket', class { constructor() { throw vendorBoundary; } });
                vi.stubGlobal('navigator', {
                    userAgent: 'Voice artifact web test',
                    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
                });
                try {
                    await Reflect.apply(runtime.createConnection, runtime, [{
                        session: { config: { agentId: 'artifact-web-agent', connectionType: 'websocket', useWakeLock: false } },
                        tools: [], execution: { kind: 'direct_media' }, interruption: { duckGain: 0.3 },
                        media: {
                            createSdkHandleConnection({ driver }: {
                                driver: { open(input: {
                                    signal: AbortSignal; onControl(event: unknown): void;
                                    onTransport(event: unknown): void; onRemoteClose(reason: string): void;
                                }): Promise<void> };
                            }) {
                                open = () => driver.open({
                                    signal: new AbortController().signal,
                                    onControl() {}, onTransport() {}, onRemoteClose() {},
                                });
                                return { close: async () => {} };
                            },
                        },
                    }]);
                    if (!open) throw new Error('voice_media_driver_missing');
                    await expect(open()).rejects.toMatchObject({ code: vendorBoundary.code });
                } finally {
                    vi.unstubAllGlobals();
                }
            }
        }
    }, 120_000);
});
