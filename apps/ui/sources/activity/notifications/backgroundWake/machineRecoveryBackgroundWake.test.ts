import { afterEach, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { saveAccountSettings } from '@/sync/domains/state/accountSettingsPersistence';
import { settingsParse } from '@/sync/domains/settings/settings';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import type { Notification } from 'expo-notifications';

installDisconnectedServerSocketBoundary();
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { applySessionChangedBackgroundWakePayload } = await import('./defineSessionChangedBackgroundWakeTask');
const { resolveForegroundNotificationBehavior } = await import('../resolveForegroundNotificationBehavior');
afterEach(async () => { await home.reset(); });

it('dismisses only a recovered machine notice belonging to the prepared Account on its exact Home', async () => {
    const serverId = await home.addHome({ name: 'Recovery', serverUrl: 'https://recovery.test', serverIdentityId: 'srv_recovery', accountId: 'owner', currentAccount: true });
    saveAccountSettings({ serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'owner' }, settingsParse({ machineOfflineAlertsV1: { machineIds: ['machine'] } }), 1);
    const dismissNotificationAsync = vi.fn(async () => {});
    const alert = { type: 'machine_alert', v: 1, serverId: 'srv_recovery', accountId: 'owner', machineId: 'machine', phase: 'recovered', previewBehavior: 'status_only' };
    const notice = (identifier: string, data: Record<string, unknown>): Notification => ({ date: 1, request: { identifier, trigger: null,
        content: { title: null, subtitle: null, body: null, data, sound: null, categoryIdentifier: null } } });
    const getPresentedNotificationsAsync = vi.fn(async () => [
        notice('os-actual-id', { ...alert, phase: 'offline' }),
        notice('os-return-notice', alert),
        notice('os-other-account', { ...alert, phase: 'offline', accountId: 'other' }),
        notice('os-other-home', { ...alert, phase: 'offline', serverId: 'srv_unknown' }),
        notice('os-other-machine', { ...alert, phase: 'offline', machineId: 'other' }),
        notice('os-malformed', { ...alert, phase: 'offline', sessionId: 'foreign' }),
    ]);
    const params = { payload: { data: { dataString: JSON.stringify(alert) } }, notifications: { dismissNotificationAsync, getPresentedNotificationsAsync } };
    expect(await applySessionChangedBackgroundWakePayload(params)).toMatchObject({ action: 'dismissed', machineId: 'machine', serverId });
    expect(dismissNotificationAsync.mock.calls).toEqual([['os-actual-id']]);
    for (const changed of [{ ...alert, accountId: 'other' }, { ...alert, serverId: 'srv_unknown' }, { ...alert, phase: 'offline' }, { ...alert, sessionId: 'untrusted' }]) {
        await applySessionChangedBackgroundWakePayload({ ...params, payload: changed });
    }
    expect(dismissNotificationAsync.mock.calls).toHaveLength(1);
    getPresentedNotificationsAsync.mockImplementationOnce(async () => {
        await home.switchAccount(serverId, 'replacement');
        return [notice('os-late-id', { ...alert, phase: 'offline' })];
    });
    await applySessionChangedBackgroundWakePayload(params);
    expect(dismissNotificationAsync.mock.calls).toHaveLength(1);
});

it('presents opted-in offline and requested return notices under their own Home policy, keeping data-only recovery quiet', async () => {
    const serverId = await home.addHome({ name: 'Foreground', serverUrl: 'https://foreground.test', serverIdentityId: 'srv_foreground', accountId: 'owner', currentAccount: true });
    saveAccountSettings({ serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'owner' }, settingsParse({ machineOfflineAlertsV1: { machineIds: ['machine'] }, attentionDeliveryPolicyV1: { v: 1, foregroundBehavior: 'full' } }), 1);
    const alert = { type: 'machine_alert', v: 1, serverId: 'srv_foreground', accountId: 'owner', machineId: 'machine', phase: 'offline', previewBehavior: 'status_only' };
    const resolve = (data: unknown) => resolveForegroundNotificationBehavior({ content: { data }, localSettings: null, now: new Date('2026-10-11T12:00:00Z'), isSessionVisible: () => false });
    expect(await resolve(alert)).toBe('full');
    expect(await resolveForegroundNotificationBehavior({ content: { data: { ...alert, phase: 'recovered' },
        body: 'A machine you follow is back online.' }, localSettings: null,
        now: new Date('2026-10-11T12:00:00Z'), isSessionVisible: () => false })).toBe('full');
    for (const changed of [{ ...alert, accountId: 'other' }, { ...alert, machineId: 'not-opted-in' }, { ...alert, phase: 'recovered' }, { ...alert, serverId: 'srv_unknown' }]) expect(await resolve(changed)).toBe('off');
});
