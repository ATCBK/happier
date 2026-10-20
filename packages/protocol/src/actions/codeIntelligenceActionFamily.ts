import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { CodeIntelligenceFallbackInputSchema, CodeIntelligenceFallbackResultSchema } from '../machines/codeIntelligenceFallback.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';

export const CODE_INTELLIGENCE_ACTION_IDS = ['code.definition.get', 'code.references.list'] as const;
export const CodeIntelligenceActionInputSchema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.trim(), z.minLength(1)),
  rootPath: CodeIntelligenceFallbackInputSchema.shape.rootPath,
  path: CodeIntelligenceFallbackInputSchema.shape.path,
  line: CodeIntelligenceFallbackInputSchema.shape.line,
  symbol: CodeIntelligenceFallbackInputSchema.shape.symbol,
  languageId: CodeIntelligenceFallbackInputSchema.shape.languageId,
}));
const shared = {
  approval: { result: 'required' }, safety: 'safe', sideEffectClass: 'read', placements: [],
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
  inputSchema: CodeIntelligenceActionInputSchema, outputSchema: CodeIntelligenceFallbackResultSchema,
  inputHints: { fields: [
    { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
    { path: 'rootPath', title: 'Workspace root', widget: 'text', required: true },
    { path: 'path', title: 'Current file', widget: 'text', required: true },
    { path: 'line', title: 'Line (one-based)', widget: 'text', required: true },
    { path: 'symbol', title: 'Symbol name', widget: 'text', required: true },
  ] },
} as const;
export const CODE_INTELLIGENCE_ACTION_SPECS = [
  { ...shared, id: 'code.definition.get', title: 'Find definition by name', bindings: { mcpToolName: 'code_definition_get' },
    description: 'Find declaration text for a symbol by name, preferring the same file and nearby paths. Supply the symbol text and its one-based line. Results are text matches, not semantic definitions.' },
  { ...shared, id: 'code.references.list', title: 'Find text references', bindings: { mcpToolName: 'code_references_list' },
    description: 'Find identifier text matches before changing a symbol. Supply the symbol text and its one-based line. Results include declarations and are text matches, not semantic references.' },
] as const satisfies readonly PreNormalizedActionSpec[];
