import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { CodeIntelligenceFallbackResultSchema, isCodeIdentifier } from '../machines/codeIntelligenceFallback.js';
import { DaemonLspQueryRequestSchema, DaemonLspQueryResponseSchema, DaemonLspRestartRequestSchema, DaemonLspRestartResponseSchema, DaemonLspApplyRequestSchema, DaemonLspApplyResponseSchema, LanguageIntelligenceCodeActionOperationSchema } from '../machines/languageIntelligence.js';
import { WorkspaceFileEditSetFileSchema } from '../machines/workspaceFiles.js';
import { RPC_METHODS } from '../rpc/methods.js';
import type { ActionSpecSurfaceBindings, PreNormalizedActionSpec } from './actionSpecs.js';

export const CODE_INTELLIGENCE_ACTION_IDS = ['code.hover.get', 'code.definition.get', 'code.references.list', 'code.symbols.list', 'code.diagnostics.list', 'code.restart',
  'code.rename.preview', 'code.rename.apply', 'code.file.rename.preview', 'code.file.rename.apply', 'code.codeActions.list', 'code.codeAction.apply'] as const;
const machineId = z.string().check(z.trim(), z.minLength(1));
export const CodeIntelligenceFileActionInputSchema = lazyZodSchema(() => z.strictObject({
  machineId,
  rootPath: DaemonLspQueryRequestSchema.shape.rootPath,
  path: DaemonLspQueryRequestSchema.shape.path,
  languageId: z.optional(z.string().check(z.minLength(1))),
}));
export const CodeIntelligenceActionInputSchema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.trim(), z.minLength(1)),
  rootPath: DaemonLspQueryRequestSchema.shape.rootPath,
  path: DaemonLspQueryRequestSchema.shape.path,
  line: z.number().check(z.int(), z.positive()),
  symbol: z.optional(z.string().check(z.refine(isCodeIdentifier))),
  occurrence: z.optional(z.number().check(z.int(), z.positive())),
  character: z.optional(z.number().check(z.int(), z.nonnegative())),
  languageId: z.optional(z.string().check(z.minLength(1))),
}));
export const CodeIntelligenceRestartActionInputSchema = lazyZodSchema(() => z.strictObject({ machineId, ...DaemonLspRestartRequestSchema.shape }));
export const CodeIntelligenceRenamePreviewInputSchema = lazyZodSchema(() => z.strictObject({
  ...CodeIntelligenceActionInputSchema.shape, newName: z.optional(z.string().check(z.minLength(1))),
}));
export const CodeIntelligenceFileRenamePreviewInputSchema = lazyZodSchema(() => z.strictObject({
  ...CodeIntelligenceFileActionInputSchema.shape, newPath: DaemonLspQueryRequestSchema.shape.path,
}));
export const CodeIntelligenceEditApplyInputSchema = lazyZodSchema(() => z.strictObject({
  ...CodeIntelligenceFileActionInputSchema.shape, files: z.array(WorkspaceFileEditSetFileSchema),
}));
export const CodeIntelligenceCodeActionApplyInputSchema = lazyZodSchema(() => z.strictObject({
  ...CodeIntelligenceFileActionInputSchema.shape, operation: LanguageIntelligenceCodeActionOperationSchema,
}));
function queryOutput(kind: 'hover' | 'definition' | 'references' | 'documentSymbols' | 'diagnostics') {
  const semantic = DaemonLspQueryResponseSchema.check(z.superRefine((value, context) => {
    if (value.status === 'ok' && (value.kind !== kind || !value.fileHash)) {
      context.addIssue({ code: 'custom', message: 'An Action answer must match its query and include the disk content hash' });
    }
  }));
  return kind === 'definition' || kind === 'references' ? z.union([semantic, CodeIntelligenceFallbackResultSchema]) : semantic;
}
function semanticPreviewOutput(kinds: readonly string[]) {
  return DaemonLspQueryResponseSchema.check(z.superRefine((value, context) => {
    if (value.status === 'ok' && (!kinds.includes(value.kind) || !value.fileHash))
      context.addIssue({ code: 'custom', message: 'A semantic preview must include its disk hash and match the requested operation' });
  }));
}
function mutationRpcBinding(kind: 'rename' | 'fileRename' | 'codeAction'): NonNullable<ActionSpecSurfaceBindings['rpc']> {
  return {
    inputSchema: lazyZodSchema(() => DaemonLspApplyRequestSchema.check(z.refine(request => request.operation.kind === kind))),
    outputSchema: DaemonLspApplyResponseSchema,
    decodeInput(value, context) {
      const request = DaemonLspApplyRequestSchema.parse(value), target = context.externalActionTarget;
      if (target?.kind !== 'machine') throw new Error('An exact Machine target is required');
      return request.operation.kind === 'codeAction' ? { machineId: target.machineId, ...request }
        : { machineId: target.machineId, rootPath: request.rootPath, path: request.path,
          ...(request.languageId ? { languageId: request.languageId } : {}), files: request.operation.files };
    },
    encodeOutput: value => value,
  };
}
const shared = {
  approval: { result: 'required' }, safety: 'safe', sideEffectClass: 'read', placements: [],
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
  inputSchema: CodeIntelligenceActionInputSchema,
  inputHints: { fields: [
    { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
    { path: 'rootPath', title: 'Workspace root', widget: 'text', required: true },
    { path: 'path', title: 'Current file', widget: 'text', required: true },
    { path: 'line', title: 'Line (one-based)', widget: 'text', required: true },
    { path: 'symbol', title: 'Symbol name', widget: 'text', required: true },
  ] },
} as const;
export const CODE_INTELLIGENCE_ACTION_SPECS = [
  { ...shared, id: 'code.hover.get', title: 'Get symbol information', bindings: { mcpToolName: 'code_hover_get' }, outputSchema: lazyZodSchema(() => queryOutput('hover')),
    description: 'Read type and documentation for the symbol at a one-based line plus symbol text, or an explicit zero-based UTF-16 character. Answers concern disk text and include its content hash. Unsaved editor edits are refused; a loading project never becomes an empty answer.' },
  { ...shared, id: 'code.definition.get', title: 'Go to definition', bindings: { mcpToolName: 'code_definition_get' }, outputSchema: lazyZodSchema(() => queryOutput('definition')),
    description: 'Find the definition of a symbol by one-based line plus symbol text. Semantic answers concern disk text and include its hash. Without a capable server, explicit symbol names use approximate declaration search labeled text_matches.' },
  { ...shared, id: 'code.references.list', title: 'Find references', bindings: { mcpToolName: 'code_references_list' }, outputSchema: lazyZodSchema(() => queryOutput('references')),
    description: 'Find semantic references before changing a signature; address the symbol by one-based line plus name. Answers include the disk content hash. Without a capable server, explicit names use identifier text search labeled text_matches.' },
  { ...shared, id: 'code.symbols.list', title: 'List file symbols', bindings: { mcpToolName: 'code_symbols_list' },
    inputSchema: CodeIntelligenceFileActionInputSchema, inputHints: { fields: shared.inputHints.fields.slice(0, 3) }, outputSchema: lazyZodSchema(() => queryOutput('documentSymbols')),
    description: 'Read a file outline before opening a long file. Return current disk-text symbols and the content hash, or loading/unavailable; unsaved editor changes are refused.' },
  { ...shared, id: 'code.diagnostics.list', title: 'Check file problems', bindings: { mcpToolName: 'code_diagnostics_list' },
    inputSchema: CodeIntelligenceFileActionInputSchema, inputHints: { fields: shared.inputHints.fields.slice(0, 3) }, outputSchema: lazyZodSchema(() => queryOutput('diagnostics')),
    description: 'Check diagnostics after multi-file edits. Explicitly pull the current disk text and include its hash; return loading until that pull succeeds, never an older stored list as a fresh answer. Unsaved editor changes are refused.' },
  { ...shared, id: 'code.restart', title: 'Restart language servers', sideEffectClass: 'write', bindings: { mcpToolName: 'code_restart' },
    inputSchema: CodeIntelligenceRestartActionInputSchema, inputHints: { fields: shared.inputHints.fields.slice(0, 2) }, outputSchema: DaemonLspRestartResponseSchema,
    description: 'Restart the host-owned language-server sessions for the addressed workspace, optionally one server definition. This reversible operation changes no workspace files; a root with no session is unavailable.' },
  { ...shared, id: 'code.rename.preview', title: 'Preview symbol rename', bindings: { mcpToolName: 'code_rename_preview' },
    inputSchema: CodeIntelligenceRenamePreviewInputSchema, outputSchema: lazyZodSchema(() => semanticPreviewOutput(['prepareRename', 'rename'])),
    description: 'Preview a semantic symbol rename as workspace-relative hash-guarded edits without writing. Omit newName to prepare the rename and inspect its target. Address by one-based line and symbol text.' },
  { ...shared, id: 'code.file.rename.preview', title: 'Preview file rename', bindings: { mcpToolName: 'code_file_rename_preview' },
    inputSchema: CodeIntelligenceFileRenamePreviewInputSchema, outputSchema: lazyZodSchema(() => semanticPreviewOutput(['willRenameFiles'])),
    description: 'Preview a file move with importer updates from the language server. Returns the guarded source move and importer edits; writes nothing.' },
  { ...shared, id: 'code.codeActions.list', title: 'List code actions', bindings: { mcpToolName: 'code_code_actions_list' },
    outputSchema: lazyZodSchema(() => semanticPreviewOutput(['codeActions'])), description: 'Read available server code actions at a symbol. Edits are normalized and hash-guarded; command execution requires the separate apply Action.' },
  { ...shared, id: 'code.rename.apply', title: 'Apply symbol rename', bindings: { mcpToolName: 'code_rename_apply', rpcMethod: RPC_METHODS.DAEMON_LSP_RENAME_APPLY }, surfaces: { ...shared.surfaces, rpc: true },
    surfaceBindings: { rpc: mutationRpcBinding('rename') },
    safety: 'danger', sideEffectClass: 'write', approvalPolicy: { uiConfirmation: 'direct' },
    inputSchema: CodeIntelligenceEditApplyInputSchema, outputSchema: DaemonLspApplyResponseSchema,
    description: 'Apply reviewed semantic rename edits through the guarded multi-file writer. Changed files are refused and successful files return inverse edits for Undo.' },
  { ...shared, id: 'code.file.rename.apply', title: 'Apply file rename', bindings: { mcpToolName: 'code_file_rename_apply', rpcMethod: RPC_METHODS.DAEMON_LSP_FILE_RENAME_APPLY }, surfaces: { ...shared.surfaces, rpc: true },
    surfaceBindings: { rpc: mutationRpcBinding('fileRename') },
    safety: 'danger', sideEffectClass: 'write', approvalPolicy: { uiConfirmation: 'direct' },
    inputSchema: CodeIntelligenceEditApplyInputSchema, outputSchema: DaemonLspApplyResponseSchema,
    description: 'Apply a reviewed file rename and importer updates through the guarded multi-file writer, retaining inverse edits and the reverse move for Undo.' },
  { ...shared, id: 'code.codeAction.apply', title: 'Apply code action', bindings: { mcpToolName: 'code_code_action_apply', rpcMethod: RPC_METHODS.DAEMON_LSP_CODE_ACTION_APPLY }, surfaces: { ...shared.surfaces, rpc: true },
    surfaceBindings: { rpc: mutationRpcBinding('codeAction') },
    safety: 'danger', sideEffectClass: 'write', approvalPolicy: { uiConfirmation: 'direct' },
    inputSchema: CodeIntelligenceCodeActionApplyInputSchema, outputSchema: DaemonLspApplyResponseSchema,
    description: 'Apply one reviewed server code action, including a declared server command. Server edit requests share the guarded multi-file writer and retain partial results and Undo.' },
] as const satisfies readonly PreNormalizedActionSpec[];
