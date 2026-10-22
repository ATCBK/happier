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
type JournalStorage = Pick<MMKV, 'getString' | 'set' | 'getAllKeys'>;
const PREFIX = 'request:v1:';

// A device-local replay journal, not a queue. The bound limits retained approval
// metadata. At capacity we require in-app review; eviction would enable replay.
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
        if (this.storage.getAllKeys().filter((key) => key.startsWith(PREFIX)).length >= this.capacity) {
            throw new Error('Notification permission journal is full');
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
