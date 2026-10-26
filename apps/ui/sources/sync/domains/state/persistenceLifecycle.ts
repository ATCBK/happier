import { Platform } from 'react-native';
import { clearPersistenceStorage } from './persistenceStorage';

export function clearPersistence(): void | Promise<void> {
    if (Platform.OS === 'web') {
        return (async () => {
            const { discardSessionDraftPersistenceWrites } = await import('../../ops/sessionDrafts/sessionDraftPersistenceStorage');
            const { clearBrowserRecords } = await import('./browserRecordStorage');
            await discardSessionDraftPersistenceWrites();
            await clearBrowserRecords();
            clearPersistenceStorage();
        })();
    }
    clearPersistenceStorage();
}
