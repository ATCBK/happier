import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ExternalSessionsCandidatesListResponseSchema } from '@happier-dev/protocol/sessions/external/daemonRpcV1';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveBuiltInContributions } from '@/plugins/projection/registry/resolveBuiltInContributions';
import { resolveExternalSessionSourceFromAgentProjection } from '@/plugins/projection/registry/externalSessionSources';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerMachineExternalSessionsRpcHandlers } from '@/api/machine/rpcHandlers.externalSessions';

const fixture = vi.hoisted(() => ({ activeServerDir: '', slowPath: '', nowMs: 0,
    cancelDuringAnnotation: null as (() => void) | null, annotationSignalAborted: false }));
vi.mock('@/configuration', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/configuration')>();
    return { ...actual, configuration: { ...actual.configuration, get activeServerDir() { return fixture.activeServerDir; } } };
});
// Real files and codecs are retained; only OS open latency is charged to a clock.
vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
        const handle = await actual.open(...args);
        if (args[0] === fixture.slowPath) fixture.nowMs += 3_000;
        return handle;
    } };
});

// A synthetic plain Account has no linked sessions. Only credential storage
// and Account HTTP are replaced; ingestion, admission and codecs stay real.
vi.mock('@/persistence', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/persistence')>(),
    readSettings: async () => ({ memory: { v: 1, enabledAtMs: 1 } }),
    readStoredCredentials: async () => ({ token: 'fixture-token', encryption: null }),
}));
vi.mock('@/api/client/connectedServiceCredentialApi', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/api/client/connectedServiceCredentialApi')>(),
    fetchAccountEncryptionCurrentness: async ({ signal }: { signal?: AbortSignal }) => {
        fixture.cancelDuringAnnotation?.();
        if (fixture.cancelDuringAnnotation) fixture.annotationSignalAborted = signal?.aborted === true;
        return { mode: 'plain' as const };
    },
}));
vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
    lookupSessionsByTags: async ({ tags }: { tags: readonly string[] }) => ({ state: 'available' as const, tags, sessions: [] }),
}));
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
    return createBundledPluginPublicationFsFixture(actual);
});

describe('bundled conversation content search', () => {
    it('publishes both source capabilities and admits a real bundled Claude content Action', async () => {
        const contributes = createResolvedContributionRegistry(resolveBuiltInContributions());
        for (const [agentId, source] of [
            ['claude', { kind: 'claudeConfig' }],
            ['codex', { kind: 'codexHome', home: 'user' }],
        ] as const) {
            const projected = resolveExternalSessionSourceFromAgentProjection(contributes, agentId, source);
            expect(projected).toMatchObject({ ok: true, declaration: { contentSearch: true } });
        }

        const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
        const { createAdmittedPluginRuntimeFixture } = await import('@/plugins/testkit/admittedRuntime');
        const { executeExternalSessionCandidatesListAction } = await import('./discoveryLinkActions');

        const root = await mkdtemp(join(tmpdir(), 'bundled-content-action-'));
        const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
        let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | null = null;
        let registration: ReturnType<typeof registerMachineExternalSessionsRpcHandlers> | null = null;
        try {
            fixture.activeServerDir = join(root, 'server');
            const configDir = join(root, 'claude');
            for (const projectId of ['a-miss', 'b-miss']) {
                await mkdir(join(configDir, 'projects', projectId), { recursive: true });
                await writeFile(join(configDir, 'projects', projectId, 'unrelated.jsonl'), JSON.stringify({
                    type: 'user', uuid: 'unrelated', parentUuid: null,
                    message: { role: 'user', content: 'An unrelated conversation\nwith C:\\work\\example and \\u001b' },
                }) + '\n');
                await utimes(join(configDir, 'projects', projectId, 'unrelated.jsonl'), new Date('2025-01-01'), new Date('2025-01-01'));
            }
            await mkdir(join(configDir, 'projects', 'zz-recent'), { recursive: true });
            await writeFile(join(configDir, 'projects', 'zz-recent', 'session.jsonl'), [
                { type: 'user', uuid: 'title', parentUuid: null, message: { role: 'user', content: 'Ordinary title' } },
                { type: 'assistant', uuid: 'body', parentUuid: 'title', message: { role: 'assistant', content: [{ type: 'text', text: 'bundled body-only needle' }] } },
            ].map((row) => JSON.stringify(row)).join('\n') + '\n');
            await utimes(join(configDir, 'projects', 'zz-recent', 'session.jsonl'), new Date('2026-10-01'), new Date('2026-10-01'));
            process.env.CLAUDE_CONFIG_DIR = configDir;
            runtime = await createAdmittedPluginRuntimeFixture({
                happyHomeDir: join(root, 'happier'), controller: pluginReloadController,
                runtimeOptions: { contributes, pluginIds: ['happier.agent.claude'] },
            });
            const result = await executeExternalSessionCandidatesListAction({
                // The production source resolver must honor the invocation's
                // configured native home even when the request omits configDir.
                machineId: 'fixture-machine', agentId: 'claude', source: { kind: 'claudeConfig' },
                searchTarget: 'content', searchTerm: 'bundled body-only needle', limit: 50,
            });
            expect(ExternalSessionsCandidatesListResponseSchema.safeParse(result).success).toBe(true);
            expect(result).toMatchObject({ ok: true, contentCoverage: 'complete', candidates: [
                { remoteSessionId: 'session', match: { snippet: 'bundled body-only needle', messageIndex: 1 } },
            ] });

            // Native layout: a completed hit precedes a large escaped JSONL file.
            // The receiving RPC budget must reach Claude through real registration;
            // cancellation alone loses that hit and its Search-more continuation.
            await mkdir(join(configDir, 'projects', 'a-slow'), { recursive: true });
            fixture.slowPath = join(configDir, 'projects', 'a-slow', 'large.jsonl');
            await writeFile(fixture.slowPath, Array.from({ length: 1500 }, (_, index) => JSON.stringify({
                type: 'user', uuid: `large-${index}`, parentUuid: index ? `large-${index - 1}` : null,
                message: { role: 'user', content: index === 1499 ? 'bundled body-only needle' : 'ordinary \\text '.repeat(40) },
            })).join('\n') + '\n');
            await utimes(fixture.slowPath, new Date('2026-01-01'), new Date('2026-01-01'));
            const rpc = new RpcHandlerManager({ scopePrefix: 'fixture-machine', encryptionMode: 'plain' });
            registration = registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager: rpc });
            fixture.nowMs = Date.now();
            const clock = vi.spyOn(Date, 'now').mockImplementation(() => fixture.nowMs);
            // A dropped receiving deadline must fail on response time even
            // if another native budget still yields a partial page.
            const receivingBudgetMs = 10_000;
            const deadlineAtMs = fixture.nowMs + receivingBudgetMs;
            const input = {
                machineId: 'fixture-machine', agentId: 'claude', source: { kind: 'claudeConfig' },
                searchTarget: 'content', searchTerm: 'bundled body-only needle',
                budgetMs: receivingBudgetMs,
            };
            const first = ExternalSessionsCandidatesListResponseSchema.parse(await rpc.handleRequest({
                method: 'fixture-machine:daemon.externalSessions.candidates.list', params: input, timeoutMs: null,
            }));
            expect(first).toMatchObject({ ok: true, contentCoverage: 'partial', candidates: [
                { remoteSessionId: 'session', match: { messageIndex: 1 } },
            ], nextCursor: expect.any(String) });
            expect(fixture.nowMs).toBeLessThan(deadlineAtMs);
            if (!first.ok) throw new Error('Expected a partial search page');
            let cursor = first.nextCursor;
            const hits = [...first.candidates];
            for (let page = 0; cursor && page < 30; page += 1) {
                const next = ExternalSessionsCandidatesListResponseSchema.parse(await rpc.handleRequest({
                    method: 'fixture-machine:daemon.externalSessions.candidates.list',
                    params: { ...input, cursor }, timeoutMs: null,
                }));
                if (!next.ok) throw new Error(`Candidate page failed: ${next.code}`);
                hits.push(...next.candidates);
                if (next.nextCursor) {
                    expect(next.contentCoverage).toBe('partial');
                    expect(next.nextCursor).not.toBe(cursor);
                } else expect(next.contentCoverage).toBe('complete');
                cursor = next.nextCursor;
            }
            expect(cursor).toBeNull();
            expect(hits).toMatchObject([
                { remoteSessionId: 'session', match: { messageIndex: 1 } },
                { remoteSessionId: 'large', match: { messageIndex: 1499 } },
            ]);
            const recency = ExternalSessionsCandidatesListResponseSchema.parse(await rpc.handleRequest({
                method: 'fixture-machine:daemon.externalSessions.candidates.list', params: { ...input, limit: 1 }, timeoutMs: null,
            }));
            if (!recency.ok) throw new Error('Expected a recency page');
            expect(recency.candidates.map(row => row.remoteSessionId)).toEqual(['session']);
            expect(recency.nextCursor).toEqual(expect.any(String));
            await utimes(fixture.slowPath, new Date('2026-11-01'), new Date('2026-11-01'));
            const reset = ExternalSessionsCandidatesListResponseSchema.parse(await rpc.handleRequest({
                method: 'fixture-machine:daemon.externalSessions.candidates.list',
                params: { ...input, limit: 1, cursor: recency.nextCursor }, timeoutMs: null,
            }));
            expect(reset).toMatchObject({ ok: true, candidates: [], nextCursor: null, cursorReset: true });
            // Annotation is optional enrichment of an already decoded native
            // page. A transport cancellation here must not replace found hits.
            await utimes(fixture.slowPath, new Date('2026-01-01'), new Date('2026-01-01'));
            const beforeAnnotationCancellation = ExternalSessionsCandidatesListResponseSchema.parse(await rpc.handleRequest({
                method: 'fixture-machine:daemon.externalSessions.candidates.list', params: input, timeoutMs: null,
            }));
            if (!beforeAnnotationCancellation.ok) throw new Error('Expected a found partial native page');
            expect(beforeAnnotationCancellation).toMatchObject({ contentCoverage: 'partial',
                candidates: [{ remoteSessionId: 'session' }], nextCursor: expect.any(String) });
            fixture.cancelDuringAnnotation = () => rpc.onSocketDisconnect();
            const annotationCancelled = ExternalSessionsCandidatesListResponseSchema.parse(await rpc.handleRequest({
                method: 'fixture-machine:daemon.externalSessions.candidates.list', params: input, timeoutMs: null,
            }));
            expect(fixture.annotationSignalAborted).toBe(true);
            expect(annotationCancelled).toMatchObject({ ok: true,
                candidates: beforeAnnotationCancellation.candidates,
                nextCursor: beforeAnnotationCancellation.nextCursor,
                contentCoverage: 'partial', annotationsIncomplete: true });
            fixture.cancelDuringAnnotation = null;
            clock.mockRestore();
        } finally {
            fixture.slowPath = '';
            fixture.cancelDuringAnnotation = null;
            fixture.annotationSignalAborted = false;
            vi.restoreAllMocks();
            await registration?.dispose();
            await runtime?.dispose();
            if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
            else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
            await rm(root, { recursive: true, force: true });
        }
    });
});
