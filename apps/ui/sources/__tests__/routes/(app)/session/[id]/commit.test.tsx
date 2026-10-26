import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createPlainSessionByIdResponseFixture, flushHookEffects, standardCleanup } from '@/dev/testkit';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import {
    createSessionFilesViewFixture, fileViewSnapshot,
    installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit,
} from '@/components/sessions/files/views/sessionFilesViewTestkit';

const route = vi.hoisted(() => ({ params: {} as Record<string, string | string[] | undefined>, back: vi.fn() }));
// Register native and route boundaries before loading the Account/route dependency graph.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    params: () => route.params, router: { back: route.back, push: vi.fn(), replace: vi.fn(), setParams: vi.fn() },
}).module);
installSessionFilesViewBoundaries({ platformOS: 'web', confirmResult: true, emitViewability: false });
let scmWriteEnabled = true;
let searchParams = { id: 'session-1', sha: 'abc123' };
const routerBack = route.back;
vi.doMock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    params: () => route.params, router: { back: route.back, push: vi.fn(), replace: vi.fn(), setParams: vi.fn() },
}).module);
vi.doMock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
vi.doMock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

const diffResponse = vi.fn();
const backoutResponse = vi.fn();
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>>;
let hydrateReady = true;
const pendingHydrationReads = new Set<() => void>();
// Prepare the one-time module graph during collection, before case-owned Account lifetimes.
await prepareSessionFilesViewTestkit();
const operations = await import('@/sync/ops');
vi.spyOn(operations, 'sessionScmDiffCommit');
vi.spyOn(operations, 'sessionScmCommitBackout');
const { DiffFilesListView } = await import('@/components/ui/code/diff/DiffFilesListView');
const { ActivitySpinner } = await import('@/components/ui/feedback/ActivitySpinner');
const { SessionCommitDetailsView } = await import('@/components/sessions/files/views/SessionCommitDetailsView');

describe('CommitScreen', () => {
    beforeEach(async () => {
        browser = await installBrowserRuntimeForTests({ url: 'http://localhost/' });
        scmWriteEnabled = true;
        searchParams = { id: 'session-1', sha: 'abc123' };
        routerBack.mockClear();
        hydrateReady = true;
        diffResponse.mockReset().mockResolvedValue({ success: true, diff: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n' });
        backoutResponse.mockReset().mockResolvedValue({ success: true });
        vi.mocked(operations.sessionScmDiffCommit).mockClear();
        vi.mocked(operations.sessionScmCommitBackout).mockClear();
        fixture = await createSessionFilesViewFixture({ credentials: { token: createAccountTokenForTests("alice", { currentAccount: true }) }, sessionId: 'session-1', rootPath: '/repo',
            request: createSessionReadBatchFetchBoundary(async (input, init) => {
                const path = new URL(String(input)).pathname;
                if (path !== '/v2/sessions/' + 'session-1') {
                    return /^\/v2\/sessions\/[^/]+$/.test(path)
                        ? Response.json({ error: 'Session not found' }, { status: 404 })
                        : new Response(null, { status: 404 });
                }
                if (hydrateReady) return Response.json(createPlainSessionByIdResponseFixture(fixture.session));
                return new Promise<Response>(resolve => {
                    const release = () => { pendingHydrationReads.delete(release); resolve(Response.json(createPlainSessionByIdResponseFixture(fixture.session))); };
                    pendingHydrationReads.add(release);
                    init?.signal?.addEventListener('abort', release, { once: true });
                });
            }),
            rpc: request => {
                if (request.method === RPC_METHODS.SCM_DIFF_COMMIT) return diffResponse(request);
                if (request.method === RPC_METHODS.SCM_COMMIT_BACKOUT) return backoutResponse(request);
                if (request.method === RPC_METHODS.SCM_LOG_LIST) return { success: true, entries: [] };
                return undefined;
            },
        });
        fixture.setSnapshot(fileViewSnapshot({ rootPath: '/repo', capabilities: { writeBackout: true } }));
        fixture.storage.setState({ isDataReady: true });
    });
    afterEach(async () => {
        standardCleanup();
        hydrateReady = true;
        for (const release of pendingHydrationReads) release();
        await fixture?.dispose();
        browser?.restore();
    });
    async function renderCommitScreen(Screen: React.ComponentType) {
        route.params = { ...searchParams, serverId: fixture.scope.serverId };
        fixture.storage.getState().applySettingsLocal({ experiments: true, featureToggles: {
            ...fixture.storage.getState().settings.featureToggles, 'scm.writeOperations': scmWriteEnabled,
        } });
        fixture.storage.setState({ localSettings: { ...fixture.storage.getState().localSettings, uiMultiPanePanelsEnabled: false } });
        const screen = await fixture.render(<Screen />);
        if (hydrateReady && searchParams.id) {
            await vi.waitFor(() => {
                const contentAdmitted = screen.findAllByType(SessionCommitDetailsView).length > 0;
                const invalidLinkAdmitted = Boolean(screen.findByTestId('session-invalid-link'));
                expect(contentAdmitted || invalidLinkAdmitted).toBe(true);
                expect(screen.findAllByTestId('scm-commit-details-loading')).toHaveLength(0);
            });
        }
        return screen;
    }

    it('renders commit diffs per file with syntax highlighting per filePath', async () => {
        diffResponse.mockResolvedValueOnce({
            success: true,
            diff: [
                'diff --git a/foo.ts b/foo.ts',
                '--- a/foo.ts',
                '+++ b/foo.ts',
                '@@ -1 +1 @@',
                '-old',
                '+new',
                'diff --git a/bar.ts b/bar.ts',
                '--- a/bar.ts',
                '+++ b/bar.ts',
                '@@ -1 +1 @@',
                '-a',
                '+b',
            ].join('\n'),
        });

        const Screen = (await import('@/app/(app)/session/[id]/commit')).default;
        const screen = await renderCommitScreen(Screen);

        expect(screen.findAllByType(DiffFilesListView)).toHaveLength(1);
        const list = screen.findByType(DiffFilesListView).props as React.ComponentProps<typeof DiffFilesListView>;
        expect(list.files).toHaveLength(2);
        const filePaths = (list.files ?? []).map((f) => String(f.filePath ?? ''));
        expect(filePaths).toContain('foo.ts');
        expect(filePaths).toContain('bar.ts');
    });

    it('loads commit diff after session path becomes available (deep-link hydration)', async () => {
        // Simulate a deep-link where storage isn't ready yet, then becomes ready with session metadata.
        hydrateReady = false;
        fixture.storage.setState({ isDataReady: false, sessions: {} });

        const { sessionScmDiffCommit } = await import('@/sync/ops');
        const Screen = (await import('@/app/(app)/session/[id]/commit')).default;

        const screen = await renderCommitScreen(Screen);

        // Still loading; no diff call yet.
        expect(screen.findAllByType(ActivitySpinner)).toHaveLength(1);
        expect(vi.mocked(sessionScmDiffCommit)).not.toHaveBeenCalled();

        // Storage rehydrates.
        hydrateReady = true;
        fixture.storage.getState().applySessions([fixture.session]);
        fixture.storage.setState({ isDataReady: true });
        for (const release of pendingHydrationReads) release();

        await screen.update(fixture.wrap(<Screen />));
        await flushHookEffects();

        expect(vi.mocked(sessionScmDiffCommit)).toHaveBeenCalled();
        const [, request] = vi.mocked(sessionScmDiffCommit).mock.calls.at(-1)!;
        expect(request.cwd).toBeUndefined();
        expect(request.commit).toBe('abc123');
    });

    it('shows missing context error when storage is ready but session is unknown', async () => {
        fixture.storage.setState({ isDataReady: true, sessions: {} });
        searchParams = { id: 'session-unknown', sha: 'abc123' } as any;
        const Screen = (await import('@/app/(app)/session/[id]/commit')).default;
        const screen = await renderCommitScreen(Screen);
        expect(screen.findByTestId('session-invalid-link')).toBeTruthy();
    });

    it('strips accidental whitespace suffixes from commit refs passed via URL params', async () => {
        // This mirrors the UI bug where a commit "ref" string included the oneline subject.
        searchParams = { id: 'session-1', sha: '0338a0f chore: stage b.txt' };

        const { sessionScmDiffCommit } = await import('@/sync/ops');
        const Screen = (await import('@/app/(app)/session/[id]/commit')).default;

        await renderCommitScreen(Screen);

        expect(vi.mocked(sessionScmDiffCommit)).toHaveBeenCalled();
        const [, request] = vi.mocked(sessionScmDiffCommit).mock.calls[0]!;
        expect(request.commit).toBe('0338a0f');
    });

    it('hides revert action when git write operations are disabled', async () => {
        scmWriteEnabled = false;
        const Screen = (await import('@/app/(app)/session/[id]/commit')).default;
        const screen = await renderCommitScreen(Screen);
        expect(screen.findAllByTestId('scm-commit-details-revert')).toHaveLength(0);
    });

    it('shows revert action when git write operations are enabled', async () => {
        scmWriteEnabled = true;
        const Screen = (await import('@/app/(app)/session/[id]/commit')).default;
        const screen = await renderCommitScreen(Screen);
        expect(screen.findByTestId('scm-commit-details-revert')).toBeTruthy();
    });

    it('shows a fallback error when loading commit diff throws', async () => {
        diffResponse.mockRejectedValueOnce(new Error('network down'));
        const Screen = (await import('@/app/(app)/session/[id]/commit')).default;
        const screen = await renderCommitScreen(Screen);
        // The SCM read classifier answers an unrecognized read failure with its safe copy; the raw
        // transport message is neither the headline, part of the card, nor its diagnostic marker.
        expect(screen.findByTestId('scm-commit-details-error')).toBeTruthy();
        const diagnostics = screen.findAll((node) => typeof node.props?.testID === 'string'
            && node.props.testID.startsWith('scm-commit-details-error-diagnostic-'))
            .map((node) => node.props.testID as string);
        expect(diagnostics).not.toHaveLength(0);
        expect(diagnostics.some((testID) => testID.includes('network down'))).toBe(false);
        expect(screen.getTextContent()).not.toContain('network down');
    });

    it('shows a back button when commit diff fails to load', async () => {
        diffResponse.mockResolvedValueOnce({
            success: false,
            error: 'Commit reference must not contain whitespace',
        });

        const Screen = (await import('@/app/(app)/session/[id]/commit')).default;
        const screen = await renderCommitScreen(Screen);
        expect(screen.findByTestId('scm-commit-details-error-secondary-action')).toBeTruthy();

        await screen.pressByTestIdAsync('scm-commit-details-error-secondary-action');
        expect(routerBack).toHaveBeenCalledTimes(1);
    });

    it('shows an error alert when revert throws unexpectedly', async () => {
        const { Modal } = await import('@/modal');
        backoutResponse.mockRejectedValueOnce(new Error('rpc unavailable'));
        const Screen = (await import('@/app/(app)/session/[id]/commit')).default;
        const screen = await renderCommitScreen(Screen);
        expect(screen.findByTestId('scm-commit-details-revert')).toBeTruthy();

        await screen.pressByTestIdAsync('scm-commit-details-revert');
        await flushHookEffects();

        // A thrown mutation transport error leaves the outcome unknown; the raw transport message
        // is not surfaced.
        expect(vi.mocked(Modal.alert)).toHaveBeenCalledWith('common.error', expect.stringMatching(/\S/));
        expect(vi.mocked(Modal.alert).mock.calls[0]?.[1]).not.toContain('rpc unavailable');
    });
});
