/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { renderHook, act, createDeferred, standardCleanup } = await import('@/dev/testkit');
const { useSessionScmDraft } = await import('./useSessionScmDraft');

afterEach(async () => { standardCleanup(); await homes.reset(); });

describe('mounted Session SCM drafts', () => {
    it('keeps the pending description and late arrival across placements without losing intervening text', async () => {
        const serverId = await homes.addHome({ name: 'Draft Home', serverUrl: 'https://scm-draft.example.test', accountId: 'draft-account' });
        const input = { sessionId: 'draft-session', serverId };
        const sidebar = await renderHook(() => useSessionScmDraft(input));
        const key = JSON.stringify(['/repo', 'feature', 'dev']);
        await act(async () => sidebar.getCurrent().setPullRequest({ title: 'Describe the changes', body: '', draft: true, base: 'dev',
            bodyDraft: { key, attempt: { bodyAtRequest: '', baselineResultId: 'earlier-result', baselineRevision: 1, started: null }, candidate: null } }));
        const received = createDeferred<string>();
        const writeArrival = sidebar.getCurrent().setPullRequest;
        const pending = received.promise.then(candidate => writeArrival(current => current ? { ...current,
            bodyDraft: { key, attempt: null, candidate } } : null));
        await sidebar.unmount();
        const details = await renderHook(() => useSessionScmDraft(input));
        expect(details.getCurrent().draft.pullRequest?.bodyDraft?.attempt?.started).toBeNull();
        await act(async () => details.getCurrent().setPullRequest(current => current ? { ...current, body: 'My notes' } : null));
        await act(async () => { received.resolve('Generated description'); await pending; });
        expect(details.getCurrent().draft.pullRequest).toMatchObject({ title: 'Describe the changes', body: 'My notes', draft: true,
            bodyDraft: { key, attempt: null, candidate: 'Generated description' } });
        await details.unmount();
        const movedBack = await renderHook(() => useSessionScmDraft(input));
        expect(movedBack.getCurrent().draft.pullRequest?.bodyDraft?.candidate).toBe('Generated description');
        const otherSession = await renderHook(() => useSessionScmDraft({ ...input, sessionId: 'another-session' }));
        expect(otherSession.getCurrent().draft.pullRequest).toBeNull();
    });
});
