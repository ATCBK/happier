import { MachineRemoteAlertV1Schema, type MachineRemoteAlertV1 } from '@happier-dev/protocol/push/machineRemoteAlert';
import { resolveAccountRemoteAlertPolicyCurrentness, resolveRemoteAlertPolicyDecision } from '@happier-dev/protocol/account/settings/accountRemoteAlertPolicy';
import { resolveExpoNotificationSoundName, resolvePushNotificationAndroidChannelId } from '@happier-dev/protocol/push/pushNotificationActions';
import { shouldMuteMobileAlertsForComputerFocus } from '@happier-dev/protocol/account/settings/attentionDeliveryPolicyDecision';
import { eventRouter } from '@/app/events/eventRouter';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { db } from '@/storage/db';
import { log } from '@/utils/logging/log';
import { sendAccountExpoPushMessages, type AccountPushDelivery } from '../accountPushTransport';

/** Presence owns the transition; current Machine custody and published consent own delivery. */
export async function submitMachineRemoteAlerts(params: Readonly<{
    machines: readonly Readonly<{ machineId: string; accountId: string }>[];
    phase: MachineRemoteAlertV1['phase'];
}>): Promise<void> {
    if (params.machines.length === 0) return;
    try {
        // Recheck custody at submission, rather than disclosing an old owner's
        // Machine identity after ownership, revocation or replacement changes.
        const machines = await db.machine.findMany({
            where: { OR: params.machines.map(({ machineId, accountId }) => ({ id: machineId, accountId })),
                revokedAt: null, replacedByMachineId: null },
            select: { id: true, accountId: true },
        });
        if (machines.length === 0) return;
        const accountIds = [...new Set(machines.map(machine => machine.accountId))];
        const [accounts, tokens] = await Promise.all([
            db.account.findMany({ where: { id: { in: accountIds } },
                select: { id: true, settingsVersion: true, remoteAlertPolicy: true } }),
            db.accountPushToken.findMany({ where: { accountId: { in: accountIds } },
                select: { accountId: true, token: true, remoteAlerts: true } }),
        ]);
        const now = new Date();
        const serverId = await getOrCreateServerIdentityId(process.env);
        const deliveries: AccountPushDelivery[] = [];
        for (const account of accounts) {
            const current = resolveAccountRemoteAlertPolicyCurrentness(account.remoteAlertPolicy, account.settingsVersion);
            if (current.status !== 'current') continue;
            const policy = current.policy;
            if (!policy.events.machine_offline.enabled || !policy.channels.expo_push.enabled
                || !policy.channels.expo_push.events.machine_offline.enabled) continue;
            const enrolled = machines.filter(machine => machine.accountId === account.id
                && policy.machineOffline.machineIds.includes(machine.id));
            if (enrolled.length === 0) continue;
            if (params.phase === 'offline' && policy.mutePhoneWhenComputerFocused === true
                && shouldMuteMobileAlertsForComputerFocus({ mutePhoneWhenComputerFocused: true,
                    computerFocused: await eventRouter.hasFocusedComputerUi(account.id) })) continue;
            for (const token of tokens.filter(row => row.accountId === account.id)) {
                const decision = resolveRemoteAlertPolicyDecision({ accountPolicy: policy,
                    devicePolicy: token.remoteAlerts, event: 'machine_offline', now });
                if (!decision || (params.phase === 'offline' && decision.delivery === 'suppress')) continue;
                for (const machine of enrolled) {
                    const data = MachineRemoteAlertV1Schema.parse({ type: 'machine_alert', v: 1,
                        serverId, accountId: account.id, machineId: machine.id, phase: params.phase,
                        previewBehavior: decision.previewBehavior });
                    if (params.phase === 'recovered') {
                        // Dismissal is not a new alert: quiet hours and focused
                        // computer muting must not leave an obsolete notice up.
                        deliveries.push({ accountId: account.id, token: token.token,
                            message: { to: token.token, priority: 'normal', _contentAvailable: true, data } });
                        continue;
                    }
                    const soundId = decision.delivery === 'silent' || decision.sound.kind === 'none'
                        || decision.sound.kind === 'custom' ? 'none' : decision.sound.id;
                    const sound = resolveExpoNotificationSoundName(soundId);
                    deliveries.push({ accountId: account.id, token: token.token, message: {
                        to: token.token, title: 'Happier', body: 'A machine you follow went offline.',
                        ...(sound === null ? {} : { sound }),
                        channelId: resolvePushNotificationAndroidChannelId({ kind: 'ready', soundId }),
                        priority: decision.delivery === 'silent' ? 'normal' : 'high', mutableContent: true, data,
                    } });
                }
            }
        }
        await sendAccountExpoPushMessages(deliveries, 'machine-remote-alerts');
    } catch (error) {
        // Optional push failure may not interrupt presence publication or change
        // the established timeout/heartbeat lifecycle.
        log({ module: 'machine-remote-alerts', level: 'warn', err: error }, 'Machine remote alert submission failed');
    }
}
