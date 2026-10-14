import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';

// Shared Map/Rings drawing geometry also sets native scan folding resolution.
export const STORAGE_TREEMAP_MIN_NODE_PX = { width: 56, height: 20 } as const;
export const STORAGE_TREEMAP_LARGEST_VIEW_PX = { width: 760, height: 300 } as const;
export const STORAGE_RINGS_MIN_ARC_DEGREES = 2;
export const STORAGE_CHART_MAX_DRAWABLE_NODES = Math.max(
  Math.floor((STORAGE_TREEMAP_LARGEST_VIEW_PX.width * STORAGE_TREEMAP_LARGEST_VIEW_PX.height)
    / (STORAGE_TREEMAP_MIN_NODE_PX.width * STORAGE_TREEMAP_MIN_NODE_PX.height)),
  360 / STORAGE_RINGS_MIN_ARC_DEGREES,
);

// Storage V1 is a new Machine RPC epoch, independent of the package version.
// Closed: requests, volume refs, item/category identities and removal facts,
// dropped-item refs, scan envelopes/targets/binary identity, pagination and watch.
// Additive-open/drop: summary/volume totals, sizes, reasons, pile/Trash summaries,
// whole-disk presentation, and nested scan progress/unreadable/permission facts.
// Scalar detail records are presentation-only. No object round-trips unknowns;
// known fields never coerce and accepted extras acquire no authority meaning.
const bytes = () => z.number().int().nonnegative();
const time = () => z.number().int().nonnegative();
const revision = () => z.number().int().nonnegative();
const target = () => ({ serverId: z.string().min(1).optional(), machineId: z.string().min(1) });
const detailFacts = () => z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

export const HappierStorageCategoryIdV1Schema = lazyZodSchema(() => z.enum([
  'worktrees', 'caches', 'modelPacks', 'sessionFolders', 'logs', 'agentHomes', 'temporary', 'recordings', 'trash', 'ownData',
]));
export type HappierStorageCategoryIdV1 = z.infer<typeof HappierStorageCategoryIdV1Schema>;

export const StorageVolumeRefV1Schema = lazyZodSchema(() => z.strictObject({
  volumeId: z.string().min(1), mountPath: z.string().min(1), label: z.string(),
}));
export type StorageVolumeRefV1 = z.infer<typeof StorageVolumeRefV1Schema>;
export const StorageSizeV1Schema = lazyZodSchema(() => z.object({
  allocatedBytes: bytes(), freesBytes: bytes(), freesUpToBytes: bytes().optional(), sharedBytes: bytes(),
  sharedExtentsUnmeasured: z.boolean(), atLeast: z.boolean(),
}));
export type StorageSizeV1 = z.infer<typeof StorageSizeV1Schema>;
export const StorageReasonV1Schema = lazyZodSchema(() => z.object({
  code: z.enum([
    'main_checkout', 'in_use', 'changed_files', 'unpushed_commits', 'unsaved_edits', 'open_pr', 'recent', 'always_kept',
    'merged_clean', 'branch_gone', 'clean_pushed', 'rebuilds', 'reinstalls', 'downloads_again', 'stopped', 'old',
    'attachments_go', 'feature_waits', 'not_rebuildable', 'personal_folder', 'agent_home', 'credentials',
    'user_protected', 'contains', 'root', 'system', 'home_folder', 'happier_install', 'happier_data',
    'contains_forbidden', 'facts_unavailable',
    'changed_since_review', 'missing', 'trash_unavailable', 'destination_occupied', 'parent_missing',
    'unauthorized', 'operation_failed', 'unsupported', 'has_submodules',
  ]),
  // Presentation-only structured facts, never provider-native or executable content.
  detail: detailFacts().optional(),
}));
export type StorageReasonV1 = z.infer<typeof StorageReasonV1Schema>;
export const StorageItemV1Schema = lazyZodSchema(() => z.strictObject({
  itemId: z.string().min(1), kind: z.enum(['category-item', 'worktree', 'suggestion', 'disk-node']),
  categoryId: HappierStorageCategoryIdV1Schema.optional(), title: z.string(), evidence: z.array(z.string()),
  path: z.string().min(1), size: StorageSizeV1Schema, lastChangedAt: time().optional(), lastUsedAt: time().optional(),
  verdict: z.enum(['safe', 'caution', 'keep', 'forbidden', 'check']), reason: StorageReasonV1Schema,
  collectable: z.boolean(), loses: z.array(StorageReasonV1Schema).optional(),
}));
export type StorageItemV1 = z.infer<typeof StorageItemV1Schema>;
export const PileSummaryV1Schema = lazyZodSchema(() => z.object({
  count: z.number().int().nonnegative(), freesBytes: bytes(),
  droppedSinceLastView: z.array(z.strictObject({ itemId: z.string().min(1), path: z.string().min(1), reason: StorageReasonV1Schema })),
}));
export type PileSummaryV1 = z.infer<typeof PileSummaryV1Schema>;
export const TrashSummaryV1Schema = lazyZodSchema(() => z.object({
  count: z.number().int().nonnegative(), allocatedBytes: bytes(), emptiesNextAt: time().optional(),
}));
export type TrashSummaryV1 = z.infer<typeof TrashSummaryV1Schema>;

// Target and scan-id envelope are closed identities; progress/permission facts are read projections.
export const DiskScanStateV1Schema = lazyZodSchema(() => z.strictObject({
  scanId: z.string().min(1),
  target: z.union([z.strictObject({ volumeId: z.string().min(1) }), z.strictObject({ folderPath: z.string().min(1) })]),
  status: z.enum(['running', 'complete', 'cancelled', 'interrupted', 'failed']),
  progress: z.object({ sizedBytes: bytes(), usedBytes: bytes(), items: z.number().int().nonnegative(), currentPath: z.string().optional(), stuckSinceMs: time().optional() }),
  startedAt: time(), finishedAt: time().optional(), previousScanAt: time().optional(),
  // Read-only observation of local Time Machine snapshots on the scanned APFS volume.
  // Missing means unobserved; it never contributes bytes or authorizes cleanup.
  apfsLocalSnapshotCount: z.number().int().nonnegative().optional(),
  unreadable: z.object({
    counts: z.object({ permission: z.number().int().nonnegative(), os_private: z.number().int().nonnegative(), timeout: z.number().int().nonnegative(), io: z.number().int().nonnegative() }),
    examples: z.array(z.object({ path: z.string(), reason: z.string() })),
  }),
  fullDiskAccess: z.object({
    state: z.enum(['granted', 'not_granted', 'unknown', 'not_applicable']),
    binary: z.strictObject({ name: z.string(), path: z.string() }), waitingForConsent: z.boolean().optional(),
  }),
}));
export type DiskScanStateV1 = z.infer<typeof DiskScanStateV1Schema>;

export const DiskNodeV1Schema = lazyZodSchema(() => z.strictObject({
  nodeId: z.string().min(1), parentId: z.string().min(1).optional(), name: z.string(), nameBytes: z.string().optional(),
  kind: z.enum(['folder', 'file', 'package', 'small-items', 'hidden-space', 'reserved', 'mount', 'cloud-only']),
  size: StorageSizeV1Schema, logicalBytes: bytes(), items: bytes(), changedAt: time(), deltaSincePrevious: z.number().int().optional(),
  flags: z.strictObject({ happier: z.boolean(), protection: z.enum(['forbidden', 'keep', 'none']), atLeast: z.boolean(), inUse: z.boolean() }), childCount: bytes(),
  reason: StorageReasonV1Schema.optional(), loses: z.array(StorageReasonV1Schema).optional(),
}));
export type DiskNodeV1 = z.infer<typeof DiskNodeV1Schema>;
export const DiskScanViewV1Schema = lazyZodSchema(() => z.strictObject({
  tab: z.enum(['folders', 'large', 'old', 'insights', 'find']), nodeId: z.string().min(1).optional(), depth: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  sort: z.strictObject({ by: z.enum(['name', 'size', 'items', 'changed', 'since']), direction: z.enum(['asc', 'desc']) }).optional(),
  cursor: z.string().min(1).optional(), pageSize: z.number().int().positive().optional(), minBytes: bytes().optional(),
  olderThanDays: z.number().int().min(1).optional(), olderThanMonths: z.union([z.literal(3), z.literal(6), z.literal(12)]).optional(),
  query: z.strictObject({ name: z.string().optional(), kind: z.enum(['folder', 'file', 'package']).optional(), minBytes: bytes().optional(),
    maxBytes: bytes().optional(), modifiedWithinDays: z.number().int().min(1).optional() }).refine(value => value.minBytes === undefined || value.maxBytes === undefined
      || value.minBytes <= value.maxBytes, { message: 'invalid_size_range' }).optional(),
}).refine(value => value.olderThanDays === undefined || value.olderThanMonths === undefined, { message: 'exclusive_old_age_filter' }));
export type DiskScanViewV1 = z.infer<typeof DiskScanViewV1Schema>;
export const MachineStorageScanStartInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...target(), target: DiskScanStateV1Schema.shape.target, resume: z.boolean().optional(),
}));
export type MachineStorageScanStartInputV1 = z.infer<typeof MachineStorageScanStartInputV1Schema>;
export const MachineStorageScanGetInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), scanId: z.string().min(1).optional(), view: DiskScanViewV1Schema.optional() }));
export type MachineStorageScanGetInputV1 = z.infer<typeof MachineStorageScanGetInputV1Schema>;
export const MachineStorageScanCancelInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), scanId: z.string().min(1) }));
export type MachineStorageScanCancelInputV1 = z.infer<typeof MachineStorageScanCancelInputV1Schema>;
export const MachineStorageScanSkipInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), scanId: z.string().min(1), path: z.string().min(1) }));
export type MachineStorageScanSkipInputV1 = z.infer<typeof MachineStorageScanSkipInputV1Schema>;
export const MachineStorageScanGetResultV1Schema = lazyZodSchema(() => z.strictObject({
  state: DiskScanStateV1Schema.nullable(), nodes: z.array(DiskNodeV1Schema), nextCursor: z.string().min(1).optional(),
  // The selected level's facts are independent of child paging and chart depth.
  root: DiskNodeV1Schema.optional(),
  coverage: z.array(z.strictObject({ path: z.string().min(1), scannedAt: time(), complete: z.boolean() })),
  indexedAt: time().optional(), previousScanAt: time().optional(), findCoverageMinBytes: bytes().optional(),
  insights: z.strictObject({ largestDistinct: z.array(DiskNodeV1Schema),
    changes: z.strictObject({ grew: z.array(DiskNodeV1Schema), shrank: z.array(DiskNodeV1Schema), appeared: z.array(DiskNodeV1Schema), disappeared: z.array(DiskNodeV1Schema) }),
    growthBytes: bytes(), reclaimedBytes: bytes(), notComparableFolders: bytes(),
    ageGroupBytes: z.strictObject({ unknown: bytes(), months3: bytes(), months6: bytes(), months12: bytes() }), trashBytes: bytes(),
  }).optional(),
}));
export type MachineStorageScanGetResultV1 = z.infer<typeof MachineStorageScanGetResultV1Schema>;
export const MachineStorageProtectedAddInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), path: z.string().min(1) }));
export type MachineStorageProtectedAddInputV1 = z.infer<typeof MachineStorageProtectedAddInputV1Schema>;
export const MachineStorageProtectedRemoveInputV1Schema = MachineStorageProtectedAddInputV1Schema;
export type MachineStorageProtectedRemoveInputV1 = z.infer<typeof MachineStorageProtectedRemoveInputV1Schema>;

export const HappierStorageSummaryV1Schema = lazyZodSchema(() => z.object({
  revision: revision(), sizedAt: time(),
  // Daemon-qualified folder entry points, consumed by the ordinary scanner.
  scanShortcuts: z.array(z.strictObject({ kind: z.enum(['downloads', 'cache']), path: z.string().min(1) })).optional(),
  volumes: z.array(z.object({ volume: StorageVolumeRefV1Schema, totalBytes: bytes(), freeBytes: bytes(), happierBytes: bytes(), pileBytes: bytes(), trashBytes: bytes(),
    // Sampled by the vitals capacity owner; presentation only, never free-now or cleanup budget.
    availableIncludingPurgeableBytes: bytes().optional(),
    // A measured verified-Safe union; absence is unreported, not measured zero.
    canGoBytes: bytes().optional(),
  })),
  categories: z.array(z.strictObject({ categoryId: HappierStorageCategoryIdV1Schema, size: StorageSizeV1Schema, canGoBytes: bytes(), count: z.number().int().nonnegative(), detailFacts: detailFacts() })),
  suggestionsTop: z.array(StorageItemV1Schema), pile: PileSummaryV1Schema, trash: TrashSummaryV1Schema,
  wholeDisk: z.object({ enabled: z.boolean(), scans: z.array(DiskScanStateV1Schema) }),
}));
export type HappierStorageSummaryV1 = z.infer<typeof HappierStorageSummaryV1Schema>;

export const MachineStorageSummaryGetInputV1Schema = lazyZodSchema(() => z.strictObject(target()));
export type MachineStorageSummaryGetInputV1 = z.infer<typeof MachineStorageSummaryGetInputV1Schema>;
export const MachineStorageCategoryListInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...target(), categoryId: HappierStorageCategoryIdV1Schema, cursor: z.string().min(1).optional(),
}));
export type MachineStorageCategoryListInputV1 = z.infer<typeof MachineStorageCategoryListInputV1Schema>;
export const StorageCategoryGroupV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.enum(['stopped', 'recent', 'old']), itemIds: z.array(z.string().min(1)), olderThanDays: z.number().int().positive().optional(),
}));
export type StorageCategoryGroupV1 = z.infer<typeof StorageCategoryGroupV1Schema>;
export const MachineStorageCategoryListResultV1Schema = lazyZodSchema(() => z.strictObject({
  revision: revision(), sizedAt: time(), categoryId: HappierStorageCategoryIdV1Schema,
  items: z.array(StorageItemV1Schema), trashEntries: z.array(TrashEntryV1Schema).optional(), nextCursor: z.string().min(1).optional(),
  groups: z.array(StorageCategoryGroupV1Schema).optional(),
}));
export type MachineStorageCategoryListResultV1 = z.infer<typeof MachineStorageCategoryListResultV1Schema>;
export const MachineStorageSizeRefreshInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...target(), categoryId: HappierStorageCategoryIdV1Schema.optional(),
}));
export type MachineStorageSizeRefreshInputV1 = z.infer<typeof MachineStorageSizeRefreshInputV1Schema>;
export const MachineStorageWatchInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...target(), sinceRevision: revision().optional(),
}));
export type MachineStorageWatchInputV1 = z.infer<typeof MachineStorageWatchInputV1Schema>;
export const MachineStorageWatchResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('changed', [
  z.strictObject({ changed: z.literal(true), summary: HappierStorageSummaryV1Schema }),
  z.strictObject({ changed: z.literal(false) }),
]));
export type MachineStorageWatchResultV1 = z.infer<typeof MachineStorageWatchResultV1Schema>;

// Mutation and identity envelopes are closed at every request depth. Persisted
// readers below derive the same known fields and strip only unrecognized data.
export const StorageActorV1Schema = lazyZodSchema(() => z.strictObject({
  accountId: z.string().min(1), kind: z.enum(['person', 'agent']), proposalId: z.string().min(1).optional(),
}));
export type StorageActorV1 = z.infer<typeof StorageActorV1Schema>;
export const StorageIdentityV1Schema = lazyZodSchema(() => z.strictObject({
  dev: z.string().min(1), ino: z.string().min(1).optional(), fileId: z.string().min(1).optional(),
  kind: z.enum(['file', 'directory', 'symlink', 'other']), fingerprint: z.string().min(1).optional(),
}).refine(value => value.ino !== undefined || value.fileId !== undefined, { message: 'file_identity_required' }));
export type StorageIdentityV1 = z.infer<typeof StorageIdentityV1Schema>;
/** A reference from a served category or disk view; the daemon supplies identity and attribution. */
export const StorageItemRefV1Schema = lazyZodSchema(() => z.strictObject({ itemId: z.string().min(1), path: z.string().min(1) }));
export type StorageItemRefV1 = z.infer<typeof StorageItemRefV1Schema>;
export const PileItemRefV1Schema = lazyZodSchema(() => z.strictObject({
  itemId: z.string().min(1), path: z.string().min(1), title: z.string().optional(), identity: StorageIdentityV1Schema,
  collectedAt: time(), collectedBy: StorageActorV1Schema,
}));
export type PileItemRefV1 = z.infer<typeof PileItemRefV1Schema>;
export const PileItemRefStoredV1Schema = lazyZodSchema(() => PileItemRefV1Schema.extend({
  identity: StorageIdentityV1Schema.strip(), collectedBy: StorageActorV1Schema.strip(),
}).strip());

export const StorageItemCheckV1Schema = lazyZodSchema(() => z.object({
  ref: PileItemRefV1Schema, title: z.string().optional(), expect: z.string().min(1), verdict: StorageItemV1Schema.shape.verdict,
  reason: StorageReasonV1Schema, size: StorageSizeV1Schema, absorbs: z.array(z.string().min(1)),
  loses: z.array(StorageReasonV1Schema).optional(),
}));
export type StorageItemCheckV1 = z.infer<typeof StorageItemCheckV1Schema>;
export const PileReviewV1Schema = lazyZodSchema(() => z.object({
  items: z.array(StorageItemCheckV1Schema),
  staying: z.array(z.object({ item: StorageItemRefV1Schema.extend({ title: z.string().optional() }), reason: StorageReasonV1Schema })),
  countedOnceBytes: bytes(), totalFreesBytes: bytes(),
  trashVolumes: z.array(z.strictObject({ volumeId: z.string().min(1), trashAvailable: z.boolean(), reason: StorageReasonV1Schema.optional() })),
}));
export type PileReviewV1 = z.infer<typeof PileReviewV1Schema>;
export const PileApplyResultV1Schema = lazyZodSchema(() => z.strictObject({
  batchId: z.string().min(1), mode: z.enum(['trash', 'delete']),
  outcomes: z.array(z.strictObject({ itemId: z.string().min(1), status: z.enum(['moved', 'deleted', 'skipped', 'refused', 'failed']), reason: StorageReasonV1Schema.optional() })),
  inTrashBytes: bytes(), freedBytes: bytes(),
  /** Exact entries still in Trash at settlement; freedBytes already includes immediate emptyAfter effects. */
  trashEntryIds: z.array(z.string().min(1)).optional(),
}));
export type PileApplyResultV1 = z.infer<typeof PileApplyResultV1Schema>;
/** Retained presentation receipts drop additive fields; known correlation remains validated. */
export const PileApplyResultStoredV1Schema = createStoredReadSchema(PileApplyResultV1Schema);
export const TrashEntryV1Schema = lazyZodSchema(() => z.strictObject({
  entryId: z.string().min(1), batchId: z.string().min(1), volumeId: z.string().min(1), originalPath: z.string().min(1),
  title: z.string(), categoryId: HappierStorageCategoryIdV1Schema.optional(), size: StorageSizeV1Schema,
  movedAt: time(), movedBy: StorageActorV1Schema, emptiesAt: time().nullable(), restorable: z.boolean(), reason: StorageReasonV1Schema.optional(),
}));
export type TrashEntryV1 = z.infer<typeof TrashEntryV1Schema>;
export const TrashEntryStoredV1Schema = lazyZodSchema(() => TrashEntryV1Schema.extend({ movedBy: StorageActorV1Schema.strip() }).strip());

const checkedItem = () => z.strictObject({ ref: PileItemRefV1Schema, expect: z.string().min(1) });
export const MachineStoragePileGetInputV1Schema = MachineStorageSummaryGetInputV1Schema;
export type MachineStoragePileGetInputV1 = z.infer<typeof MachineStoragePileGetInputV1Schema>;
export const MachineStoragePileSetInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...target(), add: z.array(StorageItemRefV1Schema).optional(), remove: z.array(z.string().min(1)).optional(), clear: z.literal(true).optional(),
}));
export type MachineStoragePileSetInputV1 = z.infer<typeof MachineStoragePileSetInputV1Schema>;
export const MachineStoragePileResultV1Schema = lazyZodSchema(() => z.strictObject({
  revision: revision(), items: z.array(PileItemRefV1Schema), summary: PileSummaryV1Schema,
}));
export type MachineStoragePileResultV1 = z.infer<typeof MachineStoragePileResultV1Schema>;
export const MachineStorageItemsCheckInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), refs: z.array(StorageItemRefV1Schema) }));
export type MachineStorageItemsCheckInputV1 = z.infer<typeof MachineStorageItemsCheckInputV1Schema>;
export const MachineStorageTrashMoveInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...target(), items: z.array(checkedItem().extend({ claimedVerdict: StorageItemV1Schema.shape.verdict, reason: StorageReasonV1Schema.strict().optional() })).min(1),
  notIncluded: z.array(StorageItemV1Schema.extend({ size: StorageSizeV1Schema.strict(), reason: StorageReasonV1Schema.strict(), loses: z.array(StorageReasonV1Schema.strict()).optional() })).optional(),
  goalBytes: bytes().optional(), emptyAfter: z.boolean().optional(),
  retry: z.strictObject({ sessionId: z.string().min(1) }).optional(),
}));
export type MachineStorageTrashMoveInputV1 = z.infer<typeof MachineStorageTrashMoveInputV1Schema>;
export const MachineStorageDeleteNowInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), items: z.array(checkedItem()).min(1) }));
export type MachineStorageDeleteNowInputV1 = z.infer<typeof MachineStorageDeleteNowInputV1Schema>;
export const MachineStorageTrashEmptyInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...target(), volume: z.string().min(1).optional(), entryIds: z.array(z.string().min(1)).min(1).optional(), batchId: z.string().min(1).optional(),
}));
export type MachineStorageTrashEmptyInputV1 = z.infer<typeof MachineStorageTrashEmptyInputV1Schema>;
export const MachineStorageTrashRestoreInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...target(), entryIds: z.array(z.string().min(1)).min(1).optional(), batchId: z.string().min(1).optional(), beside: z.literal(true).optional(),
}).refine(value => value.entryIds !== undefined || value.batchId !== undefined, { message: 'restore_selection_required' }));
export type MachineStorageTrashRestoreInputV1 = z.infer<typeof MachineStorageTrashRestoreInputV1Schema>;
export const TrashRestoreResultV1Schema = lazyZodSchema(() => z.strictObject({
  outcomes: z.array(z.strictObject({ entryId: z.string().min(1), status: z.enum(['restored', 'refused', 'failed']), path: z.string().min(1).optional(), reason: StorageReasonV1Schema.optional() })),
}));
export type TrashRestoreResultV1 = z.infer<typeof TrashRestoreResultV1Schema>;
export const TrashEmptyResultV1Schema = lazyZodSchema(() => z.strictObject({
  outcomes: z.array(z.strictObject({ entryId: z.string().min(1), status: z.enum(['deleted', 'refused', 'failed']), reason: StorageReasonV1Schema.optional() })), freedBytes: bytes(),
}));
export type TrashEmptyResultV1 = z.infer<typeof TrashEmptyResultV1Schema>;
export const MachineStorageWorktreesListInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...target(), projectId: z.string().min(1).optional(), filter: StorageItemV1Schema.shape.verdict.optional(),
}));
export type MachineStorageWorktreesListInputV1 = z.infer<typeof MachineStorageWorktreesListInputV1Schema>;
export const MachineStorageSuggestionsListInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...target(), group: z.enum(['can-be-rebuilt', 'old-and-unused', 'outside-happier']).optional(), quickestForVolume: z.string().min(1).optional(),
}));
export type MachineStorageSuggestionsListInputV1 = z.infer<typeof MachineStorageSuggestionsListInputV1Schema>;
export const MachineStorageItemsListResultV1Schema = lazyZodSchema(() => z.strictObject({
  revision: revision(), items: z.array(StorageItemV1Schema), nextCursor: z.string().min(1).optional(), declinedCount: z.number().int().nonnegative().optional(),
}));
export type MachineStorageItemsListResultV1 = z.infer<typeof MachineStorageItemsListResultV1Schema>;
export const MachineStorageSuggestionsDeclineInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), items: z.array(checkedItem()).min(1) }));
export type MachineStorageSuggestionsDeclineInputV1 = z.infer<typeof MachineStorageSuggestionsDeclineInputV1Schema>;
export const MachineStorageSuggestionsDeclineResultV1Schema = lazyZodSchema(() => z.strictObject({ revision: revision(), declinedCount: z.number().int().nonnegative() }));
export type MachineStorageSuggestionsDeclineResultV1 = z.infer<typeof MachineStorageSuggestionsDeclineResultV1Schema>;

// Persisted policy and every nested write object are closed. The resources-policy
// owner derives its tolerant stored reader; this schema never admits loose writes.
export const MachineStoragePolicyV1Schema = lazyZodSchema(() => z.strictObject({
  wholeDiskEnabled: z.boolean().default(false),
  protectedFolders: z.array(z.strictObject({ path: z.string().min(1), addedAt: time() })).default(() => []),
  logRetentionDays: z.number().int().min(1).nullable().default(30),
  trashEmptyAfterDays: z.number().int().min(1).nullable().default(7),
  scheduledScan: z.strictObject({
    // Machine-local calendar day (Sunday = 0) and the lab's 24-hour HH:mm time.
    weekday: z.number().int().min(0).max(6),
    time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    onlyOnPower: z.literal(true),
  }).nullable().default(null),
  suggestUnusedAfterDays: z.number().int().min(1).default(30),
}));
export type MachineStoragePolicyV1 = z.infer<typeof MachineStoragePolicyV1Schema>;
export const MachineStoragePolicyPatchV1Schema = lazyZodSchema(() => z.strictObject({
  wholeDiskEnabled: MachineStoragePolicyV1Schema.shape.wholeDiskEnabled.removeDefault().optional(),
  protectedFolders: MachineStoragePolicyV1Schema.shape.protectedFolders.removeDefault().optional(),
  logRetentionDays: MachineStoragePolicyV1Schema.shape.logRetentionDays.removeDefault().optional(),
  trashEmptyAfterDays: MachineStoragePolicyV1Schema.shape.trashEmptyAfterDays.removeDefault().optional(),
  scheduledScan: MachineStoragePolicyV1Schema.shape.scheduledScan.removeDefault().optional(),
  suggestUnusedAfterDays: MachineStoragePolicyV1Schema.shape.suggestUnusedAfterDays.removeDefault().optional(),
}));
export type MachineStoragePolicyPatchV1 = z.infer<typeof MachineStoragePolicyPatchV1Schema>;
