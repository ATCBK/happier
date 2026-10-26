import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, createAccountTokenForTests, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import type { Settings } from '@/sync/domains/settings/settings';

installSettingsViewCommonModuleMocks({ storage: 'real' });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { savePendingAccountSettings, loadPendingAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
const { getSyncSingleton } = await import('@/sync/runtime/getSyncSingleton');
const { syncSettings } = await import('./syncSettings');
const { ActionSettingsDetailContent } = await import('@/components/settings/actions/ActionSettingsDetailView');
const { normalizeActionsSettings } = await import('@/components/settings/actions/normalizeActionsSettings');
const { ActionSettingsTargetModeControl } = await import('@/components/settings/actions/ActionSettingsTargetModeControl');

const actionIds = ['session.stop', 'session.archive', 'session.unarchive'] as const;
type PendingRuntime = {
    pendingSettings: Partial<Settings>;
    pendingSettingsDirty: boolean;
    pendingSettingsFlushTimer: ReturnType<typeof setTimeout> | null;
};
const previousState = storage.getState();
const runtime = getSyncSingleton() as unknown as PendingRuntime;
const previousPending = { pendingSettings: runtime.pendingSettings,
    pendingSettingsDirty: runtime.pendingSettingsDirty, pendingSettingsFlushTimer: runtime.pendingSettingsFlushTimer };

afterEach(async () => {
    standardCleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    Object.assign(runtime, previousPending);
    storage.setState(previousState, true);
    await harness.reset();
});

describe('Action editors through the real Account settings writer', () => {
    it.each(['off', 'on'] as const)('retains all three %s intents across a delayed acknowledgement and CAS retry', async value => {
        installHomeGovernanceBoundaries(harness);
        const serverId = await harness.addHome({ name: 'Action edits', serverUrl: 'https://action-edits.example', accountId: 'owner', currentAccount: true });
        const scope = { serverId, accountId: 'owner' };
        // Settings -> Actions submits each intent as an `actions.policy.set` Action; this test is about
        // ordinary present-user writes, not the separate Ask-first review journey, so the Account
        // has waived that approval for the UI surface.
        let raw: Record<string, unknown> = { actionsSettingsV1: {
            ...normalizeActionsSettings({ v: 1,
                actions: value === 'off' ? {} : Object.fromEntries(actionIds.map(id => [id, { disabledSurfaces: ['agent'] }])) }),
            approvalWaivedSurfaces: { 'actions.policy.set': ['ui'] },
        } };
        const assertAllIntents = (settings: unknown) => {
            const actions = normalizeActionsSettings(settings).actions;
            for (const actionId of actionIds) expect(actions[actionId]?.disabledSurfaces.includes('agent') ?? false, actionId).toBe(value === 'off');
        };
        let version = 1;
        storage.setState({ settingsScope: scope, settingsVersion: version, settings: settingsParse(raw) });
        let release!: () => void;
        const acknowledgement = new Promise<void>(resolve => { release = resolve; });
        let issued!: () => void;
        const firstPost = new Promise<void>(resolve => { issued = resolve; });
        let posts = 0;
        let conflicts = 0;
        harness.answer(serverId, '/v2/account/settings', { select: () => ({ body: { content: { t: 'plain', v: raw }, version } }) });
        harness.answer(serverId, 'POST /v2/account/settings', { select: input => {
            const request = input as { expectedVersion: number; content: { t: 'plain'; v: Record<string, unknown> } };
            posts++;
            if (posts === 2) { raw = { ...raw, analyticsOptOut: true }; version++; }
            if (request.expectedVersion !== version) {
                conflicts++;
                return { status: 409, body: { success: false, error: 'version-mismatch', currentVersion: version, currentContent: { t: 'plain', v: raw } } };
            }
            raw = request.content.v;
            version++;
            if (posts === 1) issued();
            return { body: { success: true, version }, ...(posts === 1 ? { respondAfter: acknowledgement } : {}) };
        } });
        const screen = await renderScreen(<>{actionIds.map(actionId => <ActionSettingsDetailContent key={actionId} actionId={actionId} />)}</>);
        const controls = () => actionIds.map(actionId => screen.findAllByType(ActionSettingsTargetModeControl)
            .find(node => node.props.testIDPrefix === `settings-actions:action:${actionId}:target:agent`)!.props.onChange as (value: 'off' | 'on') => void);
        await act(async () => { controls()[0]!(value); });
        await firstPost;
        try {
            // Two controls can deliver intents before React commits another render.
            const [, archive, unarchive] = controls();
            await act(async () => { archive!(value); unarchive!(value); });
        } finally {
            release();
        }
        await vi.waitFor(() => {
            expect(posts).toBeGreaterThanOrEqual(3);
            assertAllIntents(raw.actionsSettingsV1);
            expect(raw.analyticsOptOut).toBe(true);
        });
        expect(conflicts).toBeGreaterThanOrEqual(1);
        await act(async () => { await Promise.resolve(); });
        assertAllIntents(storage.getState().settings.actionsSettingsV1);
        // A reversal after the retry applies the explicit intent, not a diff against the originally rendered value.
        const reversed = value === 'off' ? 'on' : 'off';
        await act(async () => { controls()[1]!(reversed); });
        await vi.waitFor(() => expect(normalizeActionsSettings(raw.actionsSettingsV1).actions['session.archive']
            ?.disabledSurfaces.includes('agent') ?? false).toBe(reversed === 'off'));
        await act(async () => { controls()[1]!(value); });
        await vi.waitFor(() => assertAllIntents(raw.actionsSettingsV1));
        await vi.waitFor(() => assertAllIntents(storage.getState().settings.actionsSettingsV1));
    });
});
