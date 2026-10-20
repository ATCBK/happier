import { MemoryActionInputSchemasV1 as inputs, MemoryActionOutputSchemasV1 as outputs } from '../../prompts/library/memoryActionsV1.js';
import type { ActionSpecProjectionMetadata, PreNormalizedActionSpec } from '../actionSpecs.js';

const common = {
  placements: [], executionPlacement: 'account', requiredAuthority: 'account_automation',
  inputHints: { fields: [] },
  surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
} as const;
type MemoryDocumentActionSpec = {
  [Id in keyof typeof inputs]: ActionSpecProjectionMetadata & typeof common & Readonly<{
    id: Id;
    approval: Id extends 'memory.read' | 'memory.list'
      ? { result: 'none' }
      : { result: 'optional'; flow: 'deferred' };
    inputSchema: (typeof inputs)[Id];
    outputSchema: (typeof outputs)[Id];
  }>;
}[keyof typeof inputs];
export const MEMORY_DOCUMENT_ACTION_SPECS_V1: readonly MemoryDocumentActionSpec[] = [
  { ...common, id: 'memory.decision.save', approval: { result: 'optional', flow: 'deferred' }, title: 'Save a decision', safety: 'danger', sideEffectClass: 'write',
    description: 'Save a decision with an explicit reason and exact committed source-message reference through the same memory target, duplicate review, full-revision CAS and lazy attachment owner as remember. The server admits source read and disclosure to the destination Artifact before writing. Human approval is host-derived; agent or waived saves record no human approval. Expiry is Never or a date. Missing source support returns an explicit unavailable or unsupported failure.',
    bindings: { mcpToolName: 'memory_decision_save', voiceClientToolName: 'memoryDecisionSave' },
    cli: { acceptsServerId: true, commands: [{ path: ['memory', 'decision', 'save'], visibility: 'canonical' }] },
    inputSchema: inputs['memory.decision.save'], outputSchema: outputs['memory.decision.save'] },
  { ...common, id: 'memory.remember', approval: {result: 'optional',flow: 'deferred'}, title: 'Remember a fact', safety: 'danger', sideEffectClass: 'write',
    description: 'Remember sanitized text in the index or an optional topic. Related active facts return memory_duplicate_choice_required before writing or requesting approval. Resubmit the exact reviewed target and revision with an explicit duplicateChoice: update or replace the selected fact with archived history, or keep_both. Target a reviewed document, a Session, or an explicit Account or qualified Project scope without a Session. A missing scope document is created and attached lazily. A Bot defaults to its own memory; an ordinary Session uses Project memory when present, else Account memory. Private writes are allowed; shared writes ask first and retain the reviewed document and revision without rebasing.',
    bindings: { mcpToolName: 'memory_remember', voiceClientToolName: 'memoryRemember' },
    cli: { acceptsServerId: true, commands: [{ path: ['memory', 'remember'], visibility: 'canonical' }] },
    inputSchema: inputs['memory.remember'], outputSchema: outputs['memory.remember'] },
  { ...common, id: 'memory.update', approval: {result: 'optional',flow: 'deferred'}, title: 'Update a remembered fact', safety: 'danger', sideEffectClass: 'write',
    description: 'Correct a fact at the reviewed Artifact revision and move its replacement to the optional destination topic (omitted means index). Other related active facts require explicit duplicateChoice at that same revision. Preserve the previous fact in archive with host-derived provenance. Unchanged-wording renewal preserves approval; changed decision wording retains its source and reason but clears prior approval unless the host witnesses a new approval. With topic archive and restore true, restore into restoreTopic (omitted means index), retaining the original id and source when keeping both. Related active facts require the same explicit duplicate choice; update or replace archives the selected active fact. Refuse if a replacement still references the archived source. Conflicts return the current version without rebasing.',
    bindings: { mcpToolName: 'memory_update', voiceClientToolName: 'memoryUpdate' },
    cli: { acceptsServerId: true, commands: [{ path: ['memory', 'update'], visibility: 'canonical' }] },
    inputSchema: inputs['memory.update'], outputSchema: outputs['memory.update'] },
  { ...common, id: 'memory.forget', approval: {result: 'optional',flow: 'deferred'}, title: 'Forget a remembered fact', safety: 'danger', sideEffectClass: 'write',
    description: 'Move a fact from the selected topic (omitted means index) into archive at the reviewed Artifact revision, without erasing searchable history. Conflicts return the current version.',
    bindings: { mcpToolName: 'memory_forget', voiceClientToolName: 'memoryForget' },
    cli: { acceptsServerId: true, commands: [{ path: ['memory', 'forget'], visibility: 'canonical' }] },
    inputSchema: inputs['memory.forget'], outputSchema: outputs['memory.forget'] },
  { ...common, id: 'memory.read', approval: {result: 'none'}, title: 'Read memory', safety: 'safe', sideEffectClass: 'read',
    description: 'Read the current memory index with topic titles and summaries, or only the named section when topic is supplied. The archive topic includes expired and previously replaced or forgotten facts. Return the observed header/body revision.',
    bindings: { mcpToolName: 'memory_read', voiceClientToolName: 'memoryRead' },
    cli: { acceptsServerId: true, commands: [{ path: ['memory', 'read'], visibility: 'canonical' }] },
    inputSchema: inputs['memory.read'], outputSchema: outputs['memory.read'] },
  { ...common, id: 'memory.list', approval: {result: 'none'}, title: 'List memory documents', safety: 'safe', sideEffectClass: 'read',
    description: 'Read one page from the Account Artifact inventory, preserving its coverage and continuation cursor.',
    bindings: { mcpToolName: 'memory_list', voiceClientToolName: 'memoryList' },
    cli: { acceptsServerId: true, commands: [{ path: ['memory', 'list'], visibility: 'canonical' }] },
    inputSchema: inputs['memory.list'], outputSchema: outputs['memory.list'] },
] as const satisfies readonly PreNormalizedActionSpec[];
