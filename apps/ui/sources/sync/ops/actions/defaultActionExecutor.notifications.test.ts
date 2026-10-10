import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import type { StorageState } from '@/sync/store/types';
import nacl from 'tweetnacl';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ExternalActionExecutionAuthorizationRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';

let daemonResult: unknown;
let beforeDaemonReply: (() => Promise<void>) | undefined;

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
let machineState: Pick<StorageState, 'machines' | 'machineListByServerId'>;

// Boundary installation above must run before loading the real Action graph;
// module preparation belongs to collection rather than the first hook timeout.
await import('@/sync/domains/state/storage');
await import('./defaultActionExecutor');

async function addHome() {
    const serverId = await harness.addHome({
        name: 'Notification Home',
        serverUrl: 'https://notifications-home.example',
        accountId: 'account-a',
        serverIdentityId: 'srv_notifications', currentAccount: true,
    });
    const { storage } = await import('@/sync/domains/state/storage');
    const machine = createMachineFixture({ id: 'notification-relay', activeAt: Date.now(), storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER });
    storage.setState({
        machines: { [machine.id]: machine },
        machineListByServerId: { [serverId]: [machine] },
    });
    const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(5));
    harness.answer(serverId, '/v1/machines', { body: [{ id: machine.id, kind: 'persistent', active: true,
        installationId: 'notification-installation', installationPublicKey: encodeBase64(installation.publicKey), revokedAt: null,
        replacedByMachineId: null, dataEncryptionKey: null, runnerContentKeyBinding: null,
        access: { custodian: { accountId: 'account-a', displayName: 'Account A' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } }] });
    for (const actionId of ['notifications.notify_me', 'action.options.resolve'] as const) {
        harness.answer(serverId, `/v1/actions/${actionId}/execution-authorization`, { select: body => {
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            return { body: { v: 1, token: 'notification-root', binding: { accountId: 'account-a',
                authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId: 'srv_notifications', machineId: machine.id,
                installationId: 'notification-installation', custodianAccountId: 'account-a', accountEncryptionMode: 'plain', actionId,
                requestId: request.envelope.requestId, target: request.envelope.target,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope) } } };
        } });
        harness.answer(serverId, `/v1/actions/${actionId}`, { select: async body => {
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            expect(openExternalActionRequesterAccountContextV1({ authorization: request.executionAuthorization, purpose: { kind: 'external_action' },
                machineId: machine.id, installationId: 'notification-installation', serverIdentityId: 'srv_notifications',
                installationPrivateKey: installation.secretKey, includeInvocation: true })).toMatchObject({ invocation: {
                    caller: { kind: 'host' }, authority: actionId === 'notifications.notify_me' ? 'account_automation' : 'present_user',
                    surface: actionId === 'notifications.notify_me' ? 'voice' : 'ui' } });
            await beforeDaemonReply?.();
            return { body: { v: 1, actionId, requestId: request.envelope.requestId,
                execution: daemonResult && typeof daemonResult === 'object' && 'ok' in daemonResult ? daemonResult : { ok: true, result: daemonResult } } };
        } });
    }
    return serverId;
}

describe('default Action notification daemon transport', () => {
    beforeEach(async () => {
        await harness.reset();
        daemonResult = undefined;
        beforeDaemonReply = undefined;
        const { storage } = await import('@/sync/domains/state/storage');
        const state = storage.getState();
        machineState = { machines: state.machines, machineListByServerId: state.machineListByServerId };
    });

    afterEach(async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState(machineState);
        standardCleanup();
    });

    it('sends Notify me through the captured Account daemon without inventing a resource target', async () => {
        const serverId = await addHome();
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        daemonResult = { attemptedChannels: 1, deliveredChannels: 1 };
        const input = { title: 'Review', message: 'Review did not converge', channels: ['builtin:expo_push'] };

        await expect(createDefaultActionExecutor().execute('notifications.notify_me', input, {
            surface: 'voice', serverId,
        })).resolves.toEqual({ ok: true, result: { attemptedChannels: 1, deliveredChannels: 1 } });
        expect(harness.requestsFor('/v1/actions/notifications.notify_me').map(request =>
            ExternalActionExecutionAuthorizationRequestV1Schema.parse(request.input).envelope.input)).toEqual([input]);
    });

    it('resolves Send to options from that same Account host through the declared Action route', async () => {
        const serverId = await addHome();
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const options = [{ value: 'plugin/channel', label: 'Plugin channel', disabled: true }];
        const result = {
            actionId: null, fieldPath: null, optionsSourceId: 'notifications.channels.available', options,
        };
        daemonResult = result;

        await expect(createDefaultActionExecutor().execute('action.options.resolve', {
            optionsSourceId: 'notifications.channels.available',
        }, { surface: 'ui', serverId })).resolves.toEqual({ ok: true, result });
        expect(harness.requestsFor('/v1/actions/action.options.resolve').map(request =>
            ExternalActionExecutionAuthorizationRequestV1Schema.parse(request.input).envelope.input))
            .toEqual([{ actionId: 'notifications.notify_me', fieldPath: 'channels' }]);
    });

    it('does not borrow the focused Home daemon for a notification Account on another Home', async () => {
        const serverId = await addHome();
        const otherServerId = await harness.addHome({
            name: 'Other Home', serverUrl: 'https://other-notifications-home.example', accountId: 'account-b',
        });
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        await expect(createDefaultActionExecutor().execute('notifications.notify_me', { message: 'Private' }, {
            surface: 'voice', serverId,
        })).resolves.toMatchObject({ ok: false, errorCode: 'target_unavailable' });
        expect(otherServerId).not.toBe(serverId);
        expect(harness.requestsFor('/v1/actions/notifications.notify_me')).toEqual([]);
    });

    it('withholds channel content when the captured Account changes while its daemon answers', async () => {
        const serverId = await addHome();
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        beforeDaemonReply = async () => {
            await harness.switchAccount(serverId, 'account-b');
        };
        daemonResult = { optionsSourceId: 'notifications.channels.available', options: [{ value: 'private/channel', label: 'Private channel' }] };
        await expect(createDefaultActionExecutor().execute('action.options.resolve', {
            optionsSourceId: 'notifications.channels.available',
        }, { surface: 'ui', serverId })).resolves.toMatchObject({
            ok: false, errorCode: 'action_account_scope_changed',
        });
    });

    it('preserves the daemon delivery failure rather than reporting a sent notification', async () => {
        const serverId = await addHome();
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const failure = { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
        daemonResult = failure;
        await expect(createDefaultActionExecutor().execute('notifications.notify_me', { message: 'Hi' }, {
            surface: 'voice', serverId,
        })).resolves.toEqual(failure);
    });
});
