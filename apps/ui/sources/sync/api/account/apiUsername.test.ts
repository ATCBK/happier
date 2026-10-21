import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { HappyError } from '@/utils/errors/errors';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { profileDefaults } = await import('@/sync/domains/profiles/profile');
const { storage } = await import('@/sync/domains/state/storageStore');
const { activateStorageAccountScope } = await import('@/dev/testkit/runtime/storageRuntime');
const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const credentials = { token: createAccountTokenForTests('account-a', { currentAccount: true }) };
let serverId: string;
let disposeScope: (() => void) | undefined;

beforeEach(async () => {
    resetScopedHomeActionExecutorsForTests();
    await homes.reset();
    await loadSyncSingletonForTests();
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    serverId = await homes.addHome({ name: 'Username Home', serverUrl: 'https://api.example.test', accountId: 'account-a', currentAccount: true });
    storage.getState().applyProfile({ ...profileDefaults, id: 'account-a', timestamp: 1, name: 'Alice' });
    const active = await activateStorageAccountScope({ serverId: getActiveServerSnapshot().serverId, accountId: 'account-a' });
    disposeScope = () => active.dispose();
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    storage.setState({ endpointStatus: 'online' });
});

afterEach(async () => {
    vi.useRealTimers();
    disposeScope?.();
    disposeScope = undefined;
    await homes.reset();
});

function installResponse(body: unknown, status = 200, invalidJson = false) {
    homes.answer(serverId, 'POST /v1/account/username', { body: invalidJson ? 'invalid json' : body, status });
}

describe('setAccountUsername', () => {
    it('checks the returned normalized candidate without changing the active identity', async () => {
        const result = { username: 'candidate', availability: 'unavailable', suggestions: ['candidate1', 'candidate2'] };
        homes.answer(serverId, 'POST /v1/account/username/check', { body: result });
        const { checkAccountUsername } = await import('./apiUsername');
        expect(await checkAccountUsername(credentials, 'Candidate')).toEqual(result);
        expect(homes.requestsFor('/v1/account/username/check')).toEqual([
            expect.objectContaining({ serverId, token: credentials.token, input: { username: 'Candidate' } }),
        ]);
        expect(storage.getState().profile.username).toBeNull();
    });

    it('does not retry the captured bearer against a successor Home after a transient failure', async () => {
        let observeIssued!: () => void;
        const issued = new Promise<void>((resolve) => { observeIssued = resolve; });
        let releaseFailure!: () => void;
        const failure = new Promise<void>((resolve) => { releaseFailure = resolve; });
        homes.answer(serverId, 'POST /v1/account/username', { select: async () => {
            observeIssued();
            await failure;
            return { status: 503, body: {} };
        } });
        const { setAccountUsername } = await import('./apiUsername');
        const outcome = setAccountUsername(credentials, 'alice').then(
            (value) => ({ status: 'fulfilled' as const, value }),
            (reason: unknown) => ({ status: 'rejected' as const, reason }),
        );
        await issued;
        vi.useFakeTimers();
        expect(homes.requestsFor('/v1/account/username')).toEqual([
            expect.objectContaining({ serverId, token: credentials.token, input: { username: 'alice' } }),
        ]);
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://other.example.test', scope: 'device' });
        releaseFailure();
        await vi.advanceTimersByTimeAsync(1_000);
        const settled = await outcome;
        expect(homes.requestsFor('/v1/account/username')).toHaveLength(1);
        expect(settled).toMatchObject({ status: 'rejected', reason: { name: 'HappyError', message: 'account_username_stale_scope' } });
    });

    it('returns the username on success', async () => {
        installResponse({ username: 'alice' });
        const { setAccountUsername } = await import('./apiUsername');
        expect(await setAccountUsername(credentials, 'alice')).toEqual({ username: 'alice' });
        expect(homes.requestsFor('/v1/account/username')).toEqual([expect.objectContaining({ serverId, token: credentials.token, input: { username: 'alice' } })]);
    });

    it('throws HappyError(username-taken) on 409 username-taken', async () => {
        installResponse({ error: 'username-taken' }, 409);
        const { setAccountUsername } = await import('./apiUsername');
        await expect(setAccountUsername(credentials, 'alice')).rejects.toMatchObject({
            name: 'HappyError', message: 'username-taken', status: 409,
        } satisfies Partial<HappyError>);
    });

    it('throws HappyError(invalid-username) on 400 invalid-username', async () => {
        installResponse({ error: 'invalid-username' }, 400);
        const { setAccountUsername } = await import('./apiUsername');
        await expect(setAccountUsername(credentials, 'bad')).rejects.toMatchObject({
            name: 'HappyError', message: 'invalid-username', status: 400,
        } satisfies Partial<HappyError>);
    });

    it('maps username-disabled to config-kind HappyError', async () => {
        installResponse({ error: 'username-disabled' }, 400);
        const { setAccountUsername } = await import('./apiUsername');
        await expect(setAccountUsername(credentials, 'alice')).rejects.toMatchObject({
            name: 'HappyError', message: 'username-disabled', kind: 'config', status: 400,
        } satisfies Partial<HappyError>);
    });

    it('falls back to default 4xx message when error body is not JSON', async () => {
        installResponse(null, 400, true);
        const { setAccountUsername } = await import('./apiUsername');
        await expect(setAccountUsername(credentials, 'alice')).rejects.toMatchObject({
            name: 'HappyError', message: 'Failed to set username', kind: 'server', status: 400,
        } satisfies Partial<HappyError>);
    });

    it('throws parse error when success payload does not include username', async () => {
        installResponse({ ok: true });
        const { setAccountUsername } = await import('./apiUsername');
        await expect(setAccountUsername(credentials, 'alice')).rejects.toThrow('Failed to parse set username response');
    });

    it.each([408, 429])('retains retryable HTTP %s behavior and publishes the eventual acknowledgement', async (status) => {
        let answered = false;
        homes.answer(serverId, 'POST /v1/account/username', { select: () => {
            if (answered) return { body: { username: 'eventual' } };
            answered = true;
            return { status, body: {} };
        } });
        const { setAccountUsername } = await import('./apiUsername');
        await expect(setAccountUsername(credentials, 'requested')).resolves.toEqual({ username: 'eventual' });
        expect(storage.getState().profile.username).toBe('eventual');
    });
});
