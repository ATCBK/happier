import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
import { HAPPIER_REPLAY_MIN_SEED_CHARS } from '@happier-dev/protocol/sessions/replay-seed-budget';
import { renderScreen as renderBaseScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { settingsParse } from '@/sync/domains/settings/settings';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import {
    installSessionSettingsEntryModuleMocks,
    resetSessionSettingsEntryState,
    sessionSettingsEntryState,
} from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionSettingsEntryModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            useWindowDimensions: () => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }),
        });
    },
});
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { Item } = await import('@/components/ui/lists/Item');
const { LlmTaskRunnerConfigV1BackendModelPicker } = await import('@/components/settings/llmTasks/LlmTaskRunnerConfigV1BackendModelPicker');
await import('@/app/(app)/settings/session/resume');
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;

async function renderScreen(element: React.ReactElement) {
    account = await createSecretSettingsTestHarness({ settings: settingsParse({
        ...sessionSettingsEntryState.settingsState,
        experiments: true,
        featureToggles: { 'execution.runs': executionRunsEnabledState.enabled },
    }), sharedEnabled: false });
    const credentials = account.credentials;
    const wrapper = ({ children }: React.PropsWithChildren) => <InjectedAuthProvider credentials={credentials}>{children}</InjectedAuthProvider>;
    return renderBaseScreen(element, { wrapper });
}

const executionRunsEnabledState = { enabled: true };

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => ['claude'],
}));

vi.mock('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState', () => ({
    useNewSessionPreflightModelsState: () => ({
        modelOptions: [],
        probe: { phase: 'idle', refresh: vi.fn() },
    }),
}));

beforeEach(() => {
    resetSessionSettingsEntryState();
    executionRunsEnabledState.enabled = true;
    sessionSettingsEntryState.settingsState.sessionReplayEnabled = true;
    sessionSettingsEntryState.settingsState.sessionReplayStrategy = 'summary_plus_recent';
    sessionSettingsEntryState.settingsState.sessionReplayRecentMessagesCount = 100;
    sessionSettingsEntryState.settingsState.sessionReplayMaxSeedChars = 50_000;
    sessionSettingsEntryState.settingsState.sessionReplaySummaryRunnerV1 = null;
});

afterEach(async () => {
    await standardCleanup();
    await account?.dispose();
    account = undefined;
    executionRunsEnabledState.enabled = true;
    resetSessionSettingsEntryState();
});

const MAX_SEED_CHARS_FIELD_TEST_ID = 'settings-session-replay-maxSeedChars-input';

type ScreenLike = Pick<Awaited<ReturnType<typeof renderBaseScreen>>, 'findAllByType'>;

/** Read the real budget row's public field after its owner resolves the draft. */
function maxSeedCharsRows(screen: ScreenLike) {
    return screen.findAllByType(Item).filter(node => node.props?.rightElement?.props?.testID === MAX_SEED_CHARS_FIELD_TEST_ID);
}

function maxSeedCharsField(screen: ScreenLike) {
    const [row] = maxSeedCharsRows(screen);
    if (!row) throw new Error('Missing the max seed chars field');
    return row.props.rightElement.props;
}

describe('Session resume settings (Replay summary runner controls)', () => {
    it('renders a max seed chars input when replay is enabled', async () => {
        executionRunsEnabledState.enabled = true;
        sessionSettingsEntryState.settingsState.sessionReplayEnabled = true;

        const mod = await import('@/app/(app)/settings/session/resume');
        const SessionResumeSettingsScreen = mod.default;

        const screen = await renderScreen(React.createElement(SessionResumeSettingsScreen));

        expect(maxSeedCharsRows(screen)).toHaveLength(1);
    });

    it('renders summary runner inputs when replay is enabled, strategy is summary_plus_recent, and execution runs are enabled', async () => {
        executionRunsEnabledState.enabled = true;
        sessionSettingsEntryState.settingsState.sessionReplayEnabled = true;
        sessionSettingsEntryState.settingsState.sessionReplayStrategy = 'summary_plus_recent';

        const mod = await import('@/app/(app)/settings/session/resume');
        const SessionResumeSettingsScreen = mod.default;

        const screen = await renderScreen(React.createElement(SessionResumeSettingsScreen));
        const summaryRunnerPickers = screen.findAllByType(LlmTaskRunnerConfigV1BackendModelPicker);

        expect(summaryRunnerPickers).toHaveLength(1);
        expect(summaryRunnerPickers[0]?.props?.backendTestID).toBe('settings-session-replay-summaryRunner-backend');
        expect(summaryRunnerPickers[0]?.props?.modelTestID).toBe('settings-session-replay-summaryRunner-model');
    });

    it('does not render summary runner inputs when execution runs are disabled', async () => {
        executionRunsEnabledState.enabled = false;
        sessionSettingsEntryState.settingsState.sessionReplayEnabled = true;
        sessionSettingsEntryState.settingsState.sessionReplayStrategy = 'summary_plus_recent';

        const mod = await import('@/app/(app)/settings/session/resume');
        const SessionResumeSettingsScreen = mod.default;

        const screen = await renderScreen(React.createElement(SessionResumeSettingsScreen));
        const summaryRunnerPickers = screen.findAllByType(LlmTaskRunnerConfigV1BackendModelPicker);

        expect(summaryRunnerPickers).toHaveLength(0);
    });

    it.each([
        { typed: String(HAPPIER_REPLAY_MIN_SEED_CHARS), stored: HAPPIER_REPLAY_MIN_SEED_CHARS },
        { typed: String(HAPPIER_REPLAY_MIN_SEED_CHARS + 500), stored: HAPPIER_REPLAY_MIN_SEED_CHARS + 500 },
        { typed: '524288', stored: 524288 },
    ])('retains the selected structurally complete seed budget $typed', async ({ typed, stored }) => {
        sessionSettingsEntryState.settingsState.sessionReplayEnabled = true;

        const mod = await import('@/app/(app)/settings/session/resume');
        const screen = await renderScreen(React.createElement(mod.default));

        await act(async () => {
            maxSeedCharsField(screen).onChangeText(typed);
        });
        await act(async () => {
            maxSeedCharsField(screen).onBlur();
        });

        await vi.waitFor(() => expect(storage.getState().settings.sessionReplayMaxSeedChars).toBe(stored));
        await vi.waitFor(() => expect(account?.persistedSettings.sessionReplayMaxSeedChars).toBe(stored));
    });

    // Integer draft filtering and the mobile numeric keyboard remain the
    // shared field owner's contract; empty/non-number drafts return to saved.
    it.each([String(HAPPIER_REPLAY_MIN_SEED_CHARS - 1), '0', 'NaN', 'Infinity', 'invalid'])(
        'leaves the saved budget unchanged for invalid draft %s', async (typed) => {
            const mod = await import('@/app/(app)/settings/session/resume');
            const screen = await renderScreen(React.createElement(mod.default));
            await act(async () => { maxSeedCharsField(screen).onChangeText(typed); });
            await act(async () => { maxSeedCharsField(screen).onBlur(); });
            expect(storage.getState().settings.sessionReplayMaxSeedChars).toBe(50_000);
            expect(account?.persistedSettings.sessionReplayMaxSeedChars).toBe(50_000);
            expect(maxSeedCharsField(screen).value).toBe('50000');
        },
    );

    // Both live replay routes pass `recentMessagesCount: null` on purpose: the
    // seed is bounded by CHARACTERS. Only the compatibility-only
    // `continueWithReplay` ingress reads the count, so the control could not
    // change any outcome a user can reach. The stored key stays.
    it('names the field programmatically and connects its description', async () => {
        sessionSettingsEntryState.settingsState.sessionReplayEnabled = true;

        const mod = await import('@/app/(app)/settings/session/resume');
        const screen = await renderScreen(React.createElement(mod.default));

        const [row] = maxSeedCharsRows(screen);
        expect(row?.props.title).toBe('settingsSessionPages.resume.maxSeedCharsTitle');
        expect(maxSeedCharsField(screen).accessibilityLabel).toBe('settingsSessionPages.resume.maxSeedCharsTitle');
        expect(maxSeedCharsField(screen).accessibilityHint).toBe(row?.props.subtitle);
    });

    it('does not render the recent-messages control that cannot affect any outcome', async () => {
        sessionSettingsEntryState.settingsState.sessionReplayEnabled = true;

        const mod = await import('@/app/(app)/settings/session/resume');
        const screen = await renderScreen(React.createElement(mod.default));

        expect(screen.getTextContent()).not.toContain('settingsSession.replayResume.recentMessagesTitle');
        expect(screen.findAllByProps({ placeholder: 'settingsSession.replayResume.recentMessagesPlaceholder' })).toHaveLength(0);
    });

    it('leaves the stored recent-messages preference untouched while the control is hidden', async () => {
        sessionSettingsEntryState.settingsState.sessionReplayEnabled = true;
        sessionSettingsEntryState.settingsState.sessionReplayRecentMessagesCount = 100;

        const mod = await import('@/app/(app)/settings/session/resume');
        await renderScreen(React.createElement(mod.default));

        expect(storage.getState().settings.sessionReplayRecentMessagesCount).toBe(100);
        expect(account?.persistedSettings.sessionReplayRecentMessagesCount).toBe(100);
    });
});

// A user who picks "Summary + recent" and never opens the backend picker
// silently receives recent-only, because the fork resolver forwards the runner
// only when one is set. The screen has to say so.
describe('Session resume settings (summary strategy discloses its requirement)', () => {
    async function renderResume() {
        const mod = await import('@/app/(app)/settings/session/resume');
        return renderScreen(React.createElement(mod.default));
    }

    it('discloses the unmet summary-model requirement when the strategy is selected', async () => {
        executionRunsEnabledState.enabled = true;
        sessionSettingsEntryState.settingsState.sessionReplayEnabled = true;
        sessionSettingsEntryState.settingsState.sessionReplayStrategy = 'summary_plus_recent';
        sessionSettingsEntryState.settingsState.sessionReplaySummaryRunnerV1 = null;

        const screen = await renderResume();

        expect(screen.findByTestId('settings-session-replay-summaryRunner-requirement')).toBeTruthy();
    });

    it('stops disclosing once a summary model is configured', async () => {
        executionRunsEnabledState.enabled = true;
        sessionSettingsEntryState.settingsState.sessionReplayEnabled = true;
        sessionSettingsEntryState.settingsState.sessionReplayStrategy = 'summary_plus_recent';
        sessionSettingsEntryState.settingsState.sessionReplaySummaryRunnerV1 = { v: 1, modelSelection: {
            agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'default',
        } };

        const screen = await renderResume();

        expect(screen.findByTestId('settings-session-replay-summaryRunner-requirement')).toBeNull();
    });

    // Execution runs off is the worse case: the picker is not even rendered, so
    // without this the screen offers a strategy with no way to make it work.
    it('discloses that the strategy cannot run at all when execution runs are off', async () => {
        executionRunsEnabledState.enabled = false;
        sessionSettingsEntryState.settingsState.sessionReplayEnabled = true;
        sessionSettingsEntryState.settingsState.sessionReplayStrategy = 'summary_plus_recent';

        const screen = await renderResume();

        expect(screen.findByTestId('settings-session-replay-summaryRunner-requirement')).toBeTruthy();
    });

    it('says nothing about a summary model under the recent-messages strategy', async () => {
        executionRunsEnabledState.enabled = true;
        sessionSettingsEntryState.settingsState.sessionReplayEnabled = true;
        sessionSettingsEntryState.settingsState.sessionReplayStrategy = 'recent_messages';

        const screen = await renderResume();

        expect(screen.findByTestId('settings-session-replay-summaryRunner-requirement')).toBeNull();
    });
});
