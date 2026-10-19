import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod/mini';
import { PileItemRefStoredV1Schema, StorageReasonV1Schema, type PileItemRefV1, type StorageItemRefV1, type StorageActorV1, type StorageSizeV1, type PileSummaryV1 } from '@happier-dev/protocol/storage/storageV1';
import { readProtectedLocalStateFile, writeProtectedLocalStateFileAtomic } from '@/utils/fs/protectedLocalState';
import { physicalStoragePathWithoutFollowingLeaf as physicalPathWithoutFollowingLeaf, storageAbsolutePath as resolve,
    storagePathsEqual as canonicalAbsolutePathsEqual, storagePathContains } from './storagePath';
import { readStoragePathIdentity } from './trash/removeStoragePath';

export type PileStoredView = Readonly<{ items: PileItemRefV1[]; droppedSinceLastView: PileSummaryV1['droppedSinceLastView'] }>;
export type PileDelta = Readonly<{ add?: readonly StorageItemRefV1[]; remove?: readonly string[]; clear?: boolean }>;
export type DeclinedStorageItem = Readonly<{ ref: PileItemRefV1; size: StorageSizeV1; lastChangedAt?: number }>;
const storedState = z.object({ v: z.literal(1), items: z.array(PileItemRefStoredV1Schema),
    declined: z._default(z.record(z.string(), z.object({ path: z.string(), fingerprint: z.string() })), () => ({})),
    dropped: z._default(z.array(z.object({ itemId: z.string(), path: z.string(), reason: StorageReasonV1Schema })), () => []),
});
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function identityMatches(ref: PileItemRefV1, identity: Awaited<ReturnType<typeof readStoragePathIdentity>>) {
    return ref.identity.dev === identity.dev && ref.identity.ino === identity.ino && ref.identity.kind === identity.kind;
}
export function pilePathContains(parent: string, child: string): boolean {
    return storagePathContains(parent, child);
}
export function createPileStore(deps: Readonly<{ activeServerDir: string; now?: () => number }>) {
    const now = deps.now ?? Date.now;
    const queues = new Map<string, Promise<unknown>>();
    const file = (accountId: string) => join(deps.activeServerDir, 'storage', 'piles', `${hash(accountId)}.json`);
    async function read(accountId: string): Promise<z.infer<typeof storedState>> {
        try { return storedState.parse(JSON.parse(await readProtectedLocalStateFile(file(accountId))) as unknown); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { v: 1, items: [], declined: {}, dropped: [] }; throw error; }
    }
    const save = async (accountId: string, state: z.infer<typeof storedState>) => {
        await writeProtectedLocalStateFileAtomic(file(accountId), JSON.stringify(state), { authority: 'owned' });
    };
    function serial<T>(accountId: string, operation: () => Promise<T>): Promise<T> {
        const operationResult = (queues.get(accountId) ?? Promise.resolve()).then(operation);
        queues.set(accountId, operationResult.catch(() => {})); return operationResult;
    }
    async function prune(state: z.infer<typeof storedState>) {
        const surviving: PileItemRefV1[] = [];
        for (const item of state.items) {
            try {
                const physical = await physicalPathWithoutFollowingLeaf(item.path);
                if (!canonicalAbsolutePathsEqual(physical, item.path) || !identityMatches(item, await readStoragePathIdentity(physical))) {
                    state.dropped.push({ itemId: item.itemId, path: item.path, reason: { code: 'changed_since_review' } });
                } else surviving.push(item);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                state.dropped.push({ itemId: item.itemId, path: item.path, reason: { code: 'missing' } });
            }
        }
        state.items = surviving;
    }
    function view(state: z.infer<typeof storedState>): PileStoredView {
        const result = { items: [...state.items], droppedSinceLastView: [...state.dropped] }; state.dropped = []; return result;
    }
    const declinedFingerprint = (item: DeclinedStorageItem) => hash(JSON.stringify([
        item.ref.path, item.ref.identity.dev, item.ref.identity.ino ?? item.ref.identity.fileId, item.ref.identity.kind,
        item.size.allocatedBytes, item.lastChangedAt === undefined ? null : Math.floor(item.lastChangedAt / 86_400_000),
    ]));
    return {
        get(accountId: string): Promise<PileStoredView> { return serial(accountId, async () => {
            const state = await read(accountId); const previous = JSON.stringify(state);
            await prune(state); const result = view(state);
            if (JSON.stringify(state) !== previous) await save(accountId, state);
            return result;
        }); },
        set(accountId: string, delta: PileDelta, actor: StorageActorV1,
            resolveFingerprint?: (ref: StorageItemRefV1) => Promise<string | undefined>): Promise<PileStoredView> {
            return serial(accountId, async () => {
                if (actor.accountId !== accountId) throw Object.assign(new Error('Pile actor mismatch'), { code: 'unauthorized' });
                const state = await read(accountId); await prune(state);
                state.items = delta.clear ? [] : state.items.filter(item => !delta.remove?.includes(item.itemId));
                for (const supplied of delta.add ?? []) {
                    const path = await physicalPathWithoutFollowingLeaf(resolve(supplied.path));
                    const fingerprint = await resolveFingerprint?.(supplied);
                    const identity = await readStoragePathIdentity(path);
                    const item: PileItemRefV1 = { itemId: supplied.itemId, path, identity: { ...identity, ...(fingerprint ? { fingerprint } : {}) },
                        collectedAt: now(), collectedBy: actor };
                    if (state.items.some(parent => pilePathContains(parent.path, path))) continue;
                    state.items = state.items.filter(child => !pilePathContains(path, child.path));
                    state.items.push(item);
                }
                const result = view(state); await save(accountId, state); return result;
            });
        },
        removeActed(accountId: string, itemIds: readonly string[]): Promise<void> { return serial(accountId, async () => {
            const state = await read(accountId); state.items = state.items.filter(item => !itemIds.includes(item.itemId)); await save(accountId, state);
        }); },
        decline(accountId: string, items: readonly DeclinedStorageItem[]): Promise<void> { return serial(accountId, async () => {
            const state = await read(accountId);
            for (const item of items) {
                if (!identityMatches(item.ref, await readStoragePathIdentity(item.ref.path))) continue;
                state.declined[item.ref.itemId] = { path: item.ref.path, fingerprint: declinedFingerprint(item) };
            }
            await save(accountId, state);
        }); },
        isDeclined(accountId: string, item: DeclinedStorageItem): Promise<boolean> { return serial(accountId, async () => {
            const state = await read(accountId); const declined = state.declined[item.ref.itemId];
            if (!declined) return false;
            let unchanged = false;
            try { unchanged = identityMatches(item.ref, await readStoragePathIdentity(item.ref.path)); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            if (unchanged && declined.fingerprint === declinedFingerprint(item)) return true;
            delete state.declined[item.ref.itemId]; await save(accountId, state); return false;
        }); },
    };
}
