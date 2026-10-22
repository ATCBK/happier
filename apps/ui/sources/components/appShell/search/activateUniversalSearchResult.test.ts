import { installFileFindAccountBoundaryMocks } from '@/components/appShell/panes/fileFindSeedTestHelpers';
import { describe, expect, it, vi } from 'vitest';

import { activateUniversalSearchResult, type UniversalSearchActivationOwners } from './activateUniversalSearchResult';
import type { UniversalSearchTarget } from './universalSearchResult';
import { createFileFindSeedHandoff, openChatWithFindSeed } from '@/components/appShell/panes/fileFindSeedHandoff';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { makeExternalSessionHistoricalImportLocalId } from '@happier-dev/protocol/sessions/external/historicalImportIdentity';
import { buildUniversalSearchSymbolResults } from './workspaceSymbolSearchResults';
import { isUniversalSearchTargetCurrent } from './isUniversalSearchTargetCurrent';
import { selectDocumentOutline } from '@/sync/domains/workspaces/languageIntelligence/documentOutline';
import { WORKSPACE_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/workspaceActionFamily';

installFileFindAccountBoundaryMocks();
// Load the real external owner after its boundaries, outside an individual activation's deadline.
const { openExternalSessionCandidate } = await import('@/components/sessions/external/browse/openExternalSessionCandidate');

async function expectSavedWorkspaceResourceOpensInProject(
    target: UniversalSearchTarget,
    initialResource: Readonly<{ kind: 'file'; path: string }> | Readonly<{ kind: 'commit'; sha: string }>,
): Promise<void> {
    const openProject = vi.fn(async () => true);
    const outcome = await activateUniversalSearchResult(target, {
        navigateToSession: vi.fn(),
        push: vi.fn(),
        openProject,
    });

    expect(outcome).toEqual({ ok: true });
    expect(openProject).toHaveBeenCalledWith('wr_1', {
        serverId: 'home-a',
        activeRootPath: '/repo',
        initialResource,
    });
}

describe('activateUniversalSearchResult', () => {
    it('preserves a declined file navigation as cancellation instead of unavailable', async () => {
        expect(await activateUniversalSearchResult({ kind: 'workspaceFile', path: 'src/a.ts',
            scope: { serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' },
            workspaceRefId: 'project-a', sessionId: null, serverId: 'home-a', accountId: 'account-a' }, {
            navigateToSession: vi.fn(), push: vi.fn(), openProject: async () => true,
            openFile: async () => null,
        })).toEqual({ ok: false, reason: 'cancelled' });
    });

    it.each(['preview', 'beside'] as const)('opens a syntax outline result at its line through the shared file activation owner with %s intent', async (intent) => {
        const scope = { serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' };
        const range = { start: { line: 10, character: 0 }, end: { line: 13, character: 1 } };
        const outline = selectDocumentOutline({ baseline: { status: 'ok', symbols: [] },
            server: { capable: true, state: 'ready', loading: false, symbols: [
                { serverId: 'language-server', name: 'read', kind: 12, range,
                    selectionRange: { start: { line: 11, character: 4 }, end: { line: 11, character: 8 } } },
            ] },
        });
        if (outline.status !== 'ok') throw new Error('Expected server outline');
        const results = buildUniversalSearchSymbolResults(outline.symbols,
            { kind: 'workspaceFile', scope, path: 'src/box.ts', accountId: 'account-a',
            serverId: null, workspaceRefId: 'wr_1', sessionId: null });
        expect(results[0]?.target.kind).toBe('workspaceSymbol');
        const openFile = vi.fn(async () => true);
        expect(await activateUniversalSearchResult(results[0]!.target, {
            navigateToSession: vi.fn(), push: vi.fn(), openProject: vi.fn(), openFile,
            isTargetCurrent: target => isUniversalSearchTargetCurrent({
                target, accountScope: { serverId: 'home-a', accountId: 'account-a', current: true },
                workspaces: [{ id: 'wr_1', ...scope, createdAtMs: 1 }], settingsPages: new Map(),
                resolveSessionWorkspaceTarget: () => null, isWorkspaceScopeReachable: () => true,
            }),
        }, { intent })).toEqual({ ok: true });
        expect(openFile).toHaveBeenCalledWith({ kind: 'project', workspaceRefId: 'wr_1', serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo', path: 'src/box.ts' },
            { anchor: { kind: 'fileLine', startLine: 12 }, intent });
    });

    it('carries a Messages query in destination memory and discards it on failed navigation', async () => {
        const handoff = createFileFindSeedHandoff();
        const authority = captureActiveServerAccountScopeLifetime();
        if (!authority) throw new Error('Expected real Account lifetime');
        const destination = { sessionId: 'session-a', serverId: 'home-a' };
        const find = { query: 'secret needle', options: { matchCase: false, regex: false },
            target: { kind: 'seq' as const, seq: 7 } };
        const target = { kind: 'session' as const, accountId: 'account-a', ...destination, seq: 7, find };
        let failed = false;
        const routes: unknown[] = [];
        const owners: UniversalSearchActivationOwners = { push: () => {}, openProject: async () => true,
            navigateToSession: async (sessionId, options) => {
                await openChatWithFindSeed({ handoff, destination: { sessionId, serverId: options?.serverId ?? '' },
                    seed: options?.find, authority, open: () => {
                        routes.push(options?.query);
                        if (failed) throw new Error('Navigation failed');
                    } });
            } };
        expect(await activateUniversalSearchResult(target, owners)).toEqual({ ok: true });
        expect(handoff.takeChatCurrent(destination)?.seed).toEqual(find);
        expect(routes).toEqual([{ jumpSeq: 7 }]);
        expect(JSON.stringify(routes)).not.toContain(find.query);
        failed = true;
        expect(await activateUniversalSearchResult(target, owners)).toEqual({ ok: false, reason: 'failed' });
        expect(handoff.takeChatCurrent(destination)).toBeNull();
        handoff.dispose();
    });
    it('opens an external conversation through the existing candidate opener with a message Find seed', async () => {
        const openSession = vi.fn();
        const target: UniversalSearchTarget = { kind: 'externalConversation', serverId: 'home-a', accountId: 'account-a',
            machineId: 'machine-a', query: 'quartz', agentId: 'fixture-agent',
            source: { kind: 'fixture-source' }, candidate: { remoteSessionId: 'native', linkedSessionId: 'linked', updatedAtMs: 10 },
            sourceItemId: 'message-uuid' };
        expect(await activateUniversalSearchResult(target, { navigateToSession: vi.fn(), push: vi.fn(), openProject: async () => true,
            openExternalConversation: row => openExternalSessionCandidate({ candidate: row.candidate!, agentId: row.agentId,
                source: row.source!, actionsAllowed: true, offline: false, isSelectionCurrent: () => true,
                accountCurrentness: { isCurrent: () => true }, resolveCurrentTarget: () => ({ machineId: row.machineId, serverId: row.serverId }),
                state: { requestToken: 0, linkingCandidateKey: null }, onLinkingChange: () => {}, openSession,
                find: { query: row.query, sourceItemId: row.sourceItemId } }).then(outcome => outcome === 'opened'),
        })).toEqual({ ok: true });
        expect(openSession.mock.calls[0]?.[2]).toMatchObject({ query: 'quartz', target: { kind: 'route-message-id' } });
        expect(openSession.mock.calls[0]?.[2].target.routeMessageId).toBe(`server:${makeExternalSessionHistoricalImportLocalId({
            agentId: 'fixture-agent', remoteSessionId: 'native', directItemId: 'message-uuid',
        })}`);
    });

    it('opens named memory topics and instructions through their existing document route owners', async () => {
        const push = vi.fn();
        const navigateToSession = vi.fn();
        for (const [location, href] of [
            [{ type: 'topic' as const, title: 'Release & recovery' }, '/settings/prompts/memory/memory%2Fb?serverId=home-b&topic=Release%20%26%20recovery&fact=fact%2Fb'],
            ['archive' as const, '/settings/prompts/memory/memory%2Fb?serverId=home-b&topic=archive&fact=fact%2Fb'],
            ['facts' as const, '/settings/prompts/memory/memory%2Fb?serverId=home-b&fact=fact%2Fb'],
            ['document' as const, '/settings/prompts/docs/memory%2Fb?serverId=home-b'],
        ] as const) {
            const outcome = await activateUniversalSearchResult({ kind: 'memoryDocument',
                serverId: 'producing-home', accountId: 'account-b',
                ref: { kind: 'doc', artifactId: 'memory/b', serverId: 'home-b' },
                location, factId: 'fact/b',
            }, { push, navigateToSession, openProject: async () => true });
            expect(outcome).toEqual({ ok: true });
            expect(push).toHaveBeenLastCalledWith(href);
        }
        expect(navigateToSession).not.toHaveBeenCalled();
    });
    it('reports file Action refusal and failure without invoking alternate navigation', async () => {
        const scope = { serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' };
        const find = { query: 'needle', options: { matchCase: false, regex: false }, target: { kind: 'file' as const, path: 'src/a.ts' } };
        for (const host of ['session', 'project'] as const) {
            const destination = { host, id: 'destination-a', accountId: 'account-a', path: 'src/a.ts', scope };
            const navigateToSession = vi.fn();
            const openProject = vi.fn();
            const outcome = await activateUniversalSearchResult({ kind: 'workspaceFile', path: destination.path, scope,
                workspaceRefId: host === 'project' ? destination.id : null,
                sessionId: host === 'session' ? destination.id : null, serverId: scope.serverId, accountId: destination.accountId, find }, {
                navigateToSession, openProject, push: () => {}, openFile: async () => {
                    if (host === 'session') throw new Error('Destination navigation failed');
                    return false;
                },
            });
            expect(outcome).toEqual({ ok: false, reason: host === 'session' ? 'failed' : 'unavailable' });
            expect(navigateToSession).not.toHaveBeenCalled();
            expect(openProject).not.toHaveBeenCalled();
        }
    });
    it.each(['preview', 'beside'] as const)('hands the qualified session file and private Find seed to the shared opener with %s intent', async (intent) => {
        const anchor = { kind: 'fileLine' as const, startLine: 12 };
        const find = { query: 'secret query', options: { matchCase: true, regex: false }, target: { kind: 'file' as const, path: 'src/index.ts', anchor } };
        const navigateToSession = vi.fn();
        const openFile = vi.fn<NonNullable<UniversalSearchActivationOwners['openFile']>>(async () => true);
        const target = { kind: 'workspaceFile' as const, path: 'src/index.ts', anchor, find,
            scope: { serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' }, workspaceRefId: null,
            sessionId: 'session-a', serverId: null, accountId: 'account-a' };
        expect(await activateUniversalSearchResult(target, { navigateToSession, push: vi.fn(), openProject: async () => true, openFile }, { intent })).toEqual({ ok: true });
        expect(openFile).toHaveBeenCalledWith({ kind: 'session', sessionId: 'session-a', serverId: 'home-a', path: target.path }, {
            intent, anchor, find: { ...find, target: { kind: 'session-file', sessionId: 'session-a', ...target.scope, path: target.path, anchor } },
        });
        const [fileTarget, launch] = openFile.mock.calls[0]!;
        const { path, ...address } = fileTarget;
        expect(WORKSPACE_ACTION_INPUT_SCHEMAS['workspace.tabs.open'].safeParse({ file: { target: address, path, anchor }, find: launch?.find }).success).toBe(true);
        expect(navigateToSession).not.toHaveBeenCalled();
    });

    it('keeps project file anchors and Find seeds on the canonical opener', async () => {
        const anchor = { kind: 'range' as const, filePath: 'src/index.ts', startLine: 12, endLine: 14 };
        const find = { query: 'needle', options: { matchCase: false, regex: false }, target: { kind: 'file' as const, path: 'src/index.ts', anchor } };
        const openFile = vi.fn<NonNullable<UniversalSearchActivationOwners['openFile']>>(async () => true);
        await activateUniversalSearchResult({ kind: 'workspaceFile', path: 'src/index.ts', anchor, anchorSource: 'diff', find,
            scope: { serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' }, workspaceRefId: 'wr_1',
            sessionId: null, serverId: 'home-a', accountId: 'account-a' }, { navigateToSession: vi.fn(), push: vi.fn(), openProject: vi.fn(), openFile });
        expect(openFile).toHaveBeenCalledWith({ kind: 'project', workspaceRefId: 'wr_1', serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo', path: 'src/index.ts' }, {
            intent: 'preview', anchor, anchorSource: 'diff', find: { ...find, target: { kind: 'project-file', workspaceRefId: 'wr_1',
                serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo', path: 'src/index.ts', anchor } },
        });
        const [fileTarget, launch] = openFile.mock.calls[0]!;
        const { path, ...address } = fileTarget;
        expect(WORKSPACE_ACTION_INPUT_SCHEMAS['workspace.tabs.open'].safeParse({ file: { target: address, path, anchor }, find: launch?.find }).success).toBe(true);
    });
    it('opens project results through the canonical project-opening owner', async () => {
        const push = vi.fn();
        const openProject = vi.fn(async () => true);

        const outcome = await activateUniversalSearchResult({
            kind: 'project',
            workspaceRefId: 'wr_1',
            serverId: 'home-a',
            accountId: 'account-a',
            machineId: 'machine-a',
            rootPath: '/repo',
        }, {
            navigateToSession: vi.fn(),
            push,
            openProject,
        });

        expect(outcome).toEqual({ ok: true });
        expect(openProject).toHaveBeenCalledWith('wr_1', { serverId: 'home-a' });
        expect(push).not.toHaveBeenCalled();
    });

    it('reports a project that the canonical opener can no longer resolve as unavailable', async () => {
        const outcome = await activateUniversalSearchResult({
            kind: 'project',
            workspaceRefId: 'retired',
            serverId: 'home-a',
            accountId: 'account-a',
            machineId: 'machine-a',
            rootPath: '/gone',
        }, {
            navigateToSession: vi.fn(),
            push: vi.fn(),
            openProject: async () => false,
        });

        expect(outcome).toEqual({ ok: false, reason: 'unavailable' });
    });

    it('opens a saved workspace file through the file Action without a Session', async () => {
        const openFile = vi.fn(async () => true);
        expect(await activateUniversalSearchResult({
            kind: 'workspaceFile',
            path: 'src/index.ts',
            scope: { serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' },
            workspaceRefId: 'wr_1',
            sessionId: null,
            serverId: 'home-a',
            accountId: 'account-a',
        }, { openFile, navigateToSession: vi.fn(), push: vi.fn(), openProject: vi.fn() })).toEqual({ ok: true });
        expect(openFile).toHaveBeenCalledWith({ kind: 'project', workspaceRefId: 'wr_1', serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo', path: 'src/index.ts' }, { intent: 'preview' });
    });

    it('opens a saved workspace commit through the canonical project opener without a Session', async () => {
        await expectSavedWorkspaceResourceOpensInProject({
            kind: 'workspaceCommit',
            sha: 'abc123',
            scope: { serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' },
            workspaceRefId: 'wr_1',
            sessionId: null,
            serverId: 'home-a',
            accountId: 'account-a',
        }, { kind: 'commit', sha: 'abc123' });
    });
});
