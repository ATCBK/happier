import { canonicalAbsolutePathsEqual } from '@/utils/path/expandHomeDirPath';
import { getHappierTempRoot } from '@happier-dev/cli-common/tempDirs';
import { MachineStoragePolicyV1Schema, StorageItemV1Schema, type StorageItemV1, type StorageReasonV1 } from '@happier-dev/protocol/storage/storageV1';
import { contains } from './categories/filesystem';
import { worktrees } from './categories/worktrees';
import { caches, managedAcpCacheCleanupLimitation } from './categories/caches';
import { modelPacks } from './categories/modelPacks';
import { sessionFolders } from './categories/sessionFolders';
import { logs } from './categories/logs';
import { agentHomes } from './categories/agentHomes';
import { temporary } from './categories/temporary';
import { recordings } from './categories/recordings';
import { ownData, trash } from './categories/retainedData';
import { StorageCategoryAdapterError } from './categories/types';
import type { StorageCategoryAdapter, StorageCategoryCatalogDeps, StorageCategoryItem, StorageCleanupItem, StorageCategoryContext, StorageCategoryDefinition, StorageCategoryDiscoverySnapshot, StorageProjectFacts, StorageCategoryVerdict } from './categories/types';
import { bindFilesystemItem, filesystemAdapterForEntry } from './categories/filesystemAdapters';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { HappierStorageCategoryIdV1 } from '@happier-dev/protocol/storage/storageV1';
import { physicalStoragePathWithoutFollowingLeaf } from './storagePath';
import { readStorageWorktrees } from '@/daemon/resources/readStorageWorktrees';
export type { StorageCategoryAdapter, StorageCategoryCatalogDeps, StorageCategoryItem, StorageProjectFacts, StorageCategoryDiscoverySnapshot } from './categories/types';

const categories: readonly StorageCategoryDefinition[] = [worktrees, caches, modelPacks, sessionFolders, logs,
    agentHomes, temporary, recordings, trash, ownData];
export const STORAGE_CATEGORY_IDS = categories.map(category => category.id);
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_UNUSED_AFTER_DAYS = MachineStoragePolicyV1Schema.parse({}).suggestUnusedAfterDays;
const UNAVAILABLE_PROJECT_FACTS: StorageProjectFacts = { status: 'unavailable' };

/** Private custody/fingerprint facts never become Machine RPC presentation fields. */
export function publicStorageItem(item: StorageItemV1): StorageItemV1 {
    return StorageItemV1Schema.strip().parse(item);
}

/** Containers inherit their owned descendants' facts through the same catalog decision. */
export function foldStorageDescendantVerdicts(item: StorageCategoryVerdict, children: readonly StorageCleanupItem[]): StorageCategoryVerdict {
    const protectedItems = children.filter(child => child.verdict === 'keep' || child.verdict === 'check' || child.verdict === 'forbidden');
    if (!protectedItems.length || item.verdict === 'forbidden') return item;
    const forbidden = protectedItems.some(child => child.verdict === 'forbidden');
    const unavailable = protectedItems.some(child => child.verdict === 'check');
    const verdict = forbidden ? 'forbidden' : unavailable && item.verdict !== 'keep' ? 'check' : 'keep';
    return { ...item, verdict, collectable: item.collectable && !forbidden && verdict !== 'check',
        reason: item.verdict === verdict ? item.reason : { code: forbidden ? 'contains_forbidden' : verdict === 'check' ? 'facts_unavailable' : 'contains',
            detail: { count: protectedItems.length } },
        loses: [...(item.loses ?? []), ...protectedItems.flatMap(child => child.loses ?? [{ ...child.reason,
            detail: { ...child.reason.detail, path: child.path } }])] };
}

/** The catalog is the single category projection and lifecycle-adapter dispatch owner. */
export function createStorageCategoryCatalog(deps: StorageCategoryCatalogDeps) {
    const dataRoots = () => [deps.happyHomeDir, deps.activeServerDir, getHappierTempRoot(deps.tempRoot)].filter((path, index, paths) =>
        !paths.slice(0, index).some(previous => canonicalAbsolutePathsEqual(previous, path)));
    const context = async (paths: readonly string[] = []): Promise<StorageCategoryContext> => {
        const now = deps.now?.() ?? Date.now();
        const [allocations, modelPacks, recordings, temporaryFacts, isolationFacts, inUse, projectFacts, worktrees] = await Promise.all([
            deps.managedSessionDirectories?.listRecords() ?? [], (deps.readModelPackRuntime?.() ?? deps.modelPackRuntime)?.list() ?? deps.readModelPacks?.() ?? [],
            deps.readRecordings?.() ?? [], deps.readTemporaryFacts?.() ?? [],
            deps.readIsolationFacts?.() ?? [], deps.readInUsePaths?.() ?? { reliable: false, paths: [] },
            deps.readProjects?.() ?? UNAVAILABLE_PROJECT_FACTS, deps.readWorktrees?.() ?? [],
        ]);
        const missingPaths = paths.filter(path => !worktrees.some(worktree => canonicalAbsolutePathsEqual(worktree.path, path)));
        const scannedWorktrees = missingPaths.length ? await readStorageWorktrees({ cwds: [], candidatePaths: missingPaths,
            knownRoots: worktrees.map(worktree => worktree.path),
            happyHomeDir: deps.happyHomeDir, registry: deps.scmRegistry, trashRoots: deps.trashRoots?.() }) : [];
        return { deps, now, unusedBefore: now - (deps.readPolicy?.().suggestUnusedAfterDays ?? DEFAULT_UNUSED_AFTER_DAYS) * DAY_MS,
            sessions: deps.readTrackedSessions?.() ?? [], allocations, modelPacks, recordings, temporaryFacts,
            isolationFacts, inUse, projects: projectFacts.projects ?? [],
            projectsAvailable: projectFacts.status === 'ready',
            worktrees: [...new Map([...worktrees, ...scannedWorktrees].map(worktree => [worktree.path, worktree])).values()], discoveryIssues: [] };
    };
    async function projectSnapshot(facts: StorageCategoryContext): Promise<StorageCategoryDiscoverySnapshot> {
        const discovered = [...(await Promise.all(categories.map(category => category.items(facts)))).flat(), ...facts.discoveryIssues];
        // Recording files can also live in session uploads; the specialized owner wins exact duplicates.
        const byPath = new Map<string, StorageCategoryItem>();
        for (const item of discovered) {
            if (!byPath.has(item.path) || item.categoryId === 'recordings') byPath.set(item.path, item);
        }
        const items = [...byPath.values()];
        return { items: items.map(item => ({ ...item, ...foldStorageDescendantVerdicts(item,
            items.filter(child => child.path !== item.path && contains(item.path, child.path))) })),
            incompleteCategoryIds: facts.projectsAvailable ? [] : ['worktrees', 'sessionFolders'] };
    }
    const catalog = {
        categoryIds: STORAGE_CATEGORY_IDS,
        dataRoots,
        async roots() {
            const facts = await context();
            return categories.map(category => ({ categoryId: category.id, paths: category.roots(facts) }));
        },
        async discoverSnapshot(paths: readonly string[] = []): Promise<StorageCategoryDiscoverySnapshot> {
            return projectSnapshot(await context(paths));
        },
        async discover(paths: readonly string[] = [], current?: readonly StorageCategoryItem[]): Promise<readonly StorageCategoryItem[]> {
            if (!current) return (await catalog.discoverSnapshot(paths)).items;
            // Indexed aliases keep the same freshly inspected SCM path, even when their item ids differ.
            const missingPaths = paths.filter(path => !current.some(item => item.categoryId === 'worktrees'
                && canonicalAbsolutePathsEqual(item.path, path)));
            if (!missingPaths.length) return current;
            const scanned = await readStorageWorktrees({ cwds: [], candidatePaths: missingPaths,
                knownRoots: current.filter(item => item.categoryId === 'worktrees').map(item => item.path),
                happyHomeDir: deps.happyHomeDir, registry: deps.scmRegistry, trashRoots: deps.trashRoots?.() });
            if (!scanned.length) return current;
            const facts = await context();
            return (await projectSnapshot({ ...facts,
                worktrees: [...new Map([...facts.worktrees, ...scanned].map(worktree => [worktree.path, worktree])).values()] })).items;
        },
        descendantCleanupLimitation(path: string, discovered: readonly StorageCategoryItem[]): StorageReasonV1 | null {
            const owner = discovered.find(item => !canonicalAbsolutePathsEqual(item.path, path) && contains(item.path, path)
                && (item.retirementKind === 'common'
                    || categories.find(category => category.id === item.categoryId)?.descendantCleanup === 'whole-item-only'));
            return owner ? { code: 'unsupported', detail: { cause: 'owner_requires_whole_item', categoryId: owner.categoryId, path: owner.path } } : null;
        },
        async cleanupLimitation(path: string, items: readonly StorageCleanupItem[]): Promise<StorageReasonV1 | null> {
            const managedInstall = await managedAcpCacheCleanupLimitation(path, deps);
            if (managedInstall) return managedInstall;
            const projects = await deps.readProjects?.();
            const roots = [...new Set([...(projects?.projects ?? []).map(project => project.repositoryRoot),
                ...items.flatMap(item => item.repositoryRoot ? [item.repositoryRoot] : [])])];
            const main = (await Promise.all(roots.map(physicalStoragePathWithoutFollowingLeaf)))
                .find(repositoryRoot => contains(path, repositoryRoot));
            // Never give an unbound container a filesystem bypass around SCM retirement.
            return main && !items.some(item => item.retirementKind === 'main' && canonicalAbsolutePathsEqual(item.path, main)
                && item.fingerprint && item.referenceOwnerData !== undefined)
                ? { code: 'unsupported', detail: { cause: 'checkout_reference_owner_unavailable', owner: 'scm', path: main } } : null;
        },
        async resolveAdapter(item: StorageCleanupItem): Promise<StorageCategoryAdapter> {
            if (item.categoryId === undefined) return bindFilesystemItem(item);
            const category = categories.find(category => category.id === item.categoryId);
            if (!category?.bindAdapter) throw new StorageCategoryAdapterError('owner_unavailable');
            const facts = await context([item.path]);
            const current = (await category.items(facts)).find(candidate => candidate.itemId === (item.canonicalItemId ?? item.itemId)
                && canonicalAbsolutePathsEqual(candidate.path, item.path));
            if (!current) throw new StorageCategoryAdapterError('owner_unavailable');
            return await category.bindAdapter(current, facts);
        },
        async adapterForEntry(categoryId: HappierStorageCategoryIdV1 | undefined, ownerData: JsonValue): Promise<StorageCategoryAdapter> {
            if (categoryId === undefined) return filesystemAdapterForEntry(ownerData);
            const category = categories.find(category => category.id === categoryId);
            if (!category?.adapterForEntry) throw new StorageCategoryAdapterError('owner_unavailable');
            return await category.adapterForEntry(ownerData, deps);
        },
    };
    return catalog;
}
