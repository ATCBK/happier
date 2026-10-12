import {
    PendingRequestedActionV1Schema,
    PendingResetStartCancelInputV1Schema,
    PendingResetStartSetInputV1Schema,
    type PendingResetStartBindingV1,
} from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { projectExternalActionPendingResetStartReadPurposeDigestV1, type ExternalActionPendingResetStartAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { QualifiedConnectedServiceUsageSourceV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { parseQualifiedConnectedAccountV4StructuredQueryValue } from '@happier-dev/protocol';
import { QualifiedProviderAccountUsageHistoryRequestV4Schema } from '@happier-dev/protocol/connect/providerAccountUsageHistory';

/** One exact Pending purpose for both signed Action proof and direct route admission. */
export function readExternalActionPendingResetStartPurpose(input: Readonly<{
    actionId: string;
    method: string;
    path: string;
    body: unknown;
}>): Readonly<{ sessionId: string; localId: string; reset?: PendingResetStartBindingV1 }> | null {
    const isSet = input.actionId === 'session.pending.resetStart.set';
    if (!isSet && input.actionId !== 'session.pending.resetStart.cancel') return null;
    if (isSet && input.method.toUpperCase() === 'POST') {
        const initial = /^\/v2\/sessions\/([^/?]+)\/pending$/u.exec(input.path);
        if (!initial || typeof input.body !== 'object' || input.body === null || Array.isArray(input.body)) return null;
        const body = input.body as Readonly<Record<string, unknown>>;
        if (Object.keys(body).some(key => !['localId', 'content', 'ciphertext', 'messageRole', 'targetMachineId', 'requestedAction'].includes(key))
            || Object.hasOwn(body, 'content') === Object.hasOwn(body, 'ciphertext')
            || body.messageRole !== undefined && body.messageRole !== 'user') return null;
        const action = PendingRequestedActionV1Schema.safeParse(body.requestedAction);
        if (!action.success || action.data.kind !== 'reset_start') return null;
        try {
            const parsed = PendingResetStartSetInputV1Schema.safeParse({ sessionId: decodeURIComponent(initial[1]),
                localId: body.localId, reset: action.data.reset, initialInput: {
                    content: Object.hasOwn(body, 'content') ? body.content : { t: 'encrypted', c: body.ciphertext },
                    ...(body.targetMachineId !== undefined ? { targetMachineId: body.targetMachineId } : {}),
                } });
            return parsed.success ? { sessionId: parsed.data.sessionId, localId: parsed.data.localId, reset: parsed.data.reset } : null;
        } catch { return null; }
    }
    if (input.method.toUpperCase() !== (isSet ? 'PATCH' : 'POST')) return null;
    const match = (isSet ? /^\/v2\/sessions\/([^/?]+)\/pending\/([^/?]+)\/action$/u
        : /^\/v2\/sessions\/([^/?]+)\/pending\/([^/?]+)\/withdraw$/u).exec(input.path);
    if (!match || typeof input.body !== 'object' || input.body === null || Array.isArray(input.body)) return null;
    const body = input.body as Readonly<Record<string, unknown>>;
    if (isSet) {
        if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'requestedAction')) return null;
        const requestedAction = PendingRequestedActionV1Schema.safeParse(body.requestedAction);
        if (!requestedAction.success || requestedAction.data.kind !== 'reset_start') return null;
    } else if (Object.keys(body).length !== 0) return null;
    try {
        const ids = PendingResetStartCancelInputV1Schema.safeParse({
            sessionId: decodeURIComponent(match[1]), localId: decodeURIComponent(match[2]),
        });
        if (!ids.success) return null;
        if (!isSet) return ids.data;
        const action = PendingRequestedActionV1Schema.parse(body.requestedAction);
        return action.kind === 'reset_start' ? { ...ids.data, reset: action.reset } : null;
    } catch {
        return null;
    }
}

/** The reset root can open only the current record and its exact accepted witness. */
export function isExternalActionPendingResetStartReadPurpose(input: Readonly<{
    method: string; path: string; body: unknown; admission: ExternalActionPendingResetStartAdmissionV1;
}>): boolean {
    if (input.method.toUpperCase() !== 'GET' || input.body !== undefined) return false;
    const url = new URL(input.path, 'http://home.invalid');
    if (url.hash) return false;
    if (url.pathname === '/v1/account/encryption/currentness') return url.search === '';
    const field = url.pathname === '/v4/connect/qualified/provider-account-usage/sources/resolve' ? 'source'
        : url.pathname === '/v4/connect/qualified/provider-account-usage/record' ? 'recordId'
        : url.pathname === '/v4/connect/qualified/provider-account-usage/history' ? 'query' : null;
    if (!field || Array.from(url.searchParams.keys()).length !== 1 || !url.searchParams.has(field)) return false;
    const value = url.searchParams.get(field);
    try {
        if (field === 'recordId') return projectExternalActionPendingResetStartReadPurposeDigestV1({ kind: 'record', recordId: value! }) === input.admission.recordDigest;
        if (field === 'source') return input.admission.sourceDigest === projectExternalActionPendingResetStartReadPurposeDigestV1({ kind: 'source',
            source: parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedServiceUsageSourceV4Schema, value) });
        const query = parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedProviderAccountUsageHistoryRequestV4Schema, value);
        return 'witness' in query && Object.keys(query).length === 2
            && projectExternalActionPendingResetStartReadPurposeDigestV1({ kind: 'record', recordId: query.recordId }) === input.admission.recordDigest
            && projectExternalActionPendingResetStartReadPurposeDigestV1({ kind: 'witness', witness: query.witness }) === input.admission.witnessDigest;
    } catch { return false; }
}
