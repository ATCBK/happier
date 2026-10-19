import { dirname, join, relative } from 'node:path';
import { mkdir, realpath, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExternalSessionsSourceSchema } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import { discoverNativeUsageSourceMetadata, resolveNativeUsageSourceMetadata } from '@/usage/collector/nativeUsageSourceDiscovery';
import { discoverMemoryExternalTranscriptSources } from '@/daemon/memory/externalTranscriptSources';
import { coldConnectedHome } from './configuredSourceMaterializer.coldCatalog.testkit';
import {
    createConfiguredPluginExternalSessionsAdapter,
    resolveConfiguredExternalSessionSourceAtAdmission,
    resolveConfiguredExternalSessionFollowTarget,
} from './configuredSourceMaterializer';

afterEach(() => vi.unstubAllEnvs());

describe('connected-home acquired catalog convergence', () => {
    it.each(['profile', 'service', 'agent', 'root', 'state'] as const)('checks physical %s custody before the registered Codex contribution reads', async level => {
        const fixture = await coldConnectedHome();
        try {
            const ancestors = { agent: dirname(fixture.homePath), profile: dirname(dirname(fixture.homePath)),
                service: dirname(dirname(dirname(fixture.homePath))),
                root: dirname(dirname(dirname(dirname(fixture.homePath)))), state: join(fixture.homePath, 'sessions') };
            const redirected = ancestors[level];
            const outside = join(fixture.runtime.happyHomeDir, `relocated-${level}`);
            await rename(redirected, outside);
            await symlink(outside, redirected, process.platform === 'win32' ? 'junction' : 'dir');
            const composition = await createConfiguredPluginExternalSessionsAdapter(fixture.input);
            try {
                if (level === 'root' || level === 'state') {
                    expect(composition.sourceRefusals).toEqual([]);
                    const catalogEntry = await fixture.input.resolveCatalogEntry('codex');
                    const admitted = await resolveConfiguredExternalSessionSourceAtAdmission({ ...fixture.input,
                        agentId: 'codex', source: fixture.source, catalogEntry });
                    if (!admitted.ok) throw new Error('Expected admitted relocated home');
                    expect(await composition.compositionPort.resolveSourceIdentity({ agentId: 'codex',
                        remoteSessionId: fixture.remoteSessionId, boundSource: admitted.source }))
                        .toMatchObject({ status: 'resolved' });
                } else {
                    expect(composition.sourceRefusals.some(row => row.code === 'malformed_source')).toBe(true);
                    expect(await composition.compositionPort.resolveSourceIdentity({ agentId: 'codex',
                        remoteSessionId: fixture.remoteSessionId, boundSource: fixture.source }))
                        .not.toMatchObject({ status: 'resolved' });
                }
            } finally { composition.dispose(); }
        } finally { await fixture.runtime.dispose(); }
    });
    it('keeps the granted physical home after its lexical ancestor is redirected', async () => {
        const fixture = await coldConnectedHome();
        let composition: Awaited<ReturnType<typeof createConfiguredPluginExternalSessionsAdapter>> | undefined;
        try {
            const homesRoot = join(fixture.input.activeServerDir, 'daemon', 'connected-services', 'homes');
            const physicalRoot = join(fixture.runtime.happyHomeDir, 'verified-homes');
            await rename(homesRoot, physicalRoot);
            await symlink(physicalRoot, homesRoot, process.platform === 'win32' ? 'junction' : 'dir');
            const physicalHome = await realpath(fixture.homePath);
            const catalogEntry = await fixture.input.resolveCatalogEntry('codex');
            const admitted = await resolveConfiguredExternalSessionSourceAtAdmission({ ...fixture.input,
                agentId: 'codex', source: fixture.source, catalogEntry });
            if (!admitted.ok) throw new Error('Expected relocated-home admission');
            expect(await resolveConfiguredExternalSessionSourceAtAdmission({ ...fixture.input,
                agentId: 'codex', source: admitted.source, catalogEntry })).toMatchObject({ ok: true, source: admitted.source });
            composition = await createConfiguredPluginExternalSessionsAdapter(fixture.input);
            expect(composition.sourceRefusals).toEqual([]);

            const outsideRoot = join(fixture.runtime.happyHomeDir, 'outside-homes');
            const outsideHome = join(outsideRoot, relative(homesRoot, fixture.homePath));
            await mkdir(join(outsideHome, 'sessions'), { recursive: true });
            await writeFile(join(outsideHome, 'sessions', `rollout-${fixture.remoteSessionId}.jsonl`),
                JSON.stringify({ type: 'session_meta', payload: { id: fixture.remoteSessionId, cwd: '/outside' } }) + '\n'
                + JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user',
                    content: [{ type: 'input_text', text: 'outside transcript marker' }] } }) + '\n');
            await unlink(homesRoot);
            await symlink(outsideRoot, homesRoot, process.platform === 'win32' ? 'junction' : 'dir');

            // The snapshot and retained source must agree on the granted root.
            const target = await composition.compositionPort.resolveSourceIdentity({ agentId: 'codex',
                remoteSessionId: fixture.remoteSessionId, boundSource: admitted.source });
            if (target.status !== 'resolved') throw new Error('Expected admitted native target');
            const page = await composition.authorService.readTranscript(target.ref, { mode: 'page', direction: 'older' });
            expect(JSON.stringify(page)).toContain('connected home fixture');
            expect(JSON.stringify(page)).not.toContain('outside transcript marker');
            expect(target).toMatchObject({ status: 'resolved', source: { homePath: physicalHome } });
            const boundary = await fixture.resolveBoundary('codex');
            if (!boundary) throw new Error('Expected real Codex metadata boundary');
            expect(await boundary.externalSessions.resolveSource({ source: admitted.source, signal: fixture.input.signal }))
                .toMatchObject({ ok: true, value: { source: admitted.source, transcriptMediaReadRoots: [physicalHome],
                    accountingSource: { rootPath: physicalHome } } });
        } finally { composition?.dispose(); await fixture.runtime.dispose(); }
    });
    it('admits a cold configured adapter through its real native source', async () => {
        const fixture = await coldConnectedHome();
        try {
            const composition = await createConfiguredPluginExternalSessionsAdapter(fixture.input);
            try {
                expect(composition.sourceRefusals).toEqual([]);
                const target = await composition.compositionPort.resolveSourceIdentity({ agentId: 'codex',
                    remoteSessionId: fixture.remoteSessionId,
                    boundSource: ExternalSessionsSourceSchema.parse({ ...fixture.source, homePath: fixture.homePath }) });
                expect(target).toMatchObject({ status: 'resolved', source: { homePath: fixture.homePath } });
            } finally { composition.dispose(); }
        } finally { await fixture.runtime.dispose(); }
    });

    it('admits cold configured-follow sources while preserving Codex follow unavailability', async () => {
        const fixture = await coldConnectedHome();
        try {
            expect(await resolveConfiguredExternalSessionFollowTarget({ ...fixture.input, agentId: 'codex',
                remoteSessionId: fixture.remoteSessionId, boundSource: fixture.source }))
                .toMatchObject({ status: 'unavailable', diagnostic: { reason: 'no_eligible_source',
                    matchingSources: 2, currentSources: 2, followCapableSources: 0 } });
        } finally { await fixture.runtime.dispose(); }
    });

    it.each(['usage', 'memory'] as const)('discovers the cold connected home through %s', async kind => {
        const fixture = await coldConnectedHome();
        try {
            const discovered = kind === 'usage'
                ? { descriptors: await discoverNativeUsageSourceMetadata(fixture.input) }
                : await discoverMemoryExternalTranscriptSources(fixture.input);
            const connected = discovered.descriptors.filter(row => row.source.home === 'connectedService');
            expect(connected).toHaveLength(1);
            expect(connected[0]).toMatchObject({ supported: true, root: fixture.homePath,
                source: { homePath: fixture.homePath } });
            if ('configuredSourceKeys' in discovered) {
                expect(discovered.configuredSourceKeys.has(JSON.stringify(['codex', connected[0].configuredSourceKey]))).toBe(true);
            }
            expect(ExternalSessionsSourceSchema.parse(connected[0].source)).toEqual(connected[0].source);
        } finally { await fixture.runtime.dispose(); }
    });

    it('resolves retained Usage metadata with the acquired boundary entry', async () => {
        const fixture = await coldConnectedHome();
        try {
            const boundary = await fixture.resolveBoundary('codex');
            if (!boundary) throw new Error('Expected executable boundary');
            expect(fixture.runtime.registry.contributes.agents.find(agent => agent.id === 'codex')
                ?.catalogEntry?.connectedAccountNativeHome).toBeUndefined();
            expect(await resolveNativeUsageSourceMetadata({ ...fixture.input, agentId: 'codex',
                source: fixture.source, boundary })).toMatchObject({ descriptor: { root: fixture.homePath } });
            expect(boundary.catalogEntry?.connectedAccountNativeHome).toBeDefined();
        } finally { await fixture.runtime.dispose(); }
    });

    it('refuses a foreign acquired entry and a caller-chosen connected home', async () => {
        const fixture = await coldConnectedHome();
        try {
            const homesRoot = join(fixture.input.activeServerDir, 'daemon', 'connected-services', 'homes');
            const physicalRoot = join(fixture.runtime.happyHomeDir, 'negative-physical-homes');
            await rename(homesRoot, physicalRoot);
            await symlink(physicalRoot, homesRoot, process.platform === 'win32' ? 'junction' : 'dir');
            const catalogEntry = await fixture.input.resolveCatalogEntry('codex');
            const foreignEntry = await fixture.input.resolveCatalogEntry('claude');
            expect(foreignEntry).not.toBeNull();
            expect(await resolveConfiguredExternalSessionSourceAtAdmission({ ...fixture.input, agentId: 'codex',
                source: fixture.source, catalogEntry: foreignEntry })).toEqual({ ok: false, code: 'source_invalid' });
            expect(await resolveConfiguredExternalSessionSourceAtAdmission({ ...fixture.input, agentId: 'codex',
                source: { ...fixture.source, homePath: join(fixture.homePath, 'foreign') }, catalogEntry }))
                .toEqual({ ok: false, code: 'source_invalid' });
        } finally { await fixture.runtime.dispose(); }
    });
});
