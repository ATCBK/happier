import { maxCodeUnits } from '../strings/maxCodeUnits.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_RAW_PAYLOAD_BYTES } from '../features/payload/capabilities/machineTunnelCapabilities.js';

/** Matches the existing workspace corpus ceiling used by repository-tree/file-search consumers. */
export const WORKSPACE_FILE_LIST_MAX_RESULTS = 5_000;
/** Keeps one typed response inside the canonical server-routed Machine RPC raw-payload ceiling. */
export const WORKSPACE_FILE_LIST_MAX_RESPONSE_UTF8_BYTES = DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_RAW_PAYLOAD_BYTES;
export const WORKSPACE_FILE_LIST_MAX_QUERY_CODE_UNITS = 1_024;

export const DaemonWorkspaceFileListRequestSchema = lazyZodSchema(() => z.strictObject({
  rootPath: z.string().check(z.trim(), z.minLength(1), z.maxLength(10_000)),
  query: z.optional(z.string().check(maxCodeUnits(WORKSPACE_FILE_LIST_MAX_QUERY_CODE_UNITS))),
  includeHidden: z.optional(z.boolean()),
  limit: z.optional(z.number().check(z.int(), z.positive(), z.maximum(WORKSPACE_FILE_LIST_MAX_RESULTS))),
  /** Remaining caller operation budget at dispatch; expiry returns an incomplete page. */
  budgetMs: z.optional(z.number().check(z.int(), z.nonnegative(), z.int())),
}));
export type DaemonWorkspaceFileListRequest = z.infer<typeof DaemonWorkspaceFileListRequestSchema>;

export const DaemonWorkspaceFileListErrorCodeSchema = lazyZodSchema(() => z.enum([
  'invalid_request',
  'path_not_allowed',
  'root_not_found',
  'method_unavailable',
  'ripgrep_unavailable',
  'ripgrep_failed',
]));
export type DaemonWorkspaceFileListErrorCode = z.infer<typeof DaemonWorkspaceFileListErrorCodeSchema>;

const DaemonWorkspaceFileListSuccessSchema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true),
  paths: z.array(z.string().check(z.minLength(1))).check(z.maxLength(WORKSPACE_FILE_LIST_MAX_RESULTS)),
  truncated: z.boolean(),
}).check(z.superRefine((value, context) => {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > WORKSPACE_FILE_LIST_MAX_RESPONSE_UTF8_BYTES) {
    context.addIssue({
      code: "custom",
      message: `Workspace file-list response exceeds ${WORKSPACE_FILE_LIST_MAX_RESPONSE_UTF8_BYTES} UTF-8 bytes`,
    });
  }
})));

const DaemonWorkspaceFileListFailureSchema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(false),
  errorCode: DaemonWorkspaceFileListErrorCodeSchema,
  exitCode: z.optional(z.number().check(z.int())),
}));

export const DaemonWorkspaceFileListResponseSchema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  DaemonWorkspaceFileListSuccessSchema,
  DaemonWorkspaceFileListFailureSchema,
]));
export type DaemonWorkspaceFileListResponse = z.infer<typeof DaemonWorkspaceFileListResponseSchema>;

export const WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES = DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_RAW_PAYLOAD_BYTES;

export const DaemonWorkspaceFileSearchRequestSchema = lazyZodSchema(() => z.strictObject({
  rootPath: z.string().check(z.trim(), z.minLength(1), z.maxLength(10_000)),
  query: z.string().check(z.minLength(1)),
  matchCase: z.optional(z.boolean()),
  regex: z.optional(z.boolean()),
  includeHidden: z.optional(z.boolean()),
  contextLines: z.optional(z.number().check(z.int(), z.minimum(0), z.maximum(2))),
}));
export type DaemonWorkspaceFileSearchRequest = z.infer<typeof DaemonWorkspaceFileSearchRequestSchema>;

export const WorkspaceFileSearchMatchV1Schema = lazyZodSchema(() => z.strictObject({
  line: z.number().check(z.int(), z.positive()),
  /** One-based UTF-16 column, compatible with editor and file-anchor positions. */
  column16: z.number().check(z.int(), z.positive()),
  length16: z.number().check(z.int(), z.nonnegative()),
  text: z.string(),
  before: z.array(z.string()).check(z.maxLength(2)),
  after: z.array(z.string()).check(z.maxLength(2)),
}));
export const WorkspaceFileSearchFileV1Schema = lazyZodSchema(() => z.strictObject({
  path: z.string().check(z.minLength(1)),
  matches: z.array(WorkspaceFileSearchMatchV1Schema),
}));
export const DaemonWorkspaceFileSearchErrorCodeSchema = lazyZodSchema(() => z.enum([
  'invalid_pattern', 'root_not_allowed', 'root_not_found', 'ripgrep_unavailable', 'ripgrep_failed',
]));
export const DaemonWorkspaceFileSearchResponseSchema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    files: z.array(WorkspaceFileSearchFileV1Schema),
    hasMore: z.boolean(),
    coverage: z.enum(['complete', 'partial']),
  }),
  z.strictObject({ ok: z.literal(false), code: DaemonWorkspaceFileSearchErrorCodeSchema, message: z.optional(z.string()) }),
]).check(z.superRefine((value, context) => {
  if (value.ok && new TextEncoder().encode(JSON.stringify(value)).byteLength > WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES) {
    context.addIssue({ code: "custom", message: 'Workspace content-search response exceeds the machine transport ceiling' });
  }
  if (value.ok && value.hasMore && value.coverage === 'complete') {
    context.addIssue({ code: "custom", message: 'An early-stopped search has partial coverage' });
  }
})));
export type DaemonWorkspaceFileSearchResponse = z.infer<typeof DaemonWorkspaceFileSearchResponseSchema>;
export type WorkspaceFileSearchFileV1 = z.infer<typeof WorkspaceFileSearchFileV1Schema>;

export const WorkspaceFileReplaceMatcherSchema = lazyZodSchema(() => z.strictObject({
  query: z.string().check(z.minLength(1), z.regex(/^[^\r\n]*$/u)),
  replacement: z.string().check(z.regex(/^[^\r\n]*$/u)),
  matchCase: z.optional(z.boolean()),
  regex: z.optional(z.boolean()),
}));
export const WorkspaceFileReplacePositionSchema = lazyZodSchema(() => z.strictObject({
  line: z.number().check(z.int(), z.positive()),
  column16: z.number().check(z.int(), z.positive()),
}));
export const WorkspaceFileReplaceInverseEditSchema = lazyZodSchema(() => z.strictObject({
  startUtf16: z.number().check(z.int(), z.nonnegative()),
  deleteLength: z.number().check(z.int(), z.nonnegative()),
  insertText: z.string(),
  originalText: z.string(),
}));
export const WorkspaceFileReplaceSelectionSchema = lazyZodSchema(() => z.strictObject({
  path: z.string().check(z.minLength(1)),
  expectedHash: z.string().check(z.regex(/^[a-f0-9]{64}$/u)),
  excludedMatches: z.optional(z.array(WorkspaceFileReplacePositionSchema)),
}));
export const WorkspaceFileReplaceCursorSchema = lazyZodSchema(() => z.strictObject({
  path: z.string().check(z.minLength(1)),
}));
export const DaemonWorkspaceFileReplacePreviewRequestSchema = lazyZodSchema(() => z.strictObject({
  ...WorkspaceFileReplaceMatcherSchema.shape,
  rootPath: z.string().check(z.trim(), z.minLength(1)),
  includeHidden: z.optional(z.boolean()),
  contextLines: z.optional(z.number().check(z.int(), z.minimum(0), z.maximum(2))),
  cursor: z.optional(WorkspaceFileReplaceCursorSchema),
}));
export const DaemonWorkspaceFileReplacePreviewResponseSchema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    files: z.array(z.strictObject({
      path: z.string(), hash: z.string(), matchCount: z.number().check(z.int(), z.nonnegative()),
      matches: z.array(z.strictObject({ ...WorkspaceFileSearchMatchV1Schema.shape, replacedText: z.string() })),
    })),
    skipped: z.strictObject({ notText: z.number().check(z.int(), z.nonnegative()) }),
    hasMore: z.boolean(), coverage: z.enum(['complete', 'partial']),
    cursor: z.optional(WorkspaceFileReplaceCursorSchema),
  }),
  z.strictObject({ ok: z.literal(false), code: DaemonWorkspaceFileSearchErrorCodeSchema, message: z.optional(z.string()) }),
]).check(z.superRefine((value, context) => {
  if (value.ok && new TextEncoder().encode(JSON.stringify(value)).byteLength > WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES) {
    context.addIssue({ code: 'custom', message: 'Replace preview exceeds the machine transport ceiling' });
  }
  if (value.ok && value.hasMore !== Boolean(value.cursor)) {
    context.addIssue({ code: 'custom', message: 'Replace preview continuation must accompany hasMore' });
  }
  if (value.ok && value.hasMore && value.coverage === 'complete') {
    context.addIssue({ code: 'custom', message: 'A paged replace preview has partial coverage' });
  }
})));
export const DaemonWorkspaceFileReplaceApplyRequestSchema = lazyZodSchema(() => z.strictObject({
  rootPath: z.string().check(z.trim(), z.minLength(1)),
  operation: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('replace'), matcher: WorkspaceFileReplaceMatcherSchema, files: z.array(WorkspaceFileReplaceSelectionSchema) }),
    z.strictObject({ kind: z.literal('restore'), files: z.array(z.strictObject({
      path: z.string().check(z.minLength(1)), expectedHash: z.string().check(z.regex(/^[a-f0-9]{64}$/u)),
      edits: z.array(WorkspaceFileReplaceInverseEditSchema),
    })) }),
  ]),
}));
export const DaemonWorkspaceFileReplaceApplyResponseSchema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), results: z.array(z.strictObject({
    path: z.string(), status: z.enum(['replaced', 'restored', 'changed', 'skipped', 'failed']),
    hash: z.optional(z.string()), matchCount: z.optional(z.number().check(z.int(), z.nonnegative())),
    edits: z.optional(z.array(WorkspaceFileReplaceInverseEditSchema)), reason: z.optional(z.string()),
  })), cancelled: z.optional(z.array(z.string())) }),
  z.strictObject({ ok: z.literal(false), code: z.enum(['invalid_request', 'invalid_pattern', 'root_not_allowed']) }),
]));
export type DaemonWorkspaceFileReplacePreviewRequest = z.infer<typeof DaemonWorkspaceFileReplacePreviewRequestSchema>;
export type DaemonWorkspaceFileReplacePreviewResponse = z.infer<typeof DaemonWorkspaceFileReplacePreviewResponseSchema>;
export type DaemonWorkspaceFileReplaceApplyRequest = z.infer<typeof DaemonWorkspaceFileReplaceApplyRequestSchema>;
export type DaemonWorkspaceFileReplaceApplyResponse = z.infer<typeof DaemonWorkspaceFileReplaceApplyResponseSchema>;
