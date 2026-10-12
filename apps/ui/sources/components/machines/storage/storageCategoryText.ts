import type { MachineStoragePolicyV1 } from '@happier-dev/protocol/storage/storageV1';

import { getPreferredLanguage, t } from '@/text';

import { isStorageCategoryPartial, readStorageCategoryFact, type StorageCategory } from './storageViewModel';

/**
 * A kind's one evidence line under its name in the breakdown ("192 worktrees · 61 can be deleted",
 * "Kept for 30 days"), from the counts the machine reports and this machine's own retention.
 */
export function describeStorageCategoryFacts(category: StorageCategory, policy: MachineStoragePolicyV1 | null): string {
    const count = category.count;
    const canGo = readStorageCategoryFact(category, 'canGoCount');
    const keep = readStorageCategoryFact(category, 'keepCount');
    const line = ((): string => {
        switch (category.categoryId) {
            case 'worktrees': return t('machineStorage.facts.worktrees', { count, canGo });
            case 'caches': return t('machineStorage.facts.caches', { count, canGo });
            case 'modelPacks': return t('machineStorage.facts.modelPacks', { count, keep });
            case 'sessionFolders': return t('machineStorage.facts.sessionFolders', { count, canGo });
            case 'logs': {
                const days = policy?.logRetentionDays;
                return days === null ? t('machineStorage.facts.logsKeptForever')
                    : t('machineStorage.facts.logsKeptDays', { days: days ?? 30 });
            }
            case 'agentHomes': return t('machineStorage.facts.agentHomes');
            case 'temporary':
                if (count === 0) return t('machineStorage.facts.nothing');
                return canGo === count ? t('machineStorage.facts.temporaryUnused') : t('machineStorage.facts.temporaryInUse', { count: count - canGo });
            case 'recordings': return t('machineStorage.facts.recordings', { count });
            case 'trash': return count === 0 ? t('machineStorage.facts.trashEmpty') : t('machineStorage.facts.trash', { count });
            case 'ownData': return t('machineStorage.facts.ownData');
        }
    })();
    return isStorageCategoryPartial(category) ? `${line} · ${t('machineStorage.breakdown.notFullyCounted')}` : line;
}

/** "Oct 17": a day as the Trash empties on it, in the reader's language. */
export function formatStorageDay(at: number): string {
    return new Intl.DateTimeFormat(getPreferredLanguage(), { month: 'short', day: 'numeric' }).format(at);
}
