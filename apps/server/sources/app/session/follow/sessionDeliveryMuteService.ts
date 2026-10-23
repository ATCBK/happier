import {
    FollowDeliveryMuteScopeV1Schema,
    followDeliveryMuteScopeKeyV1,
    isFollowDeliveryMutedV1,
    readPersistedFollowDeliveryMutesV1,
    type FollowDeliveryMuteScopeV1,
    type FollowReceiverRefV1,
    type FollowSourceRefV1,
} from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import { isActiveHomeAccountStatus } from '@happier-dev/protocol/home/governance';

import { resolveEffectiveSessionAccess } from '@/app/session/access/sessionAccess';
import { acquireAccountChangePublicationLocksInTx, enqueueAccountChangePublication } from '@/app/changes/markAccountChanged';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { acquireSessionAccountCursorLocksInTx } from '@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx';
import { markSessionFollowsChangedInTx } from './changes';
import { inReadSnapshot, inTx, transactionResult, type Tx } from '@/storage/inTx';

export type DeliveryMuteFailure = 'invalid_parameters' | 'account_inactive' | 'session_not_found' | 'mute_state_unavailable';
export type DeliveryMuteResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: DeliveryMuteFailure }>;
export type DeliveryMuteCandidate = Readonly<{ senderSessionId?: string; source?: FollowSourceRefV1 }>;

async function readAdmittedReceiverInTx(tx: Tx, input: Readonly<{
    accountId: string;
    receiver: FollowReceiverRefV1;
    authentication: SessionAccessAuthentication;
}>) {
    const account = await tx.account.findUnique({ where: { id: input.accountId }, select: { status: true, deliveryMutes: true } });
    if (!account || !isActiveHomeAccountStatus(account.status)) return { ok: false as const, error: 'account_inactive' as const };
    if (input.receiver.kind === 'account') return { ok: true as const, stored: account.deliveryMutes };
    const access = await resolveEffectiveSessionAccess(tx, {
        accountId: input.accountId, sessionId: input.receiver.sessionId, authentication: input.authentication,
    });
    if (access?.capabilities.submitAgentInput !== true) return { ok: false as const, error: 'session_not_found' as const };
    const session = await tx.session.findUnique({
        where: { id: input.receiver.sessionId }, select: { deliveryMutes: true },
    });
    return session ? { ok: true as const, stored: session.deliveryMutes }
        : { ok: false as const, error: 'session_not_found' as const };
}

/** One receiver read shared by a batch's candidate decisions, after caller admission. */
export async function readDeliveryMuteScopesInTx(tx: Tx, input: Readonly<{
    receiver: FollowReceiverRefV1;
    accountId: string;
}>): Promise<readonly FollowDeliveryMuteScopeV1[] | null> {
    const stored = input.receiver.kind === 'account'
        ? (await tx.account.findUnique({ where: { id: input.accountId }, select: { deliveryMutes: true } }))?.deliveryMutes
        : (await tx.session.findUnique({ where: { id: input.receiver.sessionId }, select: { deliveryMutes: true } }))?.deliveryMutes;
    if (stored === undefined) return null;
    return readPersistedFollowDeliveryMutesV1(stored);
}

/** Reads one receiver's routing preference at its current intake transaction. */
export async function isDeliveryMutedInTx(tx: Tx, input: Readonly<{
    receiver: FollowReceiverRefV1;
    accountId: string;
    candidate: DeliveryMuteCandidate;
}>): Promise<boolean | null> {
    const scopes = await readDeliveryMuteScopesInTx(tx, input);
    return scopes === null ? null : isFollowDeliveryMutedV1(scopes, input.candidate);
}

/** One lazy receiver read for this observation only; the next observation reads fresh. */
export function createDeliveryMuteReaderInTx(tx: Tx, input: Readonly<{
    receiver: FollowReceiverRefV1;
    accountId: string;
}>): (candidate: DeliveryMuteCandidate) => Promise<boolean | null> {
    let scopes: Promise<readonly FollowDeliveryMuteScopeV1[] | null> | undefined;
    return async candidate => {
        const current = await (scopes ??= readDeliveryMuteScopesInTx(tx, input));
        return current === null ? null : isFollowDeliveryMutedV1(current, candidate);
    };
}

/** One Account-scoped policy read for the personal alert recipient batch. */
export async function readAccountDeliveryMutedForRecipientsInTx(tx: Tx, input: Readonly<{
    accountIds: readonly string[];
    candidate: DeliveryMuteCandidate;
}>): Promise<ReadonlyMap<string, boolean | null>> {
    const rows = await tx.account.findMany({ where: { id: { in: [...input.accountIds] } },
        select: { id: true, deliveryMutes: true } });
    const byId = new Map(rows.map(row => [row.id, row.deliveryMutes]));
    return new Map(input.accountIds.map(accountId => {
        const stored = byId.get(accountId);
        if (stored === undefined) return [accountId, null] as const;
        const scopes = readPersistedFollowDeliveryMutesV1(stored);
        return [accountId, scopes === null ? null : isFollowDeliveryMutedV1(scopes, input.candidate)] as const;
    }));
}

/** Lists only the caller's own Account preference or an admitted Session receiver. */
export async function listDeliveryMutes(input: Readonly<{
    accountId: string;
    receiver: FollowReceiverRefV1;
    authentication: SessionAccessAuthentication;
}>): Promise<DeliveryMuteResult<Readonly<{ scopes: FollowDeliveryMuteScopeV1[] }>>> {
    return await inReadSnapshot(async tx => {
        const receiver = await readAdmittedReceiverInTx(tx, input);
        if (!receiver.ok) return receiver;
        const scopes = readPersistedFollowDeliveryMutesV1(receiver.stored);
        return scopes === null ? { ok: false, error: 'mute_state_unavailable' } as const
            : { ok: true, value: { scopes } } as const;
    });
}

/** Idempotent set/remove changes only future receiver admission, never Follow edges. */
export async function changeDeliveryMute(input: Readonly<{
    accountId: string;
    receiver: FollowReceiverRefV1;
    scope: FollowDeliveryMuteScopeV1;
    operation: 'set' | 'remove';
    authentication: SessionAccessAuthentication;
}>): Promise<DeliveryMuteResult<Readonly<{ changed: boolean; disposition: 'muted' | 'unmuted' }>>> {
    const parsed = FollowDeliveryMuteScopeV1Schema.safeParse(input.scope);
    if (!parsed.success) return { ok: false, error: 'invalid_parameters' };
    const change = async (tx: Tx): Promise<DeliveryMuteResult<Readonly<{
        changed: boolean; disposition: 'muted' | 'unmuted';
    }>>> => {
        const receiver = await readAdmittedReceiverInTx(tx, input);
        if (!receiver.ok) return receiver;
        const scopes = readPersistedFollowDeliveryMutesV1(receiver.stored);
        if (scopes === null) return { ok: false, error: 'mute_state_unavailable' } as const;
        const key = followDeliveryMuteScopeKeyV1(parsed.data);
        const exists = scopes.some(scope => followDeliveryMuteScopeKeyV1(scope) === key);
        const changed = input.operation === 'set' ? !exists : exists;
        const disposition = input.operation === 'set' ? 'muted' as const : 'unmuted' as const;
        if (!changed) return { ok: true, value: { changed: false, disposition } } as const;
        const next = (input.operation === 'set' ? [...scopes, parsed.data]
            : scopes.filter(scope => followDeliveryMuteScopeKeyV1(scope) !== key))
            .sort((a, b) => followDeliveryMuteScopeKeyV1(a).localeCompare(followDeliveryMuteScopeKeyV1(b)));
        const deliveryMutes = JSON.stringify(next);
        if (input.receiver.kind === 'account') {
            await tx.account.update({ where: { id: input.accountId }, data: { deliveryMutes } });
        } else {
            await tx.session.update({ where: { id: input.receiver.sessionId }, data: { deliveryMutes } });
        }
        await markSessionFollowsChangedInTx(tx, { accountId: input.accountId });
        return { ok: true, value: { changed: true, disposition } } as const;
    };
    return await inTx(async tx => {
        if (input.receiver.kind === 'account') {
            await acquireAccountChangePublicationLocksInTx(tx, [input.accountId], { includeSingleAccount: true });
            let result: Awaited<ReturnType<typeof change>> | undefined;
            // Compatible entry is not a list-write mutex. Read and merge only
            // under the existing terminal Account lock, including no-op results.
            enqueueAccountChangePublication(tx, [input.accountId], async client => { result = await change(client); });
            return transactionResult(() => {
                if (result === undefined) throw new Error('Account delivery-mute merge did not run');
                return result;
            });
        }
        // Session receiver editors already serialize through their resource owner.
        await acquireSessionAccountCursorLocksInTx(tx, [input.receiver.sessionId], [input.accountId]);
        return change(tx);
    });
}
