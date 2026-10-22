import { afterEach, expect, it, vi } from 'vitest';
import { createDeferred, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { SessionSkillCatalogListResponseV1Schema } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';

installDisconnectedServerSocketBoundary();
const transport = vi.hoisted(() => vi.fn<(input: Readonly<{ signal?: AbortSignal }>) => Promise<unknown>>());
// Only the remote Session RPC is replaced; scope, store publication and catalog parsing stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', async importOriginal => {
    const { installServerScopedSessionRpcModuleMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return installServerScopedSessionRpcModuleMock({ sessionRpcWithServerScope: params => transport(params) as never })(importOriginal);
});
const { storage } = await import('@/sync/domains/state/storage');
const { seedAutocompleteSessions } = await import('@/components/autocomplete/autocompleteTestFixtures');
const { ensureSessionSuggestionCatalogs } = await import('./sessionCatalogs');

afterEach(() => { standardCleanup(); transport.mockReset(); });

it.each([null, 'first', 'second'] as const)('shares simultaneous Session catalog reads and publications with independent cancellation (%s)', async cancel => {
    const home = await createPlainArtifactHomeFixture(`https://session-catalog-sharing-${cancel}.test`);
    seedAutocompleteSessions({ shared: { serverId: home.home.id, active: true, metadata: { path: '/repo' } } });
    const answer = createDeferred<unknown>();
    transport.mockImplementation(() => answer.promise);
    const firstController = new AbortController();
    const secondController = new AbortController();
    let publications = 0;
    const unsubscribe = storage.subscribe((next, previous) => { if (next.sessions !== previous.sessions) publications++; });
    const first = ensureSessionSuggestionCatalogs('shared', { skills: true }, { signal: firstController.signal });
    const second = ensureSessionSuggestionCatalogs('shared', { skills: true }, { signal: secondController.signal });
    try {
        await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
        if (cancel) {
            const cancelled = vi.fn();
            const pending = cancel === 'first' ? first : second;
            void pending.then(cancelled);
            (cancel === 'first' ? firstController : secondController).abort();
            await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
            expect(transport.mock.calls[0]![0].signal?.aborted).toBe(false);
            expect(publications).toBe(0);
        }
        answer.resolve(SessionSkillCatalogListResponseV1Schema.parse({ skills: [{ name: 'review', origin: 'vendor', backendId: 'codex' }] }));
        await Promise.all([first, second]);
        expect(publications).toBe(1);
        expect(storage.getState().sessions.shared?.metadata?.sessionSkillCatalogV1).toMatchObject({ skills: [expect.objectContaining({ name: 'review' })] });
    } finally {
        answer.resolve(SessionSkillCatalogListResponseV1Schema.parse({ skills: [] }));
        await Promise.allSettled([first, second]);
        unsubscribe();
        await home.dispose();
    }
});

it('starts a fresh Session catalog read for changed inputs and ignores an older completion', async () => {
    const home = await createPlainArtifactHomeFixture('https://session-catalog-freshness.test');
    seedAutocompleteSessions({ shared: { serverId: home.home.id, active: true, metadata: { path: '/old' } } });
    const oldAnswer = createDeferred<unknown>();
    const newAnswer = createDeferred<unknown>();
    transport.mockImplementationOnce(() => oldAnswer.promise).mockImplementationOnce(() => newAnswer.promise);
    const first = ensureSessionSuggestionCatalogs('shared', { skills: true });
    let second: Promise<void> | undefined;
    try {
        await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
        seedAutocompleteSessions({ shared: { serverId: home.home.id, active: true, metadata: { path: '/new' } } });
        second = ensureSessionSuggestionCatalogs('shared', { skills: true });
        await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
        newAnswer.resolve(SessionSkillCatalogListResponseV1Schema.parse({ skills: [{ name: 'current', origin: 'vendor', backendId: 'codex' }] }));
        await second;
        oldAnswer.resolve(SessionSkillCatalogListResponseV1Schema.parse({ skills: [{ name: 'obsolete', origin: 'vendor', backendId: 'codex' }] }));
        await first;
        expect(storage.getState().sessions.shared?.metadata?.sessionSkillCatalogV1).toMatchObject({ skills: [expect.objectContaining({ name: 'current' })] });
    } finally {
        oldAnswer.resolve(SessionSkillCatalogListResponseV1Schema.parse({ skills: [] }));
        newAnswer.resolve(SessionSkillCatalogListResponseV1Schema.parse({ skills: [] }));
        await Promise.allSettled([first, second]);
        await home.dispose();
    }
});
