import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { CodeIntelligenceFallbackResultSchema, isCodeIdentifier } from '../machines/codeIntelligenceFallback.js';
import { DaemonLspQueryRequestSchema, DaemonLspQueryResponseSchema, DaemonLspRestartRequestSchema, DaemonLspRestartResponseSchema } from '../machines/languageIntelligence.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';

export const CODE_INTELLIGENCE_ACTION_IDS = ['code.hover.get', 'code.definition.get', 'code.references.list', 'code.symbols.list', 'code.diagnostics.list', 'code.restart'] as const;
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
function queryOutput(kind: 'hover' | 'definition' | 'references' | 'documentSymbols' | 'diagnostics') {
  const semantic = DaemonLspQueryResponseSchema.check(z.superRefine((value, context) => {
    if (value.status === 'ok' && (value.kind !== kind || !value.fileHash)) {
      context.addIssue({ code: 'custom', message: 'An Action answer must match its query and include the disk content hash' });
    }
  }));
  return kind === 'definition' || kind === 'references' ? z.union([semantic, CodeIntelligenceFallbackResultSchema]) : semantic;
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
] as const satisfies readonly PreNormalizedActionSpec[];
