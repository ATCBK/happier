import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { UsageWidgetBodyModel } from './useUsageWidgetResource';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
installDisconnectedServerSocketBoundary();
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});

const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
const { decideApprovalAsInbox } = await import('@/dev/testkit/harness/approvalInbox');
const { storage } = await import('@/sync/domains/state/storage');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
const { UsageCapacityAlertsSettingsGroup } = await import('../session/UsageCapacityAlertsSettingsGroup');
const { ProviderUsageGaugeSettingsGroup } = await import('../connectedServices/ProviderUsageGaugeSettingsGroup');
const { CONNECTED_SERVICES_USAGE_GAUGE_SETTINGS } = await import('../connectedServices/connectedServicesSettings');
const { UsageNightShiftWidget } = await import('./widgets/UsageNightShiftWidget');
const { UsageCoachWidget } = await import('./widgets/UsageCoachWidget');
const { UsageModelPricesEditor } = await import('./widgets/UsageModelPrices');
const { FieldTextInput } = await import('@/components/ui/forms/FieldTextInput');
const { SessionModelRoutingHint } = await import('@/components/sessions/modelPicker/SessionModelRoutingHint');
const { createResolvedAgentCatalogEntryFixture } = await import('@/dev/testkit/fixtures/agentCatalogFixtures');
const { applyConnectedAccountCatalogSnapshot } = await import('@/sync/store/settings/connectedAccountCatalogSnapshot');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { normalizeUsageQuery, getUsageQueryKey } = await import('@happier-dev/protocol/inputs/usageQuery');
const { ApprovalRequestV2Schema } = await import('@happier-dev/protocol');
const { z } = await import('zod');

const settingsInput = z.object({ content: z.object({ t: z.literal('plain'), v: z.record(z.string(), z.unknown()) }), expectedVersion: z.number() });
let serverId: string;
let raw: Record<string, unknown>;
let version: number;

beforeEach(async () => {
    standardCleanup();
    await harness.reset();
    await loadSyncSingletonForTests();
    serverId = await harness.addHome({ name: 'Usage settings', serverUrl: 'https://usage-settings.test', accountId: 'usage-account', currentAccount: true });
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse() } });
    raw = {};
    version = 1;
    storage.setState({ settings: settingsParse(raw), settingsScope: { serverId, accountId: 'usage-account' }, profileScope: { serverId, accountId: 'usage-account' }, settingsVersion: version });
    await harness.requireUiApproval(serverId, 'settings.set');
    raw = { ...storage.getState().settings };
    harness.answer(serverId, 'GET /v2/account/settings', { select: () => ({ body: { content: { t: 'plain', v: raw }, version } }) });
    // Persisted settings and its CAS are the genuine HTTP boundary. All declaration, Action and
    // approval logic above it stays real, including the store projection after acknowledgement.
    harness.answer(serverId, 'POST /v2/account/settings', { select: input => {
        const parsed = settingsInput.parse(input);
        expect(parsed.expectedVersion).toBe(version);
        raw = parsed.content.v;
        return { body: { success: true, version: ++version } };
    } });
    harness.answer(serverId, '/v1/auth/ping', { body: {} });
    harness.answer(serverId, '/v2/sessions', { body: { sessions: [], nextCursor: null, hasNext: false } });
    harness.answer(serverId, '/v2/sessions/active', { body: { sessions: [], nextCursor: null, hasNext: false } });
    const credentials = await TokenStorage.getCredentialsForServerUrl('https://usage-settings.test');
    if (!credentials) throw new Error('The synthetic Home credential is missing');
    await restoreConnectionToActiveServer(credentials);
    const { sync } = await import('@/sync/sync');
    const settingsQueue = Reflect.get(sync, 'settingsSync') as import('@/utils/sessions/sync').InvalidateSync;
    await settingsQueue.awaitQueue();
    storage.setState({ settings: settingsParse(raw), settingsScope: { serverId, accountId: 'usage-account' }, profileScope: { serverId, accountId: 'usage-account' }, settingsVersion: version });
    expect(getActiveServerAccountScope()).toEqual({ serverId, accountId: 'usage-account' });
});
afterEach(async () => { standardCleanup(); await disconnectActiveServerConnection(); });

function approvalFor(anchor: string) {
    return harness.artifacts(serverId).list().find(artifact => {
        const request = ApprovalRequestV2Schema.safeParse(JSON.parse(harness.artifacts(serverId).readPlainBody(artifact.id) ?? 'null'));
        return request.success && request.data.actionId === 'settings.set'
            && request.data.actionArgs && typeof request.data.actionArgs === 'object'
            && 'anchor' in request.data.actionArgs && request.data.actionArgs.anchor === anchor;
    });
}

async function renderNight() {
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, metric: 'tokens', granularity: 'day' });
    const slice = { key: getUsageQueryKey(query), requestedQuery: query, shownQuery: query, pending: false, sources: [] };
    const identity = { query, authority: { serverId, accountId: 'usage-account' } };
    const model: UsageWidgetBodyModel = { requestedQuery: identity, shownQuery: identity, slice, pending: false, error: null, freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
    return renderScreen(<UsageNightShiftWidget id="usage_night_shift" testID="night" serverId={serverId} query={query} slice={slice} model={model} />);
}

function priceSlice() {
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 } });
    const tokens = { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 };
    const contribution = { id: 'c1', observedAtMs: 150, sessionId: null, turnId: null, agentId: null, modelId: 'qa-private-model',
        machineId: null, projectKey: null, workspaceId: null, source: null, tokens, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } };
    return { query, slice: { key: getUsageQueryKey(query), requestedQuery: query, shownQuery: query, pending: false,
        sources: [{ source: 'accounting' as const, status: 'available' as const }],
        accounting: { v: 1 as const, totals: { eventCount: 1, tokens, cost: contribution.cost }, contributions: [contribution] } } };
}

describe('Usage settings UI Action admission', () => {
    it('sets and resets a model price through the Account setting only after approval', async () => {
        const { slice } = priceSlice();
        const screen = await renderScreen(<UsageModelPricesEditor slice={slice} serverId={serverId} testID="prices" />);
        await screen.pressByTestIdAsync('prices.model.qa-private-model.set');
        const field = (name: string) => screen.findAllByType(FieldTextInput).find(input => input.props.testID === `prices.model.qa-private-model.${name}`)!;
        await act(async () => { field('input').props.onChangeText('3'); field('output').props.onChangeText('15'); });
        await screen.pressByTestIdAsync('prices.model.qa-private-model.save');
        expect(storage.getState().settings.usageModelPriceOverridesV1).toEqual({});
        await waitForHomeGovernance(() => expect(approvalFor('usage.modelPrices')).toBeTruthy());
        await decideApprovalAsInbox(serverId, approvalFor('usage.modelPrices')!.id, 'approve');
        await waitForHomeGovernance(() => expect(storage.getState().settings.usageModelPriceOverridesV1).toEqual({
            'qa-private-model': { kind: 'rates', inputUsdPerMillion: 3, outputUsdPerMillion: 15 } }));
        const previous = new Set(harness.artifacts(serverId).list().map(row => row.id));
        // An approved save closes the row; Reset lives in the open row with the other ways to price it.
        if (!screen.findByTestId('prices.model.qa-private-model.reset')) await screen.pressByTestIdAsync('prices.model.qa-private-model.set');
        await waitForHomeGovernance(() => expect(screen.findByTestId('prices.model.qa-private-model.reset')).toBeTruthy());
        await screen.pressByTestIdAsync('prices.model.qa-private-model.reset');
        const next = () => harness.artifacts(serverId).list().find(row => !previous.has(row.id));
        await waitForHomeGovernance(() => expect(next()).toBeTruthy());
        await decideApprovalAsInbox(serverId, next()!.id, 'approve');
        await waitForHomeGovernance(() => expect(storage.getState().settings.usageModelPriceOverridesV1).toEqual({}));
        await screen.unmount();
    });

    it('persists Coach check and model choices only after approval, preserving dismissed evidence', async () => {
        raw.usageCoachPreferencesV1 = { v: 1, suppressions: [{ kind: 'dismissed', evidenceKey: 'keep-dismissed' }] };
        storage.getState().applySettings(settingsParse(raw), ++version);
        const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 } });
        const slice = { key: getUsageQueryKey(query), requestedQuery: query, shownQuery: query, pending: false, sources: [] };
        const identity = { query, authority: { serverId, accountId: 'usage-account' } };
        const model: UsageWidgetBodyModel = { requestedQuery: identity, shownQuery: identity, slice, pending: false, error: null,
            freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
        const screen = await renderScreen(<UsageCoachWidget id="usage_coach" testID="coach" serverId={serverId} query={query} slice={slice} model={model} />);
        await screen.pressByTestIdAsync('coach.configure-header');
        await screen.pressByTestIdAsync('coach.preferences.check.mcp_overhead');
        expect(storage.getState().settings.usageCoachPreferencesV1.disabledChecks).toEqual([]);
        await waitForHomeGovernance(() => expect(approvalFor('usage.coachPreferences')).toBeTruthy());
        await decideApprovalAsInbox(serverId, approvalFor('usage.coachPreferences')!.id, 'approve');
        await waitForHomeGovernance(() => expect(storage.getState().settings.usageCoachPreferencesV1.disabledChecks).toEqual(['mcp_overhead']));
        const previousArtifacts = new Set(harness.artifacts(serverId).list().map(row => row.id));
        const dropdown = screen.findAllByType(DropdownMenu).find(row => row.props.testID === 'coach.preferences.model')!;
        await act(async () => { dropdown.props.onSelect('complete_only'); });
        const nextApproval = () => harness.artifacts(serverId).list().find(row => !previousArtifacts.has(row.id));
        await waitForHomeGovernance(() => expect(nextApproval()).toBeTruthy());
        expect(storage.getState().settings.usageCoachPreferencesV1.modelSuggestion).toBe('suggest_with_estimates');
        await decideApprovalAsInbox(serverId, nextApproval()!.id, 'approve');
        await waitForHomeGovernance(() => expect(storage.getState().settings.usageCoachPreferencesV1.modelSuggestion).toBe('complete_only'));
        expect(raw.usageCoachPreferencesV1).toMatchObject({ disabledChecks: ['mcp_overhead'], modelSuggestion: 'complete_only',
            suppressions: [{ kind: 'dismissed', evidenceKey: 'keep-dismissed' }] });
        await screen.unmount();
    });
    it('does not bypass a disabled settings Action when the routing preference is pressed', async () => {
        raw.actionsSettingsV1 = { v: 1, actions: { 'settings.set': { enabled: false } } };
        storage.getState().applySettings(settingsParse(raw), ++version);
        const screen = await renderScreen(<ProviderUsageGaugeSettingsGroup />);
        await screen.pressByTestIdAsync('settings-session-providerUsageGauge-routingHints');
        expect(storage.getState().settings.usageRoutingHintsEnabled).toBe(true);
        expect(raw.usageRoutingHintsEnabled).toBe(true);
        expect(approvalFor('session.providerLimits.routingHints')).toBeUndefined();
        await screen.unmount();
    });

    it('keeps the pace target and individual alert choices unchanged until their declared Actions are approved', async () => {
        const screen = await renderScreen(<UsageCapacityAlertsSettingsGroup />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('settings-usage-alerts-pace')).toBeTruthy());
        await screen.pressByTestIdAsync('settings-usage-alerts-pace');
        expect(storage.getState().settings.usageQuotaNotificationsV1.pace).toBe(false);
        await waitForHomeGovernance(() => expect(approvalFor('session.providerLimits.alertPace')).toBeTruthy());
        expect(raw.usageQuotaNotificationsV1).toMatchObject({ pace: false });
        const artifact = approvalFor('session.providerLimits.alertPace')!;
        await decideApprovalAsInbox(serverId, artifact.id, 'approve');
        await waitForHomeGovernance(() => expect(storage.getState().settings.usageQuotaNotificationsV1.pace).toBe(true));
        expect(storage.getState().settings.usageQuotaNotificationsV1.depletion).toBe(false);
        await screen.pressByTestIdAsync('settings-usage-pace-target:75');
        await waitForHomeGovernance(() => expect(approvalFor('session.providerLimits.personalPaceTarget')).toBeTruthy());
        expect(storage.getState().settings.usagePacingTargetsV1).toEqual([]);
        await decideApprovalAsInbox(serverId, approvalFor('session.providerLimits.personalPaceTarget')!.id, 'approve');
        await waitForHomeGovernance(() => expect(storage.getState().settings.usagePacingTargetsV1).toEqual([expect.objectContaining({ scope: { kind: 'personal' }, utilizationFraction: 0.75 })]));
        await screen.unmount();
    });

    it('keeps the routing hint enabled when approval is rejected', async () => {
        const screen = await renderScreen(<ProviderUsageGaugeSettingsGroup />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('settings-session-providerUsageGauge-routingHints')).toBeTruthy());
        await screen.pressByTestIdAsync('settings-session-providerUsageGauge-routingHints');
        expect(storage.getState().settings.usageRoutingHintsEnabled).toBe(true);
        await waitForHomeGovernance(() => expect(approvalFor('session.providerLimits.routingHints')).toBeTruthy());
        await decideApprovalAsInbox(serverId, approvalFor('session.providerLimits.routingHints')!.id, 'reject');
        expect(storage.getState().settings.usageRoutingHintsEnabled).toBe(true);
        await screen.unmount();
    });

    it('turns the routing hint off and on through the admitted settings owner when no approval is requested', async () => {
        raw.actionsSettingsV1 = { v: 1, actions: {} };
        storage.getState().applySettings(settingsParse(raw), ++version);
        const screen = await renderScreen(<ProviderUsageGaugeSettingsGroup settings={CONNECTED_SERVICES_USAGE_GAUGE_SETTINGS.settings} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('settings-session-providerUsageGauge-routingHints')).toBeTruthy());
        await screen.pressByTestIdAsync('settings-session-providerUsageGauge-routingHints');
        await waitForHomeGovernance(() => expect(raw.usageRoutingHintsEnabled).toBe(false));
        expect(storage.getState().settings.usageRoutingHintsEnabled).toBe(false);
        await screen.pressByTestIdAsync('settings-session-providerUsageGauge-routingHints');
        await waitForHomeGovernance(() => expect(raw.usageRoutingHintsEnabled).toBe(true));
        expect(storage.getState().settings.usageRoutingHintsEnabled).toBe(true);
        await screen.unmount();
    });

    it('keeps the picker hint visible while its hide Action awaits approval', async () => {
        const entry = createResolvedAgentCatalogEntryFixture({ agentId: 'claude' });
        const declaration = entry.connectedAccounts[0]!;
        expect(entry.identity).toBeTruthy();
        expect(declaration).toBeTruthy();
        applyConnectedAccountCatalogSnapshot({ serverId, accountId: 'usage-account' }, 'purposes', {
            status: 'ready', revision: 1,
            record: { key: 'purposes', value: { v: 1, bindings: [{
                purpose: { consumer: entry.identity!, purpose: declaration.purpose },
                target: { kind: 'group', service: declaration.service, groupId: 'fallbacks' },
            }] } },
        }, true);
        const credentials = await TokenStorage.getCredentialsForServerUrl('https://usage-settings.test');
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><SessionModelRoutingHint entry={entry} machineId={null} /></InjectedAuthProvider>);
        await waitForHomeGovernance(() => expect(screen.findByTestId('session-model-routing-hint.hide')).toBeTruthy());
        await screen.pressByTestIdAsync('session-model-routing-hint.hide');
        expect(storage.getState().settings.usageRoutingHintsEnabled).toBe(true);
        expect(screen.findByTestId('session-model-routing-hint.hide')).toBeTruthy();
        await waitForHomeGovernance(() => expect(approvalFor('session.providerLimits.routingHints')).toBeTruthy());
        await decideApprovalAsInbox(serverId, approvalFor('session.providerLimits.routingHints')!.id, 'approve');
        await waitForHomeGovernance(() => expect(storage.getState().settings.usageRoutingHintsEnabled).toBe(false));
        expect(screen.findAllByTestId('session-model-routing-hint.hide')).toHaveLength(0);
        await screen.unmount();
    });

    it('does not persist partial night hours and withholds a complete range until approval', async () => {
        const screen = await renderNight();
        await act(async () => { screen.findAllByType(DropdownMenu)[0]!.props.onSelect('23'); });
        expect(approvalFor('usage.nightHours')).toBeUndefined();
        expect(storage.getState().settings.usageNightHoursV1).toBeNull();
        await act(async () => { screen.findAllByType(DropdownMenu)[1]!.props.onSelect('7'); });
        expect(storage.getState().settings.usageNightHoursV1).toBeNull();
        await waitForHomeGovernance(() => expect(approvalFor('usage.nightHours')).toBeTruthy());
        await decideApprovalAsInbox(serverId, approvalFor('usage.nightHours')!.id, 'approve');
        await waitForHomeGovernance(() => expect(storage.getState().settings.usageNightHoursV1).toEqual({ startHour: 23, endHour: 7 }));
        const retiredPress = screen.findAllByType(DropdownMenu)[0]!.props.onSelect;
        await act(async () => { await harness.switchAccount(serverId, 'other-account'); });
        await act(async () => { retiredPress('clear'); });
        expect(storage.getState().settings.usageNightHoursV1).toEqual({ startHour: 23, endHour: 7 });
        await screen.unmount();
    });

    it('clears chosen night hours only after approval and discards a partial draft when the Account changes', async () => {
        raw.usageNightHoursV1 = { startHour: 23, endHour: 7 };
        storage.getState().applySettings(settingsParse(raw), ++version);
        const screen = await renderNight();
        await act(async () => { screen.findAllByType(DropdownMenu)[0]!.props.onSelect('clear'); });
        expect(storage.getState().settings.usageNightHoursV1).toEqual({ startHour: 23, endHour: 7 });
        expect(screen.findAllByType(DropdownMenu).map(control => control.props.selectedId)).toEqual(['23', '7']);
        await waitForHomeGovernance(() => expect(approvalFor('usage.nightHours')).toBeTruthy());
        await decideApprovalAsInbox(serverId, approvalFor('usage.nightHours')!.id, 'approve');
        await waitForHomeGovernance(() => expect(storage.getState().settings.usageNightHoursV1).toBeNull());
        await act(async () => { screen.findAllByType(DropdownMenu)[0]!.props.onSelect('23'); });
        await act(async () => {
            await harness.switchAccount(serverId, 'other-account');
            storage.setState({ settingsScope: { serverId, accountId: 'other-account' } });
        });
        expect(screen.findAllByType(DropdownMenu).map(control => control.props.selectedId)).toEqual([null, null]);
        await screen.unmount();
    });
});
