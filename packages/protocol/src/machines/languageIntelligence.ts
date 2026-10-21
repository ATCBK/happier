import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { WorkspaceFileEditSetFileSchema, WorkspaceFileEditPositionSchema, WorkspaceFileEditRangeSchema, DaemonWorkspaceFileReplaceApplyResponseSchema } from './workspaceFiles.js';
import { PluginJsonValueV2Schema } from '../plugins/contributions/publicTypes.js';

const nonempty = () => z.string().check(z.minLength(1));
const revision = () => z.number().check(z.int(), z.nonnegative());
const hash = () => z.string().check(z.regex(/^[a-f0-9]{64}$/u));

/** Native records drop __proto__; workspace paths must retain that valid name. */
function ownStringRecord<Value>(key: z.ZodMiniType<string, string>, value: z.ZodMiniType<Value>) {
  const entries = z.pipe(z.custom<Record<string, unknown>>(z.core.util.isPlainObject),
    z.transform((input) => new Map(Object.entries(input))));
  const schema = z.pipe(z.pipe(entries, z.map(key, value)), z.transform((items) => Object.fromEntries(items)));
  // The wire remains an ordinary object dictionary. Derive its projection
  // from the same native key/value schemas without executing the lossy parser.
  const projection = z.record(key, value);
  schema._zod.processJSONSchema = (_context, jsonSchema) => {
    Object.assign(jsonSchema, Object.fromEntries(Object.entries(z.toJSONSchema(projection))
      .filter(([keyword]) => keyword !== '$schema')));
  };
  return schema;
}

/** Machine wire paths are normalized workspace-relative paths, never LSP URIs. */
export const LanguageIntelligencePathSchema = lazyZodSchema(() => nonempty().check(z.refine((value) =>
  !value.includes('\0') && !value.includes('\\') && !value.startsWith('/') && !/^[a-z]:/iu.test(value)
  && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'), 'Expected a workspace-relative path')));

export const LanguageIntelligencePositionSchema = WorkspaceFileEditPositionSchema;
export type LanguageIntelligencePosition = z.infer<typeof LanguageIntelligencePositionSchema>;
export const LanguageIntelligenceRangeSchema = WorkspaceFileEditRangeSchema;
export type LanguageIntelligenceRange = z.infer<typeof LanguageIntelligenceRangeSchema>;

export const LanguageIntelligenceCapabilitiesSchema = lazyZodSchema(() => z.strictObject({
  hover: z.boolean(), definition: z.boolean(), references: z.boolean(), documentSymbol: z.boolean(),
  diagnostics: z.enum(['pull', 'push', 'none']), acceptsExternalChanges: z.boolean(),
  rename: z.optional(z.boolean()), prepareRename: z.optional(z.boolean()), fileRename: z.optional(z.boolean()), codeAction: z.optional(z.boolean()),
}));
export type LanguageIntelligenceCapabilities = z.infer<typeof LanguageIntelligenceCapabilitiesSchema>;

export const LanguageIntelligenceUnavailableReasonSchema = lazyZodSchema(() => z.enum([
  'no_capable_server', 'server_missing', 'start_failed', 'unsupported_root', 'session_unavailable', 'crashed',
  'method_unavailable', 'update_required', 'transport_failed', 'invalid_response',
]));
export type LanguageIntelligenceUnavailableReason = z.infer<typeof LanguageIntelligenceUnavailableReasonSchema>;
export const LanguageIntelligenceServerStatusSchema = lazyZodSchema(() => z.strictObject({
  serverId: nonempty(), label: nonempty(), state: z.enum(['idle', 'starting', 'ready', 'restarting', 'stopped', 'crashed', 'unavailable']),
  loading: z.boolean(), generation: nonempty(), reason: z.optional(LanguageIntelligenceUnavailableReasonSchema),
  installable: z.optional(z.strictObject({ pluginId: nonempty(), dependencyId: nonempty() })),
  stderrPreview: z.optional(z.string()),
}));
export type LanguageIntelligenceServerStatus = z.infer<typeof LanguageIntelligenceServerStatusSchema>;
export type LanguageIntelligenceServerState = LanguageIntelligenceServerStatus['state'];

export const LanguageIntelligenceDiagnosticSchema = lazyZodSchema(() => z.strictObject({
  serverId: nonempty(), path: LanguageIntelligencePathSchema, range: LanguageIntelligenceRangeSchema,
  severity: z.enum(['error', 'warning', 'information', 'hint']), message: z.string(),
  code: z.optional(z.union([z.string(), z.number()])), source: z.optional(z.string()),
}));
export type LanguageIntelligenceDiagnostic = z.infer<typeof LanguageIntelligenceDiagnosticSchema>;

export type LanguageIntelligenceDocumentSymbol = {
  serverId: string; name: string; kind: number; range: LanguageIntelligenceRange; selectionRange: LanguageIntelligenceRange;
  children?: LanguageIntelligenceDocumentSymbol[];
};
export const LanguageIntelligenceDocumentSymbolSchema: z.ZodMiniType<LanguageIntelligenceDocumentSymbol> = z.lazy(() => z.strictObject({
  serverId: nonempty(), name: z.string(), kind: z.number().check(z.int(), z.positive()),
  range: LanguageIntelligenceRangeSchema, selectionRange: LanguageIntelligenceRangeSchema,
  children: z.optional(z.array(LanguageIntelligenceDocumentSymbolSchema)),
}));

const generalErrorCodes = [
  'session_unavailable', 'cancelled', 'document_out_of_sync', 'stale_query', 'request_failed', 'unsupported',
  'invalid_position', 'invalid_request', 'path_not_allowed', 'root_not_found',
] as const;
export const LanguageIntelligenceErrorCodeSchema = lazyZodSchema(() => z.enum([
  ...generalErrorCodes, 'unsaved_editor_changes', 'symbol_not_found',
]));
export type LanguageIntelligenceErrorCode = z.infer<typeof LanguageIntelligenceErrorCodeSchema>;
const failureSchema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('loading') }),
  z.strictObject({ status: z.literal('unavailable'), reason: LanguageIntelligenceUnavailableReasonSchema }),
  z.strictObject({ status: z.literal('error'), errorCode: z.enum(generalErrorCodes) }),
  z.strictObject({ status: z.literal('error'), errorCode: z.literal('unsaved_editor_changes'), diskHash: hash() }),
  z.strictObject({ status: z.literal('error'), errorCode: z.literal('symbol_not_found'), candidates: z.array(z.string()) }),
]));

export const LanguageIntelligenceEditSchema = lazyZodSchema(() => z.strictObject({
  startLine: revision(), startCharacter: revision(), endLine: revision(), endCharacter: revision(), text: z.string(),
}).check(z.refine((edit) => edit.endLine > edit.startLine || (edit.endLine === edit.startLine && edit.endCharacter >= edit.startCharacter), 'Edit ends before its start')));
export type LanguageIntelligenceEdit = z.infer<typeof LanguageIntelligenceEditSchema>;
export const DaemonLspSyncRequestSchema = lazyZodSchema(() => z.strictObject({
  rootPath: nonempty(), op: z.discriminatedUnion('op', [
    z.strictObject({ op: z.enum(['open', 'snapshot']), path: LanguageIntelligencePathSchema,
      languageId: nonempty(), version: revision(), text: z.string(), unsaved: z.boolean() }),
    z.strictObject({ op: z.literal('change'), path: LanguageIntelligencePathSchema, version: revision(), baseVersion: revision(),
      edit: LanguageIntelligenceEditSchema, unsaved: z.boolean() }),
    z.strictObject({ op: z.literal('close'), path: LanguageIntelligencePathSchema }),
    z.strictObject({ op: z.literal('external'), paths: z.array(LanguageIntelligencePathSchema) }),
  ]),
}));
export type DaemonLspSyncRequest = z.infer<typeof DaemonLspSyncRequestSchema>;
export const DaemonLspSyncResponseSchema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('ok'), generation: nonempty(), version: z.optional(revision()),
    servers: z.array(LanguageIntelligenceServerStatusSchema), capabilities: z.optional(LanguageIntelligenceCapabilitiesSchema) }),
  failureSchema,
]));
export type DaemonLspSyncResponse = z.infer<typeof DaemonLspSyncResponseSchema>;

export const LanguageIntelligenceQueryPositionSchema = lazyZodSchema(() => z.union([
  LanguageIntelligencePositionSchema,
  z.strictObject({ line: revision(), symbol: nonempty(), occurrence: z.optional(z.number().check(z.int(), z.positive())) }),
]));
export const DaemonLspQueryRequestSchema = lazyZodSchema(() => z.strictObject({
  rootPath: nonempty(), path: LanguageIntelligencePathSchema,
  kind: z.enum(['hover', 'definition', 'references', 'documentSymbols', 'diagnostics', 'prepareRename', 'rename', 'willRenameFiles', 'codeActions']),
  version: z.optional(revision()), generation: z.optional(nonempty()), position: z.optional(LanguageIntelligenceQueryPositionSchema),
  includeDeclaration: z.optional(z.boolean()), text: z.optional(z.enum(['held', 'disk'])),
  serverId: z.optional(nonempty()), languageId: z.optional(nonempty()),
  newName: z.optional(nonempty()), newPath: z.optional(LanguageIntelligencePathSchema), range: z.optional(LanguageIntelligenceRangeSchema),
}));
export type DaemonLspQueryRequest = z.infer<typeof DaemonLspQueryRequestSchema>;
const queryProvenance = { status: z.literal('ok'), fileHash: z.optional(hash()), version: z.optional(revision()), generation: z.optional(nonempty()) };
const definitionLocationSchema = lazyZodSchema(() => z.strictObject({
  serverId: nonempty(), path: nonempty(), outsideWorkspace: z.optional(z.boolean()), range: LanguageIntelligenceRangeSchema,
}).check(z.refine((value) => value.outsideWorkspace === true
  ? !value.path.includes('\0') && /^(?:\/|[a-z]:[\\/]|\\\\)/iu.test(value.path)
  : LanguageIntelligencePathSchema.safeParse(value.path).success, 'Definition target must match its workspace authority')));
export const LanguageIntelligenceCommandSchema = lazyZodSchema(() => z.strictObject({
  command: nonempty(), arguments: z.optional(z.array(PluginJsonValueV2Schema)),
}));
export const LanguageIntelligenceCodeActionSchema = lazyZodSchema(() => z.strictObject({
  serverId: nonempty(), title: nonempty(), kind: z.optional(z.string()),
  range: LanguageIntelligenceRangeSchema,
  files: z.array(WorkspaceFileEditSetFileSchema), hasCommand: z.boolean(),
  disabledReason: z.optional(z.string()),
}));
export type LanguageIntelligenceCodeAction = z.infer<typeof LanguageIntelligenceCodeActionSchema>;
export const DaemonLspQueryResponseSchema = lazyZodSchema(() => z.union([
  z.discriminatedUnion('kind', [
    z.strictObject({ ...queryProvenance, kind: z.literal('hover'), sections: z.array(z.strictObject({
      serverId: nonempty(), label: nonempty(), markdown: z.string(), range: z.optional(LanguageIntelligenceRangeSchema),
    })) }),
    z.strictObject({ ...queryProvenance, kind: z.literal('definition'), locations: z.array(definitionLocationSchema), hasMore: z.boolean() }),
    z.strictObject({ ...queryProvenance, kind: z.literal('references'), locations: z.array(z.strictObject({
      serverId: nonempty(), path: LanguageIntelligencePathSchema, range: LanguageIntelligenceRangeSchema, lineText: z.string(),
    })), hasMore: z.boolean() }),
    z.strictObject({ ...queryProvenance, kind: z.literal('documentSymbols'), symbols: z.array(LanguageIntelligenceDocumentSymbolSchema), hasMore: z.boolean() }),
    z.strictObject({ ...queryProvenance, kind: z.literal('diagnostics'), diagnostics: z.array(LanguageIntelligenceDiagnosticSchema), hasMore: z.boolean() }),
    z.strictObject({ ...queryProvenance, kind: z.literal('prepareRename'), targets: z.array(z.strictObject({
      serverId: nonempty(), range: z.optional(LanguageIntelligenceRangeSchema), placeholder: z.optional(z.string()),
    })) }),
    z.strictObject({ ...queryProvenance, kind: z.enum(['rename', 'willRenameFiles']), files: z.array(WorkspaceFileEditSetFileSchema) }),
    z.strictObject({ ...queryProvenance, kind: z.literal('codeActions'), actions: z.array(LanguageIntelligenceCodeActionSchema) }),
  ]), failureSchema,
]));
export type DaemonLspQueryResponse = z.infer<typeof DaemonLspQueryResponseSchema>;

/** Mutation envelopes are closed; preview queries never acquire write authority. */
export const LanguageIntelligenceCodeActionOperationSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('codeAction'), action: LanguageIntelligenceCodeActionSchema, expectedHash: hash(),
}));
export const DaemonLspApplyRequestSchema = lazyZodSchema(() => z.strictObject({
  rootPath: nonempty(), path: LanguageIntelligencePathSchema, languageId: z.optional(nonempty()),
  operation: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('rename'), files: z.array(WorkspaceFileEditSetFileSchema) }),
    z.strictObject({ kind: z.literal('fileRename'), files: z.array(WorkspaceFileEditSetFileSchema) }),
    LanguageIntelligenceCodeActionOperationSchema,
  ]),
}));
export type DaemonLspApplyRequest = z.infer<typeof DaemonLspApplyRequestSchema>;
export const DaemonLspApplyResponseSchema = lazyZodSchema(() => z.union([DaemonWorkspaceFileReplaceApplyResponseSchema, failureSchema]));
export type DaemonLspApplyResponse = z.infer<typeof DaemonLspApplyResponseSchema>;

export const LanguageIntelligenceDiagnosticsEntrySchema = lazyZodSchema(() => z.strictObject({
  state: z.enum(['ready', 'checking', 'unavailable']), version: revision(), generation: nonempty(),
  items: z.array(LanguageIntelligenceDiagnosticSchema),
}));
export type LanguageIntelligenceDiagnosticsEntry = z.infer<typeof LanguageIntelligenceDiagnosticsEntrySchema>;
export const DaemonLspWatchRequestSchema = lazyZodSchema(() => z.strictObject({ rootPath: nonempty(), sinceRevision: z.optional(revision()) }));
export type DaemonLspWatchRequest = z.infer<typeof DaemonLspWatchRequestSchema>;
export const DaemonLspWatchResponseSchema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('ok'), revision: revision(), servers: z.array(LanguageIntelligenceServerStatusSchema),
    diagnostics: ownStringRecord(LanguageIntelligencePathSchema, ownStringRecord(nonempty(), LanguageIntelligenceDiagnosticsEntrySchema)) }),
  failureSchema,
]));
export type DaemonLspWatchResponse = z.infer<typeof DaemonLspWatchResponseSchema>;
export const DaemonLspRestartRequestSchema = lazyZodSchema(() => z.strictObject({ rootPath: nonempty(), serverId: z.optional(nonempty()) }));
export type DaemonLspRestartRequest = z.infer<typeof DaemonLspRestartRequestSchema>;
export const DaemonLspRestartResponseSchema = lazyZodSchema(() => z.union([z.strictObject({ status: z.literal('ok') }), failureSchema]));
export type DaemonLspRestartResponse = z.infer<typeof DaemonLspRestartResponseSchema>;

export type LanguageIntelligenceSyncInput = DaemonLspSyncRequest;
export type LanguageIntelligenceSyncResult = DaemonLspSyncResponse;
export type LanguageIntelligenceQueryInput = DaemonLspQueryRequest;
export type LanguageIntelligenceQueryResult = DaemonLspQueryResponse;
export type LanguageIntelligenceWatchInput = DaemonLspWatchRequest;
export type LanguageIntelligenceWatchResult = DaemonLspWatchResponse;
export type LanguageIntelligenceRestartInput = DaemonLspRestartRequest;
export type LanguageIntelligenceRestartResult = DaemonLspRestartResponse;
