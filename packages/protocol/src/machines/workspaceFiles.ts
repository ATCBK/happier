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
