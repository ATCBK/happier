import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isUnsafeNotificationServerUrl, parseNotificationTap } from './notificationRouting';
import { buildGuardStopWarningPushDataV1 } from '@happier-dev/protocol/activity/webhookPayload';
import { PUSH_NOTIFICATION_ACTION_IDS } from '@happier-dev/protocol/push/pushNotificationActions';

const serverProfiles = await import('@/sync/domains/server/serverProfiles');

const DEFAULT_ACTION_IDENTIFIER = 'expo.modules.notifications.actions.DEFAULT';

function tapResponse(data: unknown) {
    return {
        actionIdentifier: DEFAULT_ACTION_IDENTIFIER,
        notification: { request: { identifier: 'notif-1', content: { data } } },
    };
}

function remoteAlert(overrides: Record<string, unknown> = {}) {
    return {
        type: 'activity_alert',
        v: 1,
        serverId: 'srv_acme',
        sessionId: 'session-1',
        accountId: 'account-1',
        event: { type: 'ready', messageSeq: 3 },
        previewBehavior: 'status_only',
        ...overrides,
    };
}

async function clearProfiles(): Promise<void> {
    for (const profile of serverProfiles.listServerProfiles()) {
        await serverProfiles.removeServerProfile(profile.id);
    }
}

describe('activity remote alert taps', () => {
    beforeEach(clearProfiles);
    afterEach(clearProfiles);

    it('admits exact Guard warning Actions on their saved Home, including standalone terminals', async () => {
        const home = await serverProfiles.upsertServerProfile({ serverUrl: 'https://guard.example.test', name: 'Guard' });
        const other = await serverProfiles.upsertServerProfile({ serverUrl: 'https://other.example.test', name: 'Other' });
        await serverProfiles.setActiveServerId(other.id, { scope: 'device' });
        for (const warning of [
            { topic: 'guard_stop_warning', machineId: 'machine', sessionId: 'session', rule: 'idle_sessions', stopAt: 300_000 },
            { topic: 'guard_stop_warning', machineId: 'machine', terminalId: 'terminal', terminalKey: 'key', rule: 'idle_terminals', stopAt: 300_000 },
        ] as const) {
            const data = { ...buildGuardStopWarningPushDataV1(warning), serverUrl: home.serverUrl };
            for (const [identifier, action] of [[PUSH_NOTIFICATION_ACTION_IDS.guardKeepRunningV1, 'keepRunning'],
                [PUSH_NOTIFICATION_ACTION_IDS.guardStopNowV1, 'stopNow']] as const) {
                const parsed = parseNotificationTap({ response: { ...tapResponse(data), actionIdentifier: identifier },
                    defaultActionIdentifier: DEFAULT_ACTION_IDENTIFIER });
                expect(parsed?.command).toMatchObject({ kind: 'executeAction', actionId: data.actions[action].actionId,
                    payload: { ...data.actions[action].input, serverId: home.id }, target: { serverId: home.id } });
            }
            expect(parseNotificationTap({ response: { ...tapResponse({ ...data, serverUrl: 'https://unknown.example.test' }),
                actionIdentifier: PUSH_NOTIFICATION_ACTION_IDS.guardStopNowV1 }, defaultActionIdentifier: DEFAULT_ACTION_IDENTIFIER })?.command)
                .toMatchObject({ kind: 'ignore', reason: 'unknown_server' });
            expect(parseNotificationTap({ response: { ...tapResponse({ ...data, notificationId: 'wrong' }),
                actionIdentifier: PUSH_NOTIFICATION_ACTION_IDS.guardStopNowV1 }, defaultActionIdentifier: DEFAULT_ACTION_IDENTIFIER })?.command)
                .toMatchObject({ kind: 'ignore', reason: 'malformed' });
        }
    });

    it('opens the alert Session on its own Home even while another Home is active', async () => {
        const acme = await serverProfiles.upsertServerProfile({ serverUrl: 'https://acme.example.test', name: 'Acme' });
        const personal = await serverProfiles.upsertServerProfile({ serverUrl: 'https://personal.example.test', name: 'Personal' });
        await serverProfiles.setServerProfileIdentityForUrl(acme.serverUrl, 'srv_acme');
        await serverProfiles.setServerProfileIdentityForUrl(personal.serverUrl, 'srv_personal');
        await serverProfiles.setActiveServerId(personal.id, { scope: 'device' });

        const parsed = parseNotificationTap({
            response: tapResponse(remoteAlert()),
            defaultActionIdentifier: DEFAULT_ACTION_IDENTIFIER,
        });
        expect(parsed?.command).toMatchObject({
            kind: 'openSession',
            sessionId: 'session-1',
            serverId: acme.id,
            serverUrl: 'https://acme.example.test',
        });
        expect(parsed?.dedupeKey).toBe(`notif-1:${DEFAULT_ACTION_IDENTIFIER}`);
    });

    it('opens a current Discussion alert at the exact Discussion on its own Home', async () => {
        const acme = await serverProfiles.upsertServerProfile({ serverUrl: 'https://acme.example.test', name: 'Acme' });
        await serverProfiles.setServerProfileIdentityForUrl(acme.serverUrl, 'srv_acme');
        const parsed = parseNotificationTap({
            response: tapResponse(remoteAlert({
                v: 2,
                event: {
                    type: 'discussion_mention', sequenceDomain: 'discussion',
                    discussionId: 'discussion/a', messageSeq: 1,
                },
            })),
            defaultActionIdentifier: DEFAULT_ACTION_IDENTIFIER,
        });
        expect(parsed?.command).toMatchObject({
            kind: 'openSession',
            sessionId: 'session-1',
            serverId: acme.id,
            route: `/session/session-1/discussions/discussion%2Fa?serverId=${encodeURIComponent(acme.id)}&sourceSurface=collaboration`,
        });
    });

    it('ignores an alert whose Home this device cannot name rather than routing it anywhere', async () => {
        const personal = await serverProfiles.upsertServerProfile({ serverUrl: 'https://personal.example.test', name: 'Personal' });
        await serverProfiles.setServerProfileIdentityForUrl(personal.serverUrl, 'srv_personal');
        await serverProfiles.setActiveServerId(personal.id, { scope: 'device' });

        expect(parseNotificationTap({
            response: tapResponse(remoteAlert()),
            defaultActionIdentifier: DEFAULT_ACTION_IDENTIFIER,
        })?.command).toEqual({ kind: 'ignore', reason: 'unknown_server' });
    });

    it('leaves the existing rich owner push payload on its released path', async () => {
        const acme = await serverProfiles.upsertServerProfile({ serverUrl: 'https://acme.example.test', name: 'Acme' });
        await serverProfiles.setActiveServerId(acme.id, { scope: 'device' });
        expect(parseNotificationTap({
            response: tapResponse({ sessionId: 'session-9', serverId: acme.id, serverUrl: acme.serverUrl }),
            defaultActionIdentifier: DEFAULT_ACTION_IDENTIFIER,
        })?.command).toMatchObject({ kind: 'openSession', sessionId: 'session-9', serverId: acme.id });
    });

    it('routes a private machine offline alert to its saved Home overview and never the active Home', async () => {
        const acme = await serverProfiles.upsertServerProfile({ serverUrl: 'https://acme.example.test', name: 'Acme' });
        const personal = await serverProfiles.upsertServerProfile({ serverUrl: 'https://personal.example.test', name: 'Personal' });
        await serverProfiles.setServerProfileIdentityForUrl(acme.serverUrl, 'srv_acme');
        await serverProfiles.setServerProfileIdentityForUrl(personal.serverUrl, 'srv_personal');
        await serverProfiles.setActiveServerId(personal.id, { scope: 'device' });
        const data = { type: 'machine_alert', v: 1, serverId: 'srv_acme', accountId: 'account-1', machineId: 'machine/a', phase: 'offline', previewBehavior: 'status_only' };
        expect(parseNotificationTap({ response: tapResponse(data), defaultActionIdentifier: DEFAULT_ACTION_IDENTIFIER })?.command)
            .toMatchObject({ kind: 'openMachine', machineId: 'machine/a', serverId: acme.id, serverUrl: acme.serverUrl,
                route: `/machines/machine%2Fa?serverId=${encodeURIComponent(acme.id)}` });
        expect(parseNotificationTap({ response: tapResponse({ ...data, serverId: 'unknown' }), defaultActionIdentifier: DEFAULT_ACTION_IDENTIFIER })?.command)
            .toEqual({ kind: 'ignore', reason: 'unknown_server' });
    });
});

describe('notification server URL safety', () => {
    it('rejects every loopback form that another device cannot reach', () => {
        expect(isUnsafeNotificationServerUrl('http://127.0.0.2:3005')).toBe(true);
        expect(isUnsafeNotificationServerUrl('http://relay.localhost:3005')).toBe(true);
        expect(isUnsafeNotificationServerUrl('https://machine.tailnet.ts.net')).toBe(false);
    });
});

describe('machine vitals notification taps', () => {
    it.each([{ kind: 'memory_pressure', tab: 'processes', sort: 'memory' }, { kind: 'cpu_busy', tab: 'processes', sort: 'cpu' },
        { kind: 'disk_nearly_full', tab: 'storage', sort: undefined }] as const)('opens $kind on its exact Home without a Session', ({ kind, tab, sort }) => {
        const command = parseNotificationTap({ response: tapResponse({ topic: 'resource_limit', machineId: 'machine/a', kind, phase: 'started',
            notificationId: 'notice', nextSteps: kind === 'disk_nearly_full' ? ['free_up_space'] : ['review_processes'],
            serverId: 'home-a', serverUrl: 'https://home-a.test' }), defaultActionIdentifier: DEFAULT_ACTION_IDENTIFIER })?.command;
        expect(command).toMatchObject({ kind: 'openMachine', machineId: 'machine/a', serverId: 'home-a', serverUrl: 'https://home-a.test' });
        expect(command && 'route' in command ? command.route : null).toBe(`/machines/machine%2Fa?serverId=home-a&tab=${tab}${sort ? `&sort=${sort}` : ''}`);
    });
    it('refuses malformed resource routing rather than interpreting it as an unrelated Session tap', () => {
        expect(parseNotificationTap({ response: tapResponse({ topic: 'resource_limit', kind: 'cpu_busy', sessionId: 'session' }),
            defaultActionIdentifier: DEFAULT_ACTION_IDENTIFIER })?.command).toMatchObject({ kind: 'ignore' });
    });
});
