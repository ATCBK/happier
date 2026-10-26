import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createSessionFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { Session } from '@/sync/domains/state/storageTypes';
import { createSessionItemRowViewModel } from './sessionItemRowViewModelTestFixture';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const NOW_MS = 1_700_000_000_000;
const routerPush = vi.hoisted(() => vi.fn());
const rowPreferences = vi.hoisted(() => ({ backgroundWorkAttentionMode: 'keepWorking' as 'keepWorking' | 'keepWorkingUnread' | 'showUnread' }));

/**
 * The row's state vocabulary, as the reader hears it. Keyed exactly as the canonical `status`
 * namespace so a missing key would surface as the raw key rather than a plausible sentence.
 */
const ROW_STATUS_COPY: Readonly<Record<string, string>> = {
    'status.working': 'working...',
    'status.permissionRequired': 'permission required',
    'status.actionRequired': 'action required',
    'status.error': 'error',
    'status.readyForReview': 'ready for review',
    'status.ready': 'Ready',
    'status.unread': 'Unread',
    'status.queuedInput': 'Queued input',
    'status.online': 'online',
    'status.awaitingUpdates': 'Awaiting updates',
    'status.keptInAttention': 'kept in attention',
    'status.backgroundActive': 'working in background',
    'status.unknown': 'unknown',
    'workStatus.buckets.needs_you': 'Needs you',
};

// The shared press owner's motion tokens build their easing curves at import.
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});
vi.mock('react-native-gesture-handler', () => ({
    Swipeable: (props: Record<string, unknown>) => React.createElement('Swipeable', props),
    GestureDetector: (props: React.PropsWithChildren) => React.createElement('GestureDetector', props, props.children),
}));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown>) => React.createElement('DropdownMenu', props),
}));
vi.mock('@/components/ui/forms/dropdown/ContextMenu', () => ({
    ContextMenu: (props: Record<string, unknown>) => React.createElement('ContextMenu', props),
}));
vi.mock('@/components/ui/avatar/Avatar', () => ({ Avatar: 'Avatar' }));
vi.mock('@/agents/registry/AgentIcon', () => ({ AgentIcon: 'AgentIcon' }));
vi.mock('@/hooks/session/useNavigateToSession', () => ({ useNavigateToSession: () => vi.fn() }));
vi.mock('@/utils/platform/responsive', () => ({ useIsTablet: () => false }));
vi.mock('@/hooks/ui/useHappyAction', () => ({ useHappyAction: (fn: unknown) => [false, fn] }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => undefined) }));

installSessionShellCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ pathname: '/workflows/runs', router: { push: routerPush } }).module;
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({ Platform: { OS: 'web' } });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => ROW_STATUS_COPY[key] ?? key,
        });
    },
    storage: async () => {
        const { createStorageModuleStub, createUseSettingMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: createUseSettingMock({ fallback: (key) => key === 'sessionListBackgroundWorkAttentionModeV1' ? rowPreferences.backgroundWorkAttentionMode : undefined }),
            useHasUnreadMessages: () => false,
            useSession: () => null,
            useLocalSetting: ((_key: string) => null) as never,
        });
    },
});

// The shell testkit must receive its boundary options before its consumers load. Keep that work
// in collection, outside the observable assertion budget.
const { SessionItem } = await import('./SessionItem');

type RowStateCase = Readonly<{
    label: string;
    session: Partial<Session>;
    hasUnreadMessages?: boolean;
    /** The state phrase the single outer element must speak after the Session identity. */
    spoken: string | null;
    busy?: boolean;
    attentionStanding?: boolean;
}>;

/**
 * Every state this row can present is built from real Session facts and projected by the real
 * awareness/status owners, so a case that stops producing its state fails rather than silently
 * asserting the wrong label.
 */
const ROW_STATE_CASES: readonly RowStateCase[] = [
    { label: 'working', session: { thinking: true, thinkingAt: NOW_MS }, spoken: 'working...', busy: true },
    {
        label: 'permission required',
        session: { pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 0, pendingRequestObservedAt: NOW_MS },
        spoken: 'permission required',
    },
    {
        label: 'action required',
        session: { pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 1, pendingRequestObservedAt: NOW_MS },
        spoken: 'action required',
    },
    // A failed turn speaks only while its committed failure anchor is beyond this viewer's read cursor.
    { label: 'failed', session: { latestTurnStatus: 'failed', viewer: createSessionViewerFixture({ latestFailureSeq: 4,
        readState: { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: null },
        attention: { needsAttention: true, reasons: ['failed'], primary: 'failed', presentation: 'full' } }) }, spoken: 'error' },
    { label: 'ready', session: { latestReadyEventSeq: 4 }, spoken: 'ready for review' },
    { label: 'queued input', session: { pendingCount: 2 }, spoken: 'Queued input' },
    { label: 'unread', session: {}, hasUnreadMessages: true, spoken: 'Unread' },
    { label: 'attention', session: {}, attentionStanding: true, spoken: 'kept in attention' },
    { label: 'quiet', session: {}, spoken: null },
];

function createRowSession(overrides: Partial<Session>, id: string): Session {
    return createSessionFixture({
        id,
        // `live` runtime evidence is the precondition for every operational state below; without it
        // the canonical projection reports staleness instead and the row would say so.
        active: true,
        presence: 'online',
        activeAt: NOW_MS,
        createdAt: NOW_MS,
        updatedAt: NOW_MS,
        metadata: {
            name: 'Row name',
            path: '/Users/tester/project',
            host: 'tester.local',
            homeDir: '/Users/tester',
            machineId: 'machine-1',
        } as Session['metadata'],
        ...overrides,
    });
}

async function renderRow(input: Readonly<{
    testCase: RowStateCase;
    id: string;
    density: 'default' | 'minimal';
    secondaryLineMode: 'status' | 'path';
}>) {
    const { getSessionStatus } = await import('@/utils/sessions/sessionUtils');
    const session = createRowSession(input.testCase.session, input.id);
    const rowViewModel = createSessionItemRowViewModel({
        session,
        overrides: {
            // The canonical localized status owner, not a hand-written row status.
            sessionStatus: getSessionStatus(session, NOW_MS, { workingTextMode: 'static' }),
            hasUnreadMessages: input.testCase.hasUnreadMessages === true,
            attentionStanding: input.testCase.attentionStanding === true,
            secondaryLineMode: input.secondaryLineMode,
            subtitleOverride: input.secondaryLineMode === 'path' ? '~/project' : null,
        },
    });
    const screen = await renderScreen(
        <SessionItem
            session={session}
            rowViewModel={rowViewModel}
            compact={input.density === 'minimal'}
            compactMinimal={input.density === 'minimal'}
        />,
    );
    return { screen, session };
}

function readOuterRow(screen: Awaited<ReturnType<typeof renderRow>>['screen'], id: string) {
    const row = screen.findByTestId(`session-list-item-${id}`);
    expect(row).not.toBeNull();
    return row!;
}

describe('SessionItem outer row accessible semantics', () => {
    beforeEach(() => {
        // Only the clock is pinned: faking timers as well would stall the async render helpers,
        // and these cases depend on runtime freshness, not on scheduled work.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW_MS));
    });

    afterEach(() => {
        vi.useRealTimers();
        routerPush.mockReset();
        rowPreferences.backgroundWorkAttentionMode = 'keepWorking';
        standardCleanup();
    });

    it.each(['default', 'minimal'] as const)('shows and announces background work plus unread across every preference in %s density', async (density) => {
        for (const mode of ['keepWorking', 'keepWorkingUnread', 'showUnread'] as const) {
            rowPreferences.backgroundWorkAttentionMode = mode;
            const id = `background-unread-${mode}-${density}`;
            const { screen } = await renderRow({
                testCase: { label: 'background unread', session: {
                    latestTurnStatus: 'completed', latestTurnStatusObservedAt: NOW_MS,
                    runtimeActivityState: 'active', runtimeActivityActiveCount: 1,
                    runtimeActivityObservedAt: NOW_MS, runtimeActivityRevision: 1,
                }, hasUnreadMessages: true, spoken: null },
                id, density, secondaryLineMode: 'status',
            });
            const row = readOuterRow(screen, id);
            expect(String(row.props.accessibilityLabel)).toContain('Unread');
            expect(String(row.props.accessibilityLabel)).toMatch(/background/i);
            expect(String(row.props.accessibilityLabel)).not.toMatch(/ready for review/i);
            expect(row.props.accessibilityState.busy).toBe(true);
            const suffix = density === 'minimal' ? 'trailing' : 'secondary';
            if (mode === 'keepWorking') {
                expect(screen.findByTestId(`session-row-attention-indicator-spinner-${id}-${suffix}`)).toBeTruthy();
                expect(screen.findByTestId(`session-row-unread-indicator-${id}-${suffix}`)).toBeNull();
            } else {
                expect(screen.findByTestId(`session-row-attention-indicator-dot-${id}-${suffix}`)).toBeTruthy();
            }
            standardCleanup();
        }
    });

    it.each(['keepWorking', 'keepWorkingUnread', 'showUnread'] as const)('preserves a modern viewer unseen reply cue with raw unread false in %s until read', async (mode) => {
        rowPreferences.backgroundWorkAttentionMode = mode;
        const { getSessionStatus } = await import('@/utils/sessions/sessionUtils');
        const viewer = createSessionViewerFixture({
            readState: { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: null },
            attention: { needsAttention: true, reasons: ['ready_after_read'], primary: 'ready_after_read', presentation: 'full' },
        });
        const id = `modern-reply-${mode}`;
        const session = createRowSession({ viewer, latestTurnStatus: 'completed', latestTurnStatusObservedAt: NOW_MS,
            latestReadyEventSeq: 4, runtimeActivityState: 'active', runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: NOW_MS, runtimeActivityRevision: 1 }, id);
        const element = (current: Session) => <SessionItem session={current} compact compactMinimal
            rowViewModel={createSessionItemRowViewModel({ session: current, overrides: {
                sessionStatus: getSessionStatus(current, NOW_MS, { workingTextMode: 'static' }),
                hasUnreadMessages: false, secondaryLineMode: 'status',
            } })} />;
        const screen = await renderScreen(element(session));
        expect(readOuterRow(screen, id).props.accessibilityLabel).toContain('Unread');
        expect(readOuterRow(screen, id).props.accessibilityLabel).toMatch(/background/i);
        expect(readOuterRow(screen, id).props.accessibilityLabel).not.toMatch(/ready for review/i);
        if (mode === 'keepWorking') {
            expect(screen.findByTestId(`session-row-unread-indicator-${id}-trailing`)).toBeNull();
            expect(screen.findByTestId(`session-row-attention-indicator-spinner-${id}-trailing`)).toBeTruthy();
        } else {
            expect(screen.findByTestId(`session-row-attention-indicator-dot-${id}-trailing`)).toBeTruthy();
        }
        const readViewer = createSessionViewerFixture({
            readState: { state: 'tracking', lastViewedSessionSeq: 4, unreadSince: null },
        });
        await screen.update(element({ ...session, seq: 4, viewer: readViewer }));
        expect(readOuterRow(screen, id).props.accessibilityLabel).not.toContain('Unread');
        expect(readOuterRow(screen, id).props.accessibilityLabel).toMatch(/background/i);
        expect(screen.findByTestId(`session-row-unread-indicator-${id}-trailing`)).toBeNull();
        expect(screen.findByTestId(`session-row-attention-indicator-spinner-${id}-trailing`)).toBeTruthy();
        expect(session.viewer).toBe(viewer);
        expect(viewer.attention.primary).toBe('ready_after_read');
    });

    it('keeps the modern viewer ready label when no background work remains', async () => {
        const { screen } = await renderRow({ id: 'modern-ready-settled', density: 'minimal', secondaryLineMode: 'status',
            testCase: { label: 'ready', spoken: null, hasUnreadMessages: false, session: {
                latestTurnStatus: 'completed', latestTurnStatusObservedAt: NOW_MS, latestReadyEventSeq: 4,
                runtimeActivityState: 'idle', runtimeActivityActiveCount: 0,
                viewer: createSessionViewerFixture({ readState: { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: null },
                    attention: { needsAttention: true, reasons: ['ready_after_read'], primary: 'ready_after_read', presentation: 'full' } }),
            } },
        });
        expect(readOuterRow(screen, 'modern-ready-settled').props.accessibilityLabel).toContain('ready for review');
        expect(screen.findByTestId('session-row-unread-indicator-modern-ready-settled-trailing')).toBeNull();
    });

    it('keeps reports disclosure independent of Session navigation', async () => {
        const session = createRowSession({ managedSessions: { total: 4, working: 0, needsYou: 2, stalled: 0, finished: 0, attentionPrimary: null } }, 'lead');
        const onSetReportsCollapsed = vi.fn();
        const screen = await renderScreen(<SessionItem session={session}
            rowViewModel={createSessionItemRowViewModel({ session })}
            reportsDisclosure="expanded" onSetReportsCollapsed={onSetReportsCollapsed} />);
        const disclosure = screen.findByTestId('session-row-reports-disclosure:lead');
        expect(disclosure).not.toBeNull();
        const ancestors: string[] = [];
        for (let node = disclosure!.parent; node; node = node.parent) {
            if (typeof node.props.testID === 'string') ancestors.push(node.props.testID);
        }
        expect(ancestors).not.toContain('session-list-item-lead');
        screen.pressByTestId('session-row-reports-disclosure:lead');
        expect(onSetReportsCollapsed).toHaveBeenCalledWith(expect.any(String), true);
        expect(screen.findByTestId('session-list-item-lead')?.props.onPress).toBeTypeOf('function');
    });

    for (const density of ['default', 'minimal'] as const) {
        it(`speaks the Session identity and every presented state on the single ${density} row element`, async () => {
            const spokenNames: string[] = [];
            for (const testCase of ROW_STATE_CASES) {
                const id = `row-${density}-${testCase.label.replace(/\s+/g, '-')}`;
                const { screen } = await renderRow({ testCase, id, density, secondaryLineMode: 'status' });
                const row = readOuterRow(screen, id);

                expect(row.props.accessibilityRole).toBe('button');
                expect(row.props.accessibilityState).toEqual({
                    selected: false,
                    busy: testCase.busy === true,
                });
                expect(row.props['aria-pressed']).toBe(false);
                expect(row.props['aria-busy']).toBe(testCase.busy === true);
                const accessibilityLabel = String(row.props.accessibilityLabel ?? '');
                expect(accessibilityLabel).toBe(
                    testCase.spoken === null ? 'Row name' : `Row name. ${testCase.spoken}`,
                );
                spokenNames.push(accessibilityLabel);

                // The marker beside the name stays decorative: it must never become a second
                // focusable element or a second way to hear the same state.
                const marker = screen.findByTestId(`session-row-attention-indicator-${id}`);
                if (marker) {
                    expect(marker.props.accessible).toBe(false);
                    expect(marker.props.accessibilityElementsHidden).toBe(true);
                    expect(marker.props.importantForAccessibility).toBe('no-hide-descendants');
                }
                standardCleanup();
            }

            // A name that repeats across states is a row a reader cannot tell apart.
            expect(new Set(spokenNames).size).toBe(spokenNames.length);
        });
    }

    it('keeps the path-variant row speaking its unread state rather than only its name', async () => {
        const unreadCase = ROW_STATE_CASES.find((entry) => entry.label === 'unread')!;
        const quietCase = ROW_STATE_CASES.find((entry) => entry.label === 'quiet')!;

        const unread = await renderRow({
            testCase: unreadCase,
            id: 'row-path-unread',
            density: 'default',
            secondaryLineMode: 'path',
        });
        expect(readOuterRow(unread.screen, 'row-path-unread').props.accessibilityLabel)
            .toBe('Row name. Unread');
        standardCleanup();

        const quiet = await renderRow({
            testCase: quietCase,
            id: 'row-path-quiet',
            density: 'default',
            secondaryLineMode: 'path',
        });
        expect(readOuterRow(quiet.screen, 'row-path-quiet').props.accessibilityLabel)
            .toBe('Row name');
    });

    it('exposes exactly one actionable element for the row itself', async () => {
        const readyCase = ROW_STATE_CASES.find((entry) => entry.label === 'ready')!;
        const { screen } = await renderRow({
            testCase: readyCase,
            id: 'row-single-actionable',
            density: 'minimal',
            secondaryLineMode: 'status',
        });
        const row = readOuterRow(screen, 'row-single-actionable');
        const rowPressables = screen.tree.root.findAll((node) => (
            // A host element's node type is its tag string; components never stringify to it.
            String(node.type) === 'Pressable'
            && node.props?.testID === 'session-list-item-row-single-actionable'
        ));
        expect(rowPressables).toHaveLength(1);
        expect(rowPressables[0].props.accessibilityLabel).toBe(row.props.accessibilityLabel);
    });

    it('colours the status word by the shared work-status tone: healthy work stays quiet, needs-you and trouble speak', async () => {
        const { lightTheme } = await import('@/theme');
        const { workStatusWordStyle } = await import('@/components/work/status/workStatusTreatment');
        const quiet = lightTheme.colors.text.secondary;
        const attention = (workStatusWordStyle('attention') as { color: string }).color;
        const danger = (workStatusWordStyle('danger') as { color: string }).color;
        const expectations: Readonly<Record<string, string>> = {
            // Working and ready used to be drawn blue and green; a healthy row is quiet (INT §5.3).
            working: quiet,
            ready: quiet,
            'permission required': attention,
            'action required': attention,
            failed: danger,
        };
        for (const [label, color] of Object.entries(expectations)) {
            const testCase = ROW_STATE_CASES.find((entry) => entry.label === label)!;
            const id = `row-tone-${label.replace(/\s+/g, '-')}`;
            const { screen } = await renderRow({ testCase, id, density: 'default', secondaryLineMode: 'status' });
            const word = screen.findAll((node) => (
                typeof node.props?.testID === 'string'
                && node.props.testID.startsWith(`session-list-status-subtitle-text-${id}-`)
            ))[0];
            expect(word, label).toBeDefined();
            const flat = Object.assign({}, ...[word!.props.style].flat(Infinity).filter(Boolean));
            expect([label, flat.color]).toEqual([label, color]);
            standardCleanup();
        }
    });

    it('keeps an unknown status quiet: never a status-word headline, in either secondary-line mode', async () => {
        const { getSessionStatus } = await import('@/utils/sessions/sessionUtils');
        for (const secondaryLineMode of ['status', 'path'] as const) {
            const id = `row-unknown-${secondaryLineMode}`;
            // An offline Bot's row before any decryption owner has settled its content key.
            const session = createRowSession({
                active: false, encryptionMode: 'e2ee', encryptedContentAvailability: undefined,
            }, id);
            const sessionStatus = getSessionStatus(session, NOW_MS, { workingTextMode: 'static' });
            expect(sessionStatus.state).toBe('unknown');
            const rowViewModel = createSessionItemRowViewModel({
                session,
                overrides: {
                    sessionStatus,
                    secondaryLineMode,
                    subtitleOverride: secondaryLineMode === 'path' ? '~/project' : null,
                },
            });
            const screen = await renderScreen(<SessionItem session={session} rowViewModel={rowViewModel} />);
            const words = screen.findAll((node) => (
                typeof node.props?.testID === 'string'
                && node.props.testID.startsWith(`session-list-status-subtitle-text-${id}-`)
            ));
            expect([secondaryLineMode, words.length]).toEqual([secondaryLineMode, 0]);
            expect(readOuterRow(screen, id).props.accessibilityLabel ?? '').not.toContain('unknown');
            standardCleanup();
        }
    });
});
