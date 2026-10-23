import { MMKV } from 'react-native-mmkv';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';

// Presentation only. The Session owner admits and settles every permission.
const storage = new MMKV({ id: scopedStorageId('notification-permission-actions', readStorageScopeFromEnv()) });

export function markNotificationPermissionRecoveryNeeded(): void {
    storage.set('recovery-needed', '1');
}

export function consumeNotificationPermissionRecoveryNeeded(): boolean {
    if (storage.getString('recovery-needed') !== '1') return false;
    storage.set('recovery-needed', '0');
    return true;
}
