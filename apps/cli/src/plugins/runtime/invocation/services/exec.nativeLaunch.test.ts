import { describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PluginError } from '@happier-dev/plugin-sdk';

import { authorizePluginExecLaunchForHost, authorizeResolvedAgentNativeExecLaunchForHost,
    createStablePluginExecService, issueAgentNativeLaunchQualifierForHost,
    type HostAgentNativeLaunchPreparation } from './exec';
import { withTempDir } from '@/testkit/fs/tempDir';

const executable = Object.freeze({ kind: 'systemTool', id: 'fixture.node' } as const);

describe('host-issued Agent native launch qualifier', () => {
    it('refuses a forged native launch qualifier before resolving or launching a process', async () => {
        const resolveExecutable = vi.fn(async () => ({ command: process.execPath }));
        const service = createStablePluginExecService({
            allowedExecutables: [executable], signal: new AbortController().signal,
            isOccurrenceCurrent: () => true, resolveExecutable,
            resolvePath: async () => process.cwd(),
        });
        // JavaScript plugins may pass arbitrary values despite the opaque SDK type.
        const options = { signal: new AbortController().signal, nativeLaunch: Object.freeze({ purpose: 'agent' }) };
        // @ts-expect-error A forged object is deliberately not a host-issued token.
        await expect(service.run({ executable, args: ['-e', 'process.stdout.write("forged")'] }, options))
            .rejects.toMatchObject({ code: 'plugin_exec_native_launch_qualifier_invalid' });
        expect(resolveExecutable).not.toHaveBeenCalled();
    });

    it('keeps ordinary tools and probes nonactivating and binds native authority to the exact Exec service', async () => {
        const prepareAgentNativeLaunch = vi.fn<HostAgentNativeLaunchPreparation>(async () => ({
            projectLaunch: { status: 'refused', kind: 'approval_pending', code: 'project_setup_consent_required' },
        }));
        const create = () => createStablePluginExecService({
            allowedExecutables: [executable], signal: new AbortController().signal,
            isOccurrenceCurrent: () => true, resolveExecutable: async () => ({ command: process.execPath }),
            resolvePath: async () => process.cwd(), prepareAgentNativeLaunch,
        });
        const service = create();
        const request = { executable, args: ['-e', 'process.stdout.write("probe")'], purpose: 'cold Agent' };
        const result = await service.run(request);
        expect(new TextDecoder().decode(result.stdout)).toBe('probe');
        expect(prepareAgentNativeLaunch).not.toHaveBeenCalled();
        const foreign = issueAgentNativeLaunchQualifierForHost(create());
        await expect(service.spawn(request, { nativeLaunch: foreign }))
            .rejects.toMatchObject({ code: 'plugin_exec_native_launch_qualifier_invalid' });
        expect(prepareAgentNativeLaunch).not.toHaveBeenCalled();
        await expect(service.spawn(request, { nativeLaunch: issueAgentNativeLaunchQualifierForHost(service) }))
            .rejects.toMatchObject({ code: 'project_setup_consent_required' });
        await expect(service.clients.spawn({ kind: 'jsonStream', launch: request, maxFrameBytes: 1024 },
            { nativeLaunch: issueAgentNativeLaunchQualifierForHost(service) }))
            .rejects.toMatchObject({ code: 'project_setup_consent_required' });
    });

    it('produces native environment before capturing the complete authorized tuple and preserves release custody', async () => {
        await withTempDir('native qualifier root ', async root => {
            await writeFile(join(root, 'mise.toml'), '[env]\nKEEP = "native"\n');
            const release = vi.fn();
            const nativeRun = vi.fn(async () => ({ exitCode: 0, stdout: 'KEEP=native\0NATIVE=ready\0' }));
            const prepareAgentNativeLaunch = vi.fn<HostAgentNativeLaunchPreparation>(async (_signal, cwd, env) => {
                expect(cwd).toBe(root);
                expect(env).toMatchObject({ REMOVE: 'old', KEEP: 'request' });
                return { projectLaunch: { status: 'ready', reviewedEffectDigest: 'effect-current', environment: {
                    selection: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' }, platform: 'linux',
                    io: { resolveTool: async () => ({ executablePath: '/native/mise', version: '2026.10.4' }), run: nativeRun },
                } } };
            });
            const service = createStablePluginExecService({
                allowedExecutables: [executable], allowedEnvKeys: ['REMOVE'], environment: { REMOVE: 'old' },
                signal: new AbortController().signal, isOccurrenceCurrent: () => true,
                resolveExecutable: async () => ({ command: process.execPath, args: ['--installed'], release }),
                resolvePath: async () => root, prepareAgentNativeLaunch,
            });
            const launch = await authorizePluginExecLaunchForHost(service, {
                executable, args: ['--session', 'spaces "quotes" \\'], cwd: { root: 'workspace', relativePath: '' },
                env: { KEEP: 'request' }, stdin: new Uint8Array([0, 255]), timeoutMs: 9876,
                maxStdoutBytes: 1000, maxStderrBytes: 2000,
            }, { nativeLaunch: issueAgentNativeLaunchQualifierForHost(service) });
            expect(launch).toMatchObject({ command: process.execPath,
                args: ['--installed', '--session', 'spaces "quotes" \\'], cwd: root,
                env: { KEEP: 'native', NATIVE: 'ready' }, stdin: new Uint8Array([0, 255]),
                timeoutMs: 9876, maxStdoutBytes: 1000, maxStderrBytes: 2000 });
            expect(launch.env).not.toHaveProperty('REMOVE');
            expect(nativeRun).toHaveBeenCalledOnce();
            await launch.release(); await launch.release();
            expect(release).toHaveBeenCalledOnce();
        });
    });

    it('releases a resolved native tuple when preparation retires its invocation', async () => {
        const controller = new AbortController();
        const release = vi.fn();
        const service = createStablePluginExecService({
            allowedExecutables: [executable], signal: controller.signal, isOccurrenceCurrent: () => true,
            resolveExecutable: async () => ({ command: process.execPath }), resolvePath: async () => process.cwd(),
            prepareAgentNativeLaunch: async () => { controller.abort(); return undefined; },
        });
        await expect(authorizeResolvedAgentNativeExecLaunchForHost(service, {
            command: process.execPath, args: [], env: {}, release,
        })).rejects.toMatchObject({ code: 'plugin_exec_aborted' });
        expect(release).toHaveBeenCalledOnce();
    });

    it('fails closed when a recognized qualifier has no host preparation owner', async () => {
        const resolveExecutable = vi.fn(async () => ({ command: process.execPath }));
        const service = createStablePluginExecService({
            allowedExecutables: [executable], signal: new AbortController().signal, isOccurrenceCurrent: () => true,
            resolveExecutable, resolvePath: async () => process.cwd(),
        });
        const nativeLaunch = issueAgentNativeLaunchQualifierForHost(service);
        await expect(service.spawn({ executable }, { nativeLaunch }))
            .rejects.toMatchObject({ code: 'plugin_exec_native_launch_unavailable' });
        expect(resolveExecutable).not.toHaveBeenCalled();
        const release = vi.fn();
        await expect(authorizeResolvedAgentNativeExecLaunchForHost(service,
            { command: process.execPath, args: [], env: {}, release }, undefined, nativeLaunch))
            .rejects.toMatchObject({ code: 'plugin_exec_native_launch_unavailable' });
        expect(release).toHaveBeenCalledOnce();
    });

    it('rejects malformed resolved launch input before native preparation', async () => {
        const prepareAgentNativeLaunch = vi.fn<HostAgentNativeLaunchPreparation>(async () => undefined);
        const service = createStablePluginExecService({
            allowedExecutables: [executable], signal: new AbortController().signal, isOccurrenceCurrent: () => true,
            resolveExecutable: async () => ({ command: process.execPath }), resolvePath: async () => process.cwd(), prepareAgentNativeLaunch,
        });
        const release = vi.fn();
        await expect(authorizeResolvedAgentNativeExecLaunchForHost(service,
            { command: process.execPath, args: [], env: {}, cwd: 'relative-root', release }))
            .rejects.toMatchObject({ code: 'plugin_exec_invalid_cwd' });
        expect(prepareAgentNativeLaunch).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledOnce();
    });

    it('refuses changed reviewed inputs after native evaluation and releases the original executable', async () => {
        await withTempDir('native qualifier currentness ', async root => {
            await writeFile(join(root, 'mise.toml'), '[env]\nKEEP = "native"\n');
            let current = true;
            const release = vi.fn();
            const service = createStablePluginExecService({
                allowedExecutables: [executable], signal: new AbortController().signal, isOccurrenceCurrent: () => true,
                resolveExecutable: async () => ({ command: process.execPath, release }), resolvePath: async () => root,
                prepareAgentNativeLaunch: async () => ({ projectLaunch: {
                    status: 'ready', reviewedEffectDigest: 'old-effect',
                    verifyCurrent: async () => { if (!current) throw new PluginError({ code: 'project_setup_effect_changed', message: 'Effect changed' }); },
                    environment: { selection: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' }, platform: 'linux',
                        io: { resolveTool: async () => ({ executablePath: '/native/mise', version: '2026.10.4' }),
                            run: async () => { current = false; return { exitCode: 0, stdout: 'KEEP=native\0' }; } } },
                } }),
            });
            await expect(authorizePluginExecLaunchForHost(service, { executable, cwd: { root: 'workspace', relativePath: '' } },
                { nativeLaunch: issueAgentNativeLaunchQualifierForHost(service) }))
                .rejects.toMatchObject({ code: 'project_setup_effect_changed' });
            expect(release).toHaveBeenCalledOnce();
        });
    });
});
