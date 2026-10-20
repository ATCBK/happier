import 'fake-indexeddb/auto';
import React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen as renderTestScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installBrowserStorageLockBoundary } from '@/dev/testkit/harness/browserStorageLockBoundary';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { installReactDomPortalBoundaryForTests } from '@/dev/testkit/mocks/reactDom';
import type { ConnectedServiceQuotaGaugeViewModel } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('react-native-keyboard-controller', () => ({ useFocusedInputHandler: () => {} }));

let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>> | undefined;
async function installBrowserBoundary() {
    browser?.restore();
    browser = await installBrowserRuntimeForTests({ url: 'https://composer-status.test' });
}
await installBrowserBoundary();
afterAll(() => browser?.restore());

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installSessionActionRpcBoundary(() => { throw new Error('Unexpected composer RPC'); });
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { AgentInput } = await import('./AgentInput');
const { getStorage } = await import('@/sync/domains/state/storage');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { ModalProvider } = await import('@/modal');
const { FloatingOverlay } = await import('@/components/ui/overlays/FloatingOverlay');
const { UsageMeterRow } = await import('@/components/settings/connectedServices/usage/UsageMeterRow');
const { sync } = await import('@/sync/sync');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const initialStorageState = getStorage().getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let releaseLocks: (() => void) | undefined;
let portal: ReturnType<typeof installReactDomPortalBoundaryForTests> | undefined;

function ComposerAccountBoundary({ children }: React.PropsWithChildren) {
    if (!connection) throw new Error('Composer Account is not restored');
    return <InjectedAuthProvider credentials={connection.credentials}><ModalProvider>{children}</ModalProvider></InjectedAuthProvider>;
}

function renderScreen(element: React.ReactElement) {
    return renderTestScreen(element, {
        wrapper: ComposerAccountBoundary,
        createNodeMock: element => {
            const node = document.createElement(element.type === 'TextInput' ? 'textarea' : 'div');
            return Object.assign(node, {
                setNativeProps() {},
                measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 300, 100),
            });
        },
    });
}

beforeEach(async () => {
    await installBrowserBoundary();
    releaseLocks = installBrowserStorageLockBoundary();
    portal = installReactDomPortalBoundaryForTests();
    await homes.reset();
    getStorage().setState(initialStorageState, true);
    const serverId = await homes.addHome({ name: 'Composer status', serverUrl: 'https://composer-status.test', accountId: 'composer-account', currentAccount: true });
    const credentials = await TokenStorage.getCredentialsForServerUrl('https://composer-status.test');
    if (!credentials) throw new Error('The composer Home did not restore its Account');
    connection = await restoreServerAccountForTest({ serverUrl: 'https://composer-status.test', accountId: 'composer-account', credentials, request: homes.request });
    await sync.awaitBootstrapForegroundAcquisition();
    const scope = { serverId, accountId: 'composer-account' };
    getStorage().setState({ settingsScope: scope, profileScope: scope });
    const state = getStorage().getState();
    state.applySettingsForScope(scope, { ...state.settings, agentInputEnterToSend: true,
        agentInputActionBarLayout: 'wrap', agentInputChipDensity: 'labels' }, (state.settingsVersion ?? 0) + 1);
});
afterEach(async () => {
    standardCleanup();
    await connection?.dispose();
    connection = undefined;
    await homes.reset();
    portal?.restore(); portal = undefined;
    releaseLocks?.(); releaseLocks = undefined;
    getStorage().setState(initialStorageState, true);
});

describe('AgentInput status badges', () => {
    it('renders provider quota gauge as a clickable usage badge', async () => {
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const providerUsageGauge: ConnectedServiceQuotaGaugeViewModel = {
            serviceId: 'openai-codex',
            providerDisplayName: 'OpenAI Codex',
            activeAccountDisplayLabel: 'Work account',
            remainingPct: 18,
            usedPct: 82,
            primaryValueSemantics: 'remaining',
            valueLabel: '18%',
            ringValueLabel: '18',
            badgeLabel: '18%',
            scopePrefix: 'w.',
            detailRightLabel: '18% left',
            usedLimitLabel: '82/100 used',
            resetLabel: null,
            tone: 'warning',
            isStale: false,
            recoveryCreditSummary: {
                availableCount: 1,
                nextExpiresAtMs: null,
                providerCreditId: null,
            },
            effectiveMeter: {
                meterId: 'weekly',
                label: 'Weekly',
                used: 82,
                limit: 100,
                unit: 'count',
                utilizationPct: null,
                remainingPct: 18,
                resetsAt: null,
                status: 'ok',
                details: {},
            },
            allMeterRows: [{
                meterId: 'weekly',
                label: 'Weekly',
                remainingPct: 18,
                usedPct: 82,
                detailRightSemantics: 'remaining',
                detailRightLabel: '18% left',
                usedLimitSemantics: 'used',
                usedLimitLabel: '82/100 used',
                resetLabel: null,
                resetsAt: null,
                tone: 'warning',
            }],
            usageRings: [],
        };
        const onProviderUsageRecoveryCreditPress = vi.fn();

        const screen = await renderScreen(
            <AgentInput
                value=""
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                agentType="codex"
                metadata={{
                    ...createSessionFixture().metadata!,
                    connectedServices: { v: 2, bindingsByServiceId: {
                        'happier.agent.codex/openai-codex': { source: 'native' },
                    } },
                }}
                instrumentQuota={{
                    viewModel: providerUsageGauge,
                    onRecoveryCreditPress: onProviderUsageRecoveryCreditPress,
                }}
            />,
        );

        const badge = screen.findByTestId('session-instrument-quota-ring');
        expect(badge).toBeTruthy();
        expect(screen.findByTestId('session-instrument-quota-ring-arc')).toBeTruthy();
        act(() => {
            badge?.props.onPress?.({} as never);
        });
        expect(screen.findByTestId('session-instrument-quota-popover')).toBeTruthy();
        const weekly = screen.findAllByType(UsageMeterRow).find((row) => row.props.label === 'Weekly');
        expect(weekly).toBeTruthy();
        if (!weekly) throw new Error('The own-sign-in weekly quota must be visible');
        // A quota bar shows what is left (18%), like every other quota row, never what was used.
        expect(weekly.props.remainingPct).toBe(18);
        // The usage rows vary in number, so the popover scrolls rather than clipping what is past its height cap.
        expect(screen.findAllByType(FloatingOverlay).at(-1)?.props.scrollEnabled).toBe(true);
        const recoveryCreditAction = screen.findByTestId('usage-popover-own-sign-in-resets:use');
        expect(recoveryCreditAction).toBeTruthy();
        act(() => {
            recoveryCreditAction?.props.onPress?.({} as never);
        });
        expect(onProviderUsageRecoveryCreditPress).toHaveBeenCalledTimes(1);
    });

    it('renders status badges and keeps their popovers click-persistent', async () => {
        const screen = await renderScreen(
            <AgentInput
                value=""
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                connectionStatus={{ text: 'online', color: 'green', dotColor: 'green' }}
                statusBadges={[{
                    key: 'work-state',
                    label: 'Goal: ship',
                    testID: 'session-work-state-status-badge',
                    renderPopover: (ctx) => ctx.open
                        ? React.createElement('WorkStatePopover', {
                            testID: 'session-work-state-popover',
                            onRequestClose: ctx.onRequestClose,
                        })
                        : null,
                }]}
            />,
        );
        expect(screen.findByTestId('session-work-state-popover')).toBeNull();
        const badge = screen.findByTestId('session-work-state-status-badge');
        expect(badge).toBeTruthy();
        act(() => {
            badge?.props.onPress?.({} as never);
        });
        expect(screen.findByTestId('session-work-state-popover')).toBeTruthy();
        act(() => {
            screen.findByTestId('session-work-state-popover')?.props.onRequestClose();
        });
        expect(screen.findByTestId('session-work-state-popover')).toBeNull();
    });
});
