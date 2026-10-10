import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { TransferEndpointCandidateSchema } from '../machines/transfer/transferStream.js';
import { WorkspaceSyncEntryExpectationV1Schema } from '../sessions/control/handoff/workspaceSyncSchemas.js';

export const FILESYSTEM_MUTATION_ACTION_IDS = [
  'daemon.filesystem.createDirectory',
  'daemon.filesystem.rename',
  'daemon.filesystem.delete',
  'daemon.filesystem.copy',
] as const;
export const FILESYSTEM_ACTION_IDS = [
  'daemon.filesystem.readFile',
  'daemon.filesystem.writeFile',
  'daemon.filesystem.listDirectory',
  'daemon.filesystem.getDirectoryTree',
  ...FILESYSTEM_MUTATION_ACTION_IDS,
  'daemon.filesystem.upload',
  'daemon.filesystem.download',
  'daemon.filesystem.transfer.cancel',
] as const;
export const FILESYSTEM_TRANSFER_ACTION_IDS = [
  'daemon.filesystem.upload', 'daemon.filesystem.download', 'daemon.filesystem.transfer.cancel',
] as const;

export type FilesystemActionId = typeof FILESYSTEM_ACTION_IDS[number];
export type FilesystemMutationActionId = typeof FILESYSTEM_MUTATION_ACTION_IDS[number];
export type FilesystemTransferActionId = typeof FILESYSTEM_TRANSFER_ACTION_IDS[number];

export function isFilesystemActionId(value: string): value is FilesystemActionId {
  return (FILESYSTEM_ACTION_IDS as readonly string[]).includes(value);
}

const FilesystemFailureSchema = lazyZodSchema(() => z.object({
  success: z.literal(false), error: z.string(), errorCode: z.string().optional(),
}).strict());

export const FilesystemReadFileInputSchema = lazyZodSchema(() => z.object({
  rootPath: z.string().min(1), path: z.string().min(1),
}).strict());
export const FilesystemReadFileOutputSchema = lazyZodSchema(() => z.union([
  z.object({ success: z.literal(true), content: z.string() }).strict(),
  FilesystemFailureSchema,
]));
export const FilesystemWriteFileInputSchema = lazyZodSchema(() => z.object({
  rootPath: z.string().min(1), path: z.string().min(1), content: z.string(),
  expectedHash: z.string().nullable().optional(),
}).strict());
export const FilesystemWriteFileOutputSchema = lazyZodSchema(() => z.union([
  z.object({ success: z.literal(true), hash: z.string().min(1) }).strict(),
  FilesystemFailureSchema,
]));
export const FilesystemDirectoryEntrySchema = lazyZodSchema(() => z.object({
  name: z.string(), type: z.enum(['file', 'directory', 'other']), size: z.number().optional(),
  modified: z.number().optional(), gitIgnored: z.boolean().optional(),
}).strict());
export const FilesystemListDirectoryInputSchema = lazyZodSchema(() => z.object({
  rootPath: z.string().min(1), path: z.string().min(1), includeGitIgnore: z.boolean().optional(),
}).strict());
export const FilesystemListDirectoryOutputSchema = lazyZodSchema(() => z.union([
  z.object({ success: z.literal(true), entries: z.array(FilesystemDirectoryEntrySchema),
    truncated: z.boolean().optional(), gitIgnoreAvailable: z.boolean().optional() }).strict(),
  FilesystemFailureSchema,
]));
export type FilesystemTreeNode = Readonly<{
  name: string; path: string; type: 'file' | 'directory'; size?: number; modified?: number;
  children?: readonly FilesystemTreeNode[];
}>;
export const FilesystemTreeNodeSchema: z.ZodType<FilesystemTreeNode> = z.lazy(() => z.object({
  name: z.string(), path: z.string(), type: z.enum(['file', 'directory']), size: z.number().optional(),
  modified: z.number().optional(), children: z.array(FilesystemTreeNodeSchema).optional(),
}).strict());
export const FilesystemGetDirectoryTreeInputSchema = lazyZodSchema(() => z.object({
  rootPath: z.string().min(1), path: z.string().min(1), maxDepth: z.number().int().nonnegative(),
}).strict());
export const FilesystemGetDirectoryTreeOutputSchema = lazyZodSchema(() => z.union([
  z.object({ success: z.literal(true), tree: FilesystemTreeNodeSchema, truncated: z.boolean().optional() }).strict(),
  FilesystemFailureSchema,
]));

// These are public Action schemas: their classic carriers supply the existing
// author DTO/JSON-schema projections, constructed lazily at this public seam.
export const FilesystemCreateDirectoryInputSchema = lazyZodSchema(() => z.object({
  rootPath: z.string().min(1),
  path: z.string().min(1),
}).strict());
export const FilesystemRenameInputSchema = lazyZodSchema(() => z.object({
  rootPath: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  overwrite: z.boolean(),
}).strict());
export const FilesystemDeleteInputSchema = lazyZodSchema(() => z.object({
  rootPath: z.string().min(1),
  path: z.string().min(1),
  recursive: z.boolean(),
}).strict());
export const FilesystemLocalCopyInputSchema = lazyZodSchema(() => z.object({
  rootPath: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  overwrite: z.boolean(),
  recursive: z.boolean(),
}).strict());
export const FilesystemEntryTreeDescriptorSchema = lazyZodSchema(() => z.object({
  operationId: z.string().min(1),
  expectation: WorkspaceSyncEntryExpectationV1Schema,
  blobs: z.array(z.object({ transferId: z.string().min(1), sizeBytes: z.number().int().nonnegative(),
    manifestHash: z.string().regex(/^sha256:[a-f0-9]{64}$/i) }).strict()),
}).strict());
const FilesystemPreparedCopyFileSourceSchema = lazyZodSchema(() => z.object({
    kind: z.literal('file'),
    serverId: z.string().min(1), machineId: z.string().min(1),
    rootPath: z.string().min(1), path: z.string().min(1),
    sourceId: z.string().min(1), sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
}).strict());
const FilesystemPreparedCopyEntrySourceSchema = lazyZodSchema(() => FilesystemPreparedCopyFileSourceSchema
  .omit({ kind: true }).extend({ kind: z.literal('entry_tree'), entryTree: FilesystemEntryTreeDescriptorSchema }).strict());
export const FilesystemPreparedCopyInputSchema = lazyZodSchema(() => z.object({
  kind: z.literal('prepared_transfer'),
  source: z.union([FilesystemPreparedCopyFileSourceSchema, FilesystemPreparedCopyEntrySourceSchema]),
  destination: z.object({
    serverId: z.string().min(1), machineId: z.string().min(1),
    rootPath: z.string().min(1), path: z.string().min(1),
  }).strict(),
  overwrite: z.boolean(), recursive: z.boolean(),
}).strict());
export const FilesystemTargetCopyInputSchema = lazyZodSchema(() => z.object({
  kind: z.literal('target_copy'),
  source: z.object({
    serverId: z.string().min(1), machineId: z.string().min(1),
    rootPath: z.string().min(1), path: z.string().min(1),
  }).strict(),
  destination: z.object({
    serverId: z.string().min(1), machineId: z.string().min(1),
    rootPath: z.string().min(1), path: z.string().min(1),
  }).strict(),
  overwrite: z.boolean(), recursive: z.boolean(),
}).strict());
export const FilesystemCopyInputSchema = lazyZodSchema(() => z.union([
  FilesystemLocalCopyInputSchema, FilesystemPreparedCopyInputSchema, FilesystemTargetCopyInputSchema,
]));
export const FilesystemMutationOutputSchema = lazyZodSchema(() => z.union([
  z.object({ success: z.literal(true) }).strict(),
  FilesystemFailureSchema,
]));

export type FilesystemCreateDirectoryInput = z.infer<typeof FilesystemCreateDirectoryInputSchema>;
export type FilesystemRenameInput = z.infer<typeof FilesystemRenameInputSchema>;
export type FilesystemDeleteInput = z.infer<typeof FilesystemDeleteInputSchema>;
export type FilesystemCopyInput = z.infer<typeof FilesystemCopyInputSchema>;
export type FilesystemLocalCopyInput = z.infer<typeof FilesystemLocalCopyInputSchema>;
export type FilesystemPreparedCopyInput = z.infer<typeof FilesystemPreparedCopyInputSchema>;
export type FilesystemTargetCopyInput = z.infer<typeof FilesystemTargetCopyInputSchema>;
export type FilesystemMutationOutput = z.infer<typeof FilesystemMutationOutputSchema>;

export const FilesystemUploadInputSchema = lazyZodSchema(() => z.object({
  rootPath: z.string().min(1),
  path: z.string().min(1),
  source: z.object({ sourceId: z.string().min(1), sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional() }).strict(),
  overwrite: z.boolean(),
}).strict());
export const FilesystemDownloadInputSchema = lazyZodSchema(() => z.object({
  rootPath: z.string().min(1),
  path: z.string().min(1),
  destination: z.object({ destinationId: z.string().min(1) }).strict(),
  asZip: z.boolean(),
  format: z.literal('entry_tree').optional(),
}).strict().refine(input => !input.format || !input.asZip, { message: 'Entry-tree export cannot also be a ZIP export' }));
export const FilesystemTransferCancelInputSchema = lazyZodSchema(() => z.object({
  rootPath: z.string().min(1), direction: z.enum(['upload', 'download']), transferId: z.string().min(1),
}).strict());

const PreparedFilesystemEndpointSchema = lazyZodSchema(() => TransferEndpointCandidateSchema.and(z.object({
  kind: z.enum(['http', 'https']), url: z.string(), authorizationToken: z.string().optional(),
  expiresAt: z.number().int().nonnegative(),
}).strict()));
const FilesystemTransferFailureSchema = lazyZodSchema(() => z.object({
  success: z.literal(false), status: z.enum(['failed', 'cancelled', 'unknown']),
  error: z.string(), errorCode: z.string().optional(),
}).strict());
export const FilesystemPreparedImportSchema = lazyZodSchema(() => z.object({
  uploadId: z.string().min(1), destDisplayPath: z.string().min(1), expectedSizeBytes: z.number().int().nonnegative(),
  chunkSizeBytes: z.number().int().positive(), recipientPublicKeyBase64: z.string().min(1),
  expiresAt: z.number().int().positive(), endpointCandidates: z.array(PreparedFilesystemEndpointSchema),
}).strict());
export const FilesystemPreparedExportSchema = lazyZodSchema(() => z.object({
  transferId: z.string().min(1), name: z.string().min(1), sizeBytes: z.number().int().nonnegative(),
  manifestHash: z.string().regex(/^sha256:[a-f0-9]{64}$/i), expiresAt: z.number().int().positive(),
  endpointCandidates: z.array(PreparedFilesystemEndpointSchema),
}).strict());
export const FilesystemUploadOutputSchema = lazyZodSchema(() => z.union([
  z.object({ success: z.literal(true), status: z.literal('accepted'), operationId: z.string().min(1),
    sourceId: z.string().min(1), prepared: FilesystemPreparedImportSchema }).strict(),
  z.object({ success: z.literal(true), status: z.literal('completed'), transferId: z.string().min(1),
    sourceId: z.string().min(1), path: z.string().min(1), sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i) }).strict(),
  FilesystemTransferFailureSchema,
]));
export const FilesystemDownloadOutputSchema = lazyZodSchema(() => z.union([
  z.object({ success: z.literal(true), status: z.literal('accepted'), operationId: z.string().min(1),
    destinationId: z.string().min(1), prepared: FilesystemPreparedExportSchema, entryTree: FilesystemEntryTreeDescriptorSchema }).strict(),
  z.object({ success: z.literal(true), status: z.literal('accepted'), operationId: z.string().min(1),
    destinationId: z.string().min(1), prepared: FilesystemPreparedExportSchema }).strict(),
  z.object({ success: z.literal(true), status: z.literal('completed'), transferId: z.string().min(1),
    destinationId: z.string().min(1), name: z.string().min(1), sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i) }).strict(),
  FilesystemTransferFailureSchema,
]));
export const FilesystemTransferCancelOutputSchema = lazyZodSchema(() => z.union([
  z.object({ success: z.literal(true), aborted: z.boolean() }).strict(),
  z.object({ success: z.literal(false), error: z.string(), errorCode: z.string().optional() }).strict(),
]));
export type FilesystemUploadInput = z.infer<typeof FilesystemUploadInputSchema>;
export type FilesystemUploadOutput = z.infer<typeof FilesystemUploadOutputSchema>;
export type FilesystemDownloadInput = z.infer<typeof FilesystemDownloadInputSchema>;
export type FilesystemDownloadOutput = z.infer<typeof FilesystemDownloadOutputSchema>;
export type FilesystemTransferCancelInput = z.infer<typeof FilesystemTransferCancelInputSchema>;
export type FilesystemTransferCancelOutput = z.infer<typeof FilesystemTransferCancelOutputSchema>;
export const FilesystemCopyOutputSchema = lazyZodSchema(() => z.union([
  FilesystemMutationOutputSchema, FilesystemUploadOutputSchema,
  z.object({ success: z.literal(true), status: z.literal('accepted'), operationId: z.string().min(1), sourceId: z.string().min(1),
    prepared: z.object({ manifest: FilesystemPreparedImportSchema,
      blobs: z.array(z.object({ transferId: z.string().min(1), prepared: FilesystemPreparedImportSchema }).strict()) }).strict() }).strict(),
  z.object({ success: z.literal(true), status: z.literal('completed'), sourceId: z.string().min(1),
    path: z.string().min(1), expectation: WorkspaceSyncEntryExpectationV1Schema }).strict(),
]));
export type FilesystemCopyOutput = z.infer<typeof FilesystemCopyOutputSchema>;
export type FilesystemEntryTreeDescriptor = z.infer<typeof FilesystemEntryTreeDescriptorSchema>;
