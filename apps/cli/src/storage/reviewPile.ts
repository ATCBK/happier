import { createHash } from 'node:crypto';
import type { PileItemRefV1, PileReviewV1, StorageItemV1, StorageReasonV1, StorageSizeV1 } from '@happier-dev/protocol/storage/storageV1';
import { storageAbsolutePath as resolve, physicalStoragePathWithoutFollowingLeaf as physicalPathWithoutFollowingLeaf,
    storagePathsEqual as canonicalAbsolutePathsEqual } from './storagePath';
import type { StorageCategoryItem, StorageCleanupItem } from './categories/types';
import type { NativeDiskMeasurement, NativeDiskMeasureRequest } from './measure/nativeDiskMeasure';
import { readStoragePathIdentity } from './trash/removeStoragePath';
import { pilePathContains } from './pileStore';
import { foldStorageDescendantVerdicts } from './categoryCatalog';

export type ResolvedPileItem = Readonly<{
    item: StorageCleanupItem; fingerprint?: string; fingerprintRequired?: boolean; ownFingerprint?: string;
    /** Every current owned descendant, supplied by one fresh canonical catalog snapshot. */
    retirementChildren?: readonly StorageCategoryItem[];
}>;
export type PileReviewDeps = Readonly<{
    resolve(ref: PileItemRefV1): Promise<ResolvedPileItem | null>;
    classify(physicalPath: string, item: StorageCleanupItem): Promise<Readonly<{
        verdict: StorageItemV1['verdict']; reason: StorageReasonV1; loses?: readonly StorageReasonV1[];
    }>>;
    measure(request: NativeDiskMeasureRequest): Promise<NativeDiskMeasurement>;
    trashAvailability?(path: string): Promise<PileReviewV1['trashVolumes'][number]>;
    cleanupLimitation?(path: string, items: readonly StorageCleanupItem[]): Promise<StorageReasonV1 | null>;
    /** One current catalog/protection read per pass, discarded before the next execution recheck. */
    freshFacts?(): Promise<Pick<PileReviewDeps, 'resolve' | 'classify' | 'cleanupLimitation'>>;
}>;
export class PileFactError extends Error {
    constructor(readonly code: 'changed_since_review' | 'missing' | 'facts_unavailable' | 'storage_forbidden', readonly reason?: StorageReasonV1) {
        super(code); this.name = 'PileFactError';
    }
}
export function storageSizeFromMeasurement(value: NativeDiskMeasurement['perPath'][number]): StorageSizeV1 {
    return { allocatedBytes: value.allocatedBytes, freesBytes: value.exclusiveBytes, sharedBytes: value.sharedBytes,
        sharedExtentsUnmeasured: value.sharedExtentsUnmeasured, atLeast: value.atLeast,
        ...(value.freesUpToBytes === undefined ? {} : { freesUpToBytes: value.freesUpToBytes }) };
}
export type PileChildFact = Readonly<{ ref: PileItemRefV1; item: StorageCategoryItem; ownFingerprint?: string }>;
type PileExpectFacts = Readonly<{ ref: PileItemRefV1; ownFingerprint?: string; children: readonly PileChildFact[] }>;
export function pileFactsExpect(facts: PileExpectFacts, completedChildren: ReadonlySet<string> = new Set()): string {
    const identity = (ref: PileItemRefV1) => [ref.itemId, ref.path, ref.identity.dev, ref.identity.ino ?? ref.identity.fileId, ref.identity.kind];
    return createHash('sha256').update(JSON.stringify([
        identity(facts.ref), facts.ownFingerprint ?? null,
        facts.children.filter(child => !completedChildren.has(child.ref.itemId))
            .map(child => [identity(child.ref), child.ownFingerprint ?? null, child.item.verdict, child.item.reason])
            .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    ])).digest('hex');
}
/** Shared review/apply fact boundary; callers never supply catalog or protection authority. */
export async function readPileFacts(ref: PileItemRefV1, deps: PileReviewDeps) {
    try {
        const current = await deps.freshFacts?.() ?? deps;
        const path = await physicalPathWithoutFollowingLeaf(resolve(ref.path));
        if (!canonicalAbsolutePathsEqual(path, resolve(ref.path))) throw new PileFactError('changed_since_review');
        const identity = await readStoragePathIdentity(path);
        if (ref.identity.dev !== identity.dev || ref.identity.ino !== identity.ino || ref.identity.kind !== identity.kind) {
            throw new PileFactError('changed_since_review');
        }
        const resolved = await current.resolve(ref);
        if (!resolved) throw new PileFactError('facts_unavailable');
        const ownFingerprint = resolved.ownFingerprint ?? resolved.fingerprint;
        if ((resolved.fingerprintRequired || resolved.item.fingerprintRequired) && !ownFingerprint) throw new PileFactError('facts_unavailable');
        const canonicalPath = await physicalPathWithoutFollowingLeaf(resolve(resolved.item.path));
        if (!canonicalAbsolutePathsEqual(path, canonicalPath) || resolved.item.itemId !== ref.itemId) throw new PileFactError('changed_since_review');
        const ownClassification = await current.classify(path, resolved.item);
        const freshRef: PileItemRefV1 = { ...ref, path, title: resolved.item.title, identity: { ...identity, ...(resolved.fingerprint ? { fingerprint: resolved.fingerprint } : {}) } };
        const children: PileChildFact[] = [];
        for (const item of resolved.retirementChildren ?? []) {
            const childPath = await physicalPathWithoutFollowingLeaf(resolve(item.path));
            if (canonicalAbsolutePathsEqual(path, childPath) || !pilePathContains(path, childPath)) throw new PileFactError('facts_unavailable');
            const childIdentity = await readStoragePathIdentity(childPath);
            const childFingerprint = item.ownFingerprint ?? item.fingerprint;
            if (item.fingerprintRequired && !childFingerprint) throw new PileFactError('facts_unavailable');
            const classification = await current.classify(childPath, item);
            children.push({ item: { ...item, ...classification,
                loses: classification.loses ? [...classification.loses] : item.loses }, ownFingerprint: childFingerprint,
                ref: { itemId: item.itemId, path: childPath, title: item.title, identity: childIdentity, collectedAt: ref.collectedAt, collectedBy: ref.collectedBy } });
        }
        const classification = foldStorageDescendantVerdicts({ ...ownClassification, collectable: resolved.item.collectable,
            loses: ownClassification.loses ? [...ownClassification.loses] : undefined }, children.map(child => child.item));
        if (classification.verdict !== 'forbidden') {
            const limitation = await current.cleanupLimitation?.(path, [resolved.item, ...children.map(child => child.item)]);
            if (limitation) throw new PileFactError('facts_unavailable', limitation);
        }
        const facts = { ref: freshRef, item: resolved.item, identity, classification, ownFingerprint, children };
        return { ...facts, expect: pileFactsExpect(facts) };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new PileFactError('missing');
        throw error;
    }
}
export async function reviewPile(refs: readonly PileItemRefV1[], deps: PileReviewDeps): Promise<PileReviewV1> {
    const review: PileReviewV1 = { items: [], staying: [], countedOnceBytes: 0, totalFreesBytes: 0, trashVolumes: [] };
    const facts: Awaited<ReturnType<typeof readPileFacts>>[] = [];
    for (const ref of refs) {
        try { facts.push(await readPileFacts(ref, deps)); }
        catch (error) { review.staying.push({ item: { itemId: ref.itemId, path: ref.path, ...(ref.title === undefined ? {} : { title: ref.title }) },
            reason: error instanceof PileFactError && error.reason ? error.reason
                : { code: error instanceof PileFactError && error.code !== 'storage_forbidden' ? error.code : 'facts_unavailable' } }); }
    }
    const minimal = facts.filter((fact, index) => !facts.some((parent, parentIndex) => parentIndex !== index
        && pilePathContains(parent.ref.path, fact.ref.path)
        && (!canonicalAbsolutePathsEqual(parent.ref.path, fact.ref.path) || parentIndex < index)));
    if (!minimal.length) return review;
    const actionable = minimal.filter(fact => fact.classification.verdict !== 'forbidden');
    const selected = facts.filter(fact => fact.classification.verdict !== 'forbidden'
        && actionable.some(parent => pilePathContains(parent.ref.path, fact.ref.path)));
    // Native attribution belongs to the most-specific selected root. Include
    // absorbed roots in this one union, then fold their attributed bytes back
    // into the surviving parent instead of measuring overlapping paths twice.
    const paths = [...new Set(selected.map(fact => fact.ref.path))];
    const measured = paths.length ? await deps.measure({ paths, measureSharedExtents: true }) : null;
    const absorbedPaths = new Set(selected.filter(fact => !minimal.includes(fact)).map(fact => fact.ref.path));
    review.countedOnceBytes = measured?.perPath.filter(value => absorbedPaths.has(value.path))
        .reduce((sum, value) => sum + value.allocatedBytes, 0) ?? 0;
    for (const fact of minimal) {
        const measurement = measured?.perPath.find(value => canonicalAbsolutePathsEqual(value.path, fact.ref.path));
        if (!measurement && fact.classification.verdict !== 'forbidden') throw new PileFactError('facts_unavailable');
        const attributed = measured?.perPath.filter(value => pilePathContains(fact.ref.path, value.path)) ?? [];
        const size: StorageSizeV1 = measurement ? {
            allocatedBytes: attributed.reduce((sum, value) => sum + value.allocatedBytes, 0),
            freesBytes: attributed.reduce((sum, value) => sum + value.exclusiveBytes, 0),
            sharedBytes: attributed.reduce((sum, value) => sum + value.sharedBytes, 0),
            sharedExtentsUnmeasured: attributed.some(value => value.sharedExtentsUnmeasured),
            atLeast: attributed.some(value => value.atLeast),
            ...(attributed.some(value => value.freesUpToBytes !== undefined)
                ? { freesUpToBytes: attributed.reduce((sum, value) => sum + (value.freesUpToBytes ?? value.exclusiveBytes), 0) } : {}),
        }
            : { allocatedBytes: 0, freesBytes: 0, sharedBytes: 0, sharedExtentsUnmeasured: true, atLeast: true };
        const absorbs = [...new Set([...facts.filter(other => other !== fact && pilePathContains(fact.ref.path, other.ref.path)).map(other => other.ref.itemId),
            ...fact.children.map(child => child.ref.itemId)])];
        review.items.push({ ref: fact.ref, title: fact.item.title, expect: fact.expect, verdict: fact.classification.verdict, reason: fact.classification.reason,
            ...(fact.classification.loses ? { loses: [...fact.classification.loses] } : {}), size, absorbs });
        if (fact.classification.verdict === 'forbidden') review.staying.push({ item: { itemId: fact.ref.itemId, path: fact.ref.path, title: fact.item.title }, reason: fact.classification.reason });
        if (deps.trashAvailability) {
            const availability = await deps.trashAvailability(fact.ref.path);
            if (!review.trashVolumes.some(volume => volume.volumeId === availability.volumeId)) review.trashVolumes.push(availability);
        }
    }
    // The native union's exclusive bytes include links across different roots;
    // summing conservative per-root exclusivity would undercount that union.
    review.totalFreesBytes = measured?.totalExclusiveBytes ?? 0;
    return review;
}
