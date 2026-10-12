import { beforeAll, describe, expect, it, vi } from 'vitest';

// Only native styling, icon rendering and navigation are platform boundaries.
// Keep the disclosure, text, storage and all internal presentation/domain owners real.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

describe('buildNewSessionLaunchStatus', () => {
    let buildNewSessionLaunchStatus: typeof import('./newSessionLaunchStatusBadges').buildNewSessionLaunchStatus;
    beforeAll(async () => {
        ({ buildNewSessionLaunchStatus } = await import('./newSessionLaunchStatusBadges'));
    }, 120_000);

    it('states why creation is blocked on the status line, not as a badge, and withdraws it once ready', () => {
        const blocked = buildNewSessionLaunchStatus({
            isCreating: false,
            disabledReason: 'Selected credentials are unavailable',
            requesterDisclosure: { owner: 'Alice', machine: 'devbox', signIn: 'full' },
            translate: (key) => key,
        });
        // The status line above the card carries the cause (left, like a session's status);
        // badges on the right keep only facts with their own detail.
        expect(blocked.line).toEqual({ kind: 'blocked', text: 'Selected credentials are unavailable' });
        expect(blocked.badges.map((badge) => badge.key)).toEqual(['machine-requester-disclosure']);

        expect(buildNewSessionLaunchStatus({ isCreating: false, disabledReason: null, translate: (key) => key }))
            .toEqual({ line: null, badges: [] });
    });

    it('does not say again a cause the composer already shows as its own banner', () => {
        const reason = 'Claude · Needs sign-in';
        // The agent blocker banner above the card says it with its action: the status line stays out of it.
        expect(buildNewSessionLaunchStatus({ isCreating: false, disabledReason: reason, causeShownElsewhere: reason, translate: (key) => key }).line).toBeNull();
        // Another cause is still said.
        expect(buildNewSessionLaunchStatus({ isCreating: false, disabledReason: 'No path selected', causeShownElsewhere: reason, translate: (key) => key }).line)
            .toEqual({ kind: 'blocked', text: 'No path selected' });
    });

    it('keeps the requester disclosure as a badge with its detail popover', () => {
        const status = buildNewSessionLaunchStatus({
            isCreating: false,
            requesterDisclosure: { owner: 'Alice', machine: 'devbox', signIn: 'full' },
            translate: (key) => key,
        });
        expect(status.line).toBeNull();
        expect(status.badges).toEqual([expect.objectContaining({
            key: 'machine-requester-disclosure',
            label: 'Runs on Alice’s devbox',
            renderPopover: expect.any(Function),
        })]);
    });

    it('says the launch is in progress on the status line while a spawn request is unresolved', () => {
        const translate = vi.fn((key: string) => key);
        const status = buildNewSessionLaunchStatus({
            isCreating: true,
            disabledReason: 'Selected credentials are unavailable',
            translate,
        });
        expect(status).toEqual({ line: { kind: 'starting', text: 'newSession.startingSession' }, badges: [] });
        expect(translate).toHaveBeenCalledWith('newSession.startingSession');
    });
    it.each(['machine', 'temporary_computer'] as const)('leaves progress to the active %s launch presentation', (launchPresentation) => {
        const status = buildNewSessionLaunchStatus({
            isCreating: true, launchPresentation,
            requesterDisclosure: { owner: 'Alice', machine: 'devbox', signIn: 'full' },
            translate: key => key,
        });
        expect(status.line).toBeNull();
        expect(status.badges.map(badge => badge.key)).toEqual(['machine-requester-disclosure']);
    });
});
