import { MMKV } from 'react-native-mmkv';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';

export type NotificationPermissionRequest = Readonly<{
    serverId: string;
    accountId: string;
    sessionId: string;
    requestId: string;
    action: 'allow' | 'deny';
}>;
export type NotificationPermissionState = 'not_sent' | 'issued' | 'confirmed' | 'rejected' | 'unconfirmed';
type Record = NotificationPermissionRequest & Readonly<{
    state: NotificationPermissionState;
    updatedAt: number;
}>;
type JournalStorage = Pick<MMKV, 'getString' | 'set' | 'delete' | 'getAllKeys'>;
const PREFIX = 'request:v1:';

// A device-local replay journal, not a queue. Only an ambiguous issuance carries
// a durable replay obligation: the CLI's admission/settlement already refuses
// decisions for claimed or no-longer-outstanding requests, and a never-sent
// record issued nothing. At capacity, settled or never-sent records are
// reclaimed oldest-first; if only ambiguous records remain, admission fails
// closed and requires in-app review. The bound limits ambiguity retention.
const MAX_RECORDS = 512;
export class NotificationPermissionJournal {
    constructor(private readonly storage: JournalStorage, private readonly capacity = MAX_RECORDS) {}

    key(request: NotificationPermissionRequest): string {
        return PREFIX + JSON.stringify([request.serverId, request.accountId, request.sessionId, request.requestId]);
    }

    read(request: NotificationPermissionRequest): Record | null {
        const raw = this.storage.getString(this.key(request));
        if (raw === undefined) return null;
        const record: unknown = JSON.parse(raw);
        if (typeof record !== 'object' || record === null
            || !('action' in record) || (record.action !== 'allow' && record.action !== 'deny')
            || !('state' in record) || !['not_sent', 'issued', 'confirmed', 'rejected', 'unconfirmed'].includes(String(record.state))
            || !('updatedAt' in record) || typeof record.updatedAt !== 'number'
            || !('serverId' in record) || record.serverId !== request.serverId
            || !('accountId' in record) || record.accountId !== request.accountId
            || !('sessionId' in record) || record.sessionId !== request.sessionId
            || !('requestId' in record) || record.requestId !== request.requestId) {
            throw new Error('Invalid notification permission journal');
        }
        return record as Record;
    }

    ensureCapacity(request: NotificationPermissionRequest): void {
        if (this.storage.getString(this.key(request)) !== undefined) return;
        const keys = this.storage.getAllKeys().filter((key) => key.startsWith(PREFIX));
        const excess = keys.length - this.capacity + 1;
        if (excess <= 0) return;
        const reclaimable: { key: string; updatedAt: number }[] = [];
        for (const key of keys) {
            const candidate = this.readReclaimCandidate(key);
            if (candidate) reclaimable.push(candidate);
        }
        if (reclaimable.length < excess) throw new Error('Notification permission journal is full');
        reclaimable.sort((a, b) => a.updatedAt - b.updatedAt);
        for (const candidate of reclaimable.slice(0, excess)) this.storage.delete(candidate.key);
    }

    // Issued/unconfirmed records must survive: they are the only proof that a
    // decision may already have reached the CLI. Everything else is reclaimable,
    // including an unreadable record, which cannot express a replay obligation.
    private readReclaimCandidate(key: string): { key: string; updatedAt: number } | null {
        const raw = this.storage.getString(key);
        if (raw === undefined) return { key, updatedAt: 0 };
        try {
            const record: unknown = JSON.parse(raw);
            if (typeof record !== 'object' || record === null) return { key, updatedAt: 0 };
            const state = 'state' in record ? record.state : undefined;
            if (state === 'issued' || state === 'unconfirmed') return null;
            const updatedAt = 'updatedAt' in record && typeof record.updatedAt === 'number' ? record.updatedAt : 0;
            return { key, updatedAt };
        } catch {
            return { key, updatedAt: 0 };
        }
    }

    write(request: NotificationPermissionRequest, state: NotificationPermissionState): void {
        this.ensureCapacity(request);
        this.storage.set(this.key(request), JSON.stringify({ ...request, state, updatedAt: Date.now() } satisfies Record));
    }
}

const storage = new MMKV({ id: scopedStorageId('notification-permission-actions', readStorageScopeFromEnv()) });
export const notificationPermissionJournal = new NotificationPermissionJournal(storage);

// Only a generic recovery flag is needed before authentication has been resolved.
// Never persist tokens, tool arguments, notification bodies, or exception messages.
export function markNotificationPermissionRecoveryNeeded(): void {
    storage.set('recovery-needed', '1');
}

export function consumeNotificationPermissionRecoveryNeeded(): boolean {
    if (storage.getString('recovery-needed') !== '1') return false;
    storage.set('recovery-needed', '0');
    return true;
}
