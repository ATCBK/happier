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
        let raw: Record<string, unknown> = { actionsSettingsV1: normalizeActionsSettings({ v: 1,
            actions: value === 'off' ? {} : Object.fromEntries(actionIds.map(id => [id, { disabledSurfaces: ['agent'] }])) }) };
        const assertAllIntents = (settings: unknown) => {
            const actions = normalizeActionsSettings(settings).actions;
            for (const actionId of actionIds) expect(actions[actionId]?.disabledSurfaces.includes('agent') ?? false, actionId).toBe(value === 'off');
        };
        let version = 1;
        storage.setState({ settingsScope: scope, settingsVersion: version, settings: settingsParse(raw) });
        runtime.pendingSettings = {};
        runtime.pendingSettingsDirty = false;
        runtime.pendingSettingsFlushTimer = null;
        savePendingAccountSettings(scope, {});
        // Hold only the real persistence/network flush clock. Editors, hook,
        // singleton ingress, pending reconciliation and projection stay real.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
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
        const flush = () => syncSettings({ credentials: { token: createAccountTokenForTests('owner', { currentAccount: true }) },
            encryption: null, settingsScope: scope, pendingSettings: runtime.pendingSettings,
            getPendingSettings: () => runtime.pendingSettings,
            clearPendingSettings: next => { runtime.pendingSettings = next; savePendingAccountSettings(scope, next); } });
        const screen = await renderScreen(<>{actionIds.map(actionId => <ActionSettingsDetailContent key={actionId} actionId={actionId} />)}</>);
        const controls = () => actionIds.map(actionId => screen.findAllByType(ActionSettingsTargetModeControl)
            .find(node => node.props.testIDPrefix === `settings-actions:action:${actionId}:target:agent`)!.props.onChange as (value: 'off' | 'on') => void);
        await act(async () => { controls()[0]!(value); });
        savePendingAccountSettings(scope, runtime.pendingSettings);
        const inFlight = flush();
        await firstPost;
        try {
            // Two controls can deliver intents before React commits another render.
            const [, archive, unarchive] = controls();
            await act(async () => { archive!(value); unarchive!(value); });
            assertAllIntents(runtime.pendingSettings.actionsSettingsV1);
        } finally {
            release();
            await act(async () => { await inFlight; });
        }
        assertAllIntents(storage.getState().settings.actionsSettingsV1);
        assertAllIntents(runtime.pendingSettings.actionsSettingsV1);
        assertAllIntents(loadPendingAccountSettings(scope).actionsSettingsV1);
        await act(async () => { await flush(); });
        expect(runtime.pendingSettings).toEqual({});
        expect(conflicts).toBe(1);
        const response = await harness.request('https://action-edits.example/v2/account/settings');
        const readback = await response.json() as { content: { t: 'plain'; v: Record<string, unknown> } };
        assertAllIntents(readback.content.v.actionsSettingsV1);
        expect(readback.content.v.analyticsOptOut).toBe(true);
        // A stale whole-object diff would also lose a reversal to the original
        // rendered value. The canonical updater applies both explicit intents.
        const archive = controls()[1]!;
        await act(async () => { archive(value === 'off' ? 'on' : 'off'); archive(value); });
        await act(async () => { await flush(); });
        assertAllIntents(storage.getState().settings.actionsSettingsV1);
        expect(runtime.pendingSettings).toEqual({});
    });
});
