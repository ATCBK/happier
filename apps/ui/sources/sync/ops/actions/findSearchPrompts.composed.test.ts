import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DEFAULT_MEMORY_SETTINGS } from '@happier-dev/protocol/memory/memorySettings';
import { DaemonWorkspaceFileSearchRequestSchema, DaemonWorkspaceFileSearchResponseSchema } from '@happier-dev/protocol/machines/workspaceFiles';
import { ExternalSessionCandidateMatchV1Schema, ExternalSessionsCandidatesListRequestSchema,
    ExternalSessionsCandidatesListResponseSchema } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import { createDeferred, standardCleanup } from '@/dev/testkit';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

// Reuse the Action-family's HTTP/Socket boundary kit. Admission, scoped RPC,
// native transcript decoding, schemas and the app executor remain real.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
let answerRpc: Parameters<typeof installSessionActionRpcBoundary>[0] = () => { throw new Error('Unexpected daemon request'); };
const requests = installSessionActionRpcBoundary(request => answerRpc(request));
await loadSyncSingletonForTests();
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { getActionSpec } = await import('@happier-dev/protocol/actions/actionSpecs');
const { searchConversations } = await import('@/sync/domains/search/searchConversations');
const { listClaudeExternalSessionCandidates } = await import('../../../../../../packages/plugins/claude/src/agent/surfaces/sessions/external/candidates');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let serverId: string;
let corpusRoot: string | undefined;

beforeEach(async () => {
    await homes.reset();
    requests.length = 0;
    serverId = await homes.addHome({ name: 'FSP Action Home', serverUrl: 'https://fsp-actions.test', accountId: 'fsp-account' });
    const machine = createPlainMachineRowFixture({ id: 'fsp-machine', accountId: 'fsp-account' });
    homes.answer(serverId, '/v1/machines/fsp-machine', { body: { machine } });
    homes.answer(serverId, '/v1/machines', { body: [machine] });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://fsp-actions.test', accountId: 'fsp-account', request: homes.request });
    installHomeGovernanceBoundaries(homes);
});
afterEach(async () => {
    standardCleanup();
    await connection?.dispose();
    connection = undefined;
    if (corpusRoot) await rm(corpusRoot, { recursive: true, force: true });
    corpusRoot = undefined;
});

describe('FSP search production composition', () => {
    it('executes text-in-files through the registered app Action and strict daemon transport', async () => {
        const page = DaemonWorkspaceFileSearchResponseSchema.parse({ ok: true, hasMore: true, coverage: 'partial',
            files: [{ path: 'src/emoji.ts', matches: [{ line: 7, column16: 3, length16: 6,
                text: '😀 needle', before: ['before'], after: ['after'] }] }] });
        if (!page.ok) throw new Error('Expected a workspace search page');
        let misbound = false;
        answerRpc = request => {
            expect(request.method).toBe(`fsp-machine:${RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH}`);
            expect(DaemonWorkspaceFileSearchRequestSchema.parse(request.params))
                .toMatchObject({ rootPath: '/repo', query: 'needle' });
            return misbound ? { ...page, matches: page.files } : page;
        };
        const executor = createDefaultActionExecutor();
        const input = { machineId: 'fsp-machine', rootPath: '/repo', query: 'needle' };
        const context = { surface: 'ui' as const, serverId, expectedAccountId: 'fsp-account' };
        const result = await executor.execute('workspace.files.search', input, context);
        expect(result).toEqual({ ok: true, result: page });
        if (!result.ok) throw new Error('Workspace search Action unavailable');
        expect(getActionSpec('workspace.files.search').outputSchema!.parse(result.result)).toEqual(page);
        // Bind the same transport to an invalid producer shape once: strict consumer rejects it.
        misbound = true;
        await expect(executor.execute('workspace.files.search', input, context))
            .resolves.toMatchObject({ ok: false, errorCode: 'workspace_file_search_unavailable' });
    });

    it('finds body-only native text through real sources and keeps a published page stable while another source waits', async () => {
        corpusRoot = await mkdtemp(join(tmpdir(), 'fsp-native-search-'));
        const makeSource = async (name: string, count: number) => {
            const configDir = join(corpusRoot!, name);
            const directory = join(configDir, 'projects', 'project');
            await mkdir(directory, { recursive: true });
            for (let index = 0; index < count; index++) {
                const rows = [
                    { type: 'user', uuid: 'title', parentUuid: null, message: { role: 'user', content: 'An unrelated title' } },
                    { type: 'assistant', uuid: 'body', parentUuid: 'title', message: { role: 'assistant',
                        content: [{ type: 'text', text: 'Body-only café\nwith "quotes"' }] } },
                ];
                await writeFile(join(directory, `${name}-${index}.jsonl`), rows.map(row => JSON.stringify(row).replace(/é/g, '\\u00e9')).join('\n') + '\n');
            }
            return { agentId: 'claude', sourceKey: name, source: { kind: 'claudeConfig' as const, configDir, projectId: 'project' }, contentSearch: true };
        };
        const sources = [await makeSource('fast', 2), await makeSource('slow', 1)];
        const slow = createDeferred<void>();
        const controller = new AbortController();
        const pages: Awaited<ReturnType<typeof searchConversations>>[] = [];
        let firstSourceMatch: ReturnType<typeof ExternalSessionCandidateMatchV1Schema.parse> | undefined;
        answerRpc = async request => {
            if (request.method === `fsp-machine:${RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET}`) return { ...DEFAULT_MEMORY_SETTINGS, enabled: false };
            expect(request.method).toBe(`fsp-machine:${RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST}`);
            const query = ExternalSessionsCandidatesListRequestSchema.parse(request.params);
            if (query.source.kind !== 'claudeConfig') throw new Error('Wrong native source binding');
            const selectedSource = sources.find(source => source.source.configDir === query.source.configDir);
            if (!selectedSource) throw new Error('Unknown native source binding');
            if (query.source.configDir === sources[1].source.configDir) await slow.promise;
            const native = await listClaudeExternalSessionCandidates({ source: selectedSource.source, env: { NODE_ENV: 'test' },
                limit: 1, searchTerm: query.searchTerm, searchTarget: query.searchTarget, cursor: query.cursor,
                // The OS process is external; every native file read and codec is real.
                ripgrep: { run: async ({ paths }) => ({ exitCode: 0, stdout: paths.join('\0') + '\0', stderr: '' }) } });
            for (const candidate of native.candidates) {
                const match = ExternalSessionCandidateMatchV1Schema.parse(candidate.match);
                expect(match).toMatchObject({ sourceItemId: expect.stringMatching(/^claude:/), messageIndex: 1,
                    snippet: expect.stringContaining('café\nwith "quotes"') });
                expect(candidate.title).not.toContain('café');
                if (query.source.configDir === sources[0].source.configDir) firstSourceMatch = match;
                expect(ExternalSessionCandidateMatchV1Schema.safeParse({ ...match, seq: 99 }).success).toBe(false);
            }
            return ExternalSessionsCandidatesListResponseSchema.parse({ ok: true, ...native });
        };
        const pending = searchConversations({ serverId, accountId: 'fsp-account', concurrencyLimit: 1,
            machines: [{ id: 'fsp-machine', online: true }], mode: 'standard', signal: controller.signal,
            query: { v: 1, query: 'café\nwith "quotes"', scope: { type: 'global' }, mode: 'auto', corpora: ['external_transcripts'] },
            readSources: async () => sources, onProgress: page => pages.push(page) });
        try {
            await vi.waitFor(() => expect(pages.some(page => page.hits.length === 1)).toBe(true));
            const first = pages.find(page => page.hits.length === 1)!;
            expect(firstSourceMatch).toBeDefined();
            expect(first.hits[0]).toMatchObject({ mode: 'standard', sourceKey: 'fast', candidate: { match: firstSourceMatch } });
            expect(first.continuations).toEqual([{ machineId: 'fsp-machine', sourceKey: 'fast', cursor: expect.any(String) }]);
            expect(first.machines[0]).toMatchObject({ status: 'partial' });
            slow.resolve();
            expect((await pending).hits).toHaveLength(2);
            expect(first.hits).toHaveLength(1);
            expect(first.continuations).toHaveLength(1);
            // A source whose content capability is mis-bound must not produce native body hits.
            const unsupported = await searchConversations({ serverId, accountId: 'fsp-account', concurrencyLimit: 1,
                machines: [{ id: 'fsp-machine', online: true }], mode: 'standard',
                query: { v: 1, query: 'café', scope: { type: 'global' }, mode: 'auto', corpora: ['external_transcripts'] },
                readSources: async () => sources.map(source => ({ ...source, contentSearch: false })) });
            expect(unsupported.hits).toEqual([]);
            expect(unsupported.machines[0]).toMatchObject({ status: 'partial' });
        } finally { slow.resolve(); controller.abort(); await pending.catch(() => undefined); }
    });
});
