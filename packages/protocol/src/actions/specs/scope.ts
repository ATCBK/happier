import { ScopeActionInputSchemas, ScopeActionOutputSchemas } from '../scopeActionFamily.js';
import type { ActionSpecProjectionMetadata, PreNormalizedActionSpec } from '../actionSpecs.js';

const clientView = {
  safety: 'safe', requiredAuthority: 'account_automation', executionPlacement: 'client', placements: [],
  surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
  toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only', cli: 'discoverable_only' },
  inputHints: { fields: [] },
} as const;

type ScopeActionSpec = {
  [Id in keyof typeof ScopeActionInputSchemas]: ActionSpecProjectionMetadata & typeof clientView & Readonly<{
    id: Id;
    approval: { result: 'required' };
    inputSchema: (typeof ScopeActionInputSchemas)[Id];
    outputSchema: (typeof ScopeActionOutputSchemas)[Id];
  }>;
}[keyof typeof ScopeActionInputSchemas];
export const SCOPE_ACTION_SPECS: readonly ScopeActionSpec[] = [
  { ...clientView, id: 'workflow.library.view.get', approval: {result: 'required'}, title: 'Read Workflow Library view',
    examples: { voice: { argsExample: '{}' } }, bindings: { sdkMethod: 'workflow.libraryView.get', voiceClientToolName: 'workflow_library_view_get' },
    description: 'Read the focused mounted Workflow Library view, offered views, search text and visible loaded row keys on this client.', sideEffectClass: 'read',
    inputSchema: ScopeActionInputSchemas['workflow.library.view.get'], outputSchema: ScopeActionOutputSchemas['workflow.library.view.get'] },
  { ...clientView, id: 'workflow.library.view.set', approval: {result: 'required'}, title: 'Change Workflow Library view',
    examples: { voice: { argsExample: '{"view":"triggered","searchQuery":"release"}' } }, bindings: { sdkMethod: 'workflow.libraryView.set', voiceClientToolName: 'workflow_library_view_set' },
    description: 'Change All, Triggered, Running or search through the focused mounted Workflow Library controller. An unoffered view is unavailable.', sideEffectClass: 'write',
    inputSchema: ScopeActionInputSchemas['workflow.library.view.set'], outputSchema: ScopeActionOutputSchemas['workflow.library.view.set'] },
  { ...clientView, id: 'workflow.library.view.reset', approval: {result: 'required'}, title: 'Reset Workflow Library view',
    examples: { voice: { argsExample: '{}' } }, bindings: { sdkMethod: 'workflow.libraryView.reset', voiceClientToolName: 'workflow_library_view_reset' },
    description: 'Restore All and clear search through the focused mounted Workflow Library controller on this client.', sideEffectClass: 'write',
    inputSchema: ScopeActionInputSchemas['workflow.library.view.reset'], outputSchema: ScopeActionOutputSchemas['workflow.library.view.reset'] },
  { ...clientView, id: 'session.list.view.get', approval: {result: 'required'}, title: 'Read Sessions view',
    examples: { voice: { argsExample: '{}' } },
    bindings: { sdkMethod: 'session.listView.get' },
    description: 'Read the mounted My work panel filters and available Homes on this client.', sideEffectClass: 'read',
    inputSchema: ScopeActionInputSchemas['session.list.view.get'], outputSchema: ScopeActionOutputSchemas['session.list.view.get'] },
  { ...clientView, id: 'session.list.view.set', approval: {result: 'required'}, title: 'Change Sessions view',
    examples: { voice: { argsExample: '{"includeInactive":true}' } },
    bindings: { sdkMethod: 'session.listView.set' },
    description: 'Change scope, attention, Homes, audiences, tags, source, search or inactive visibility through the mounted Sessions controller.', sideEffectClass: 'write',
    inputSchema: ScopeActionInputSchemas['session.list.view.set'], outputSchema: ScopeActionOutputSchemas['session.list.view.set'] },
  { ...clientView, id: 'session.list.view.reset', approval: {result: 'required'}, title: 'Reset Sessions view',
    examples: { voice: { argsExample: '{}' } },
    bindings: { sdkMethod: 'session.listView.reset' },
    description: 'Restore the mounted Sessions view defaults through the same Reset control.', sideEffectClass: 'write',
    inputSchema: ScopeActionInputSchemas['session.list.view.reset'], outputSchema: ScopeActionOutputSchemas['session.list.view.reset'] },
  { ...clientView, id: 'shell.column.get', approval: {result: 'required'}, title: 'Read navigation column',
    examples: { voice: { argsExample: '{}' } },
    description: 'Read whether this client has a navigation column and whether it is visible.', sideEffectClass: 'read',
    inputSchema: ScopeActionInputSchemas['shell.column.get'], outputSchema: ScopeActionOutputSchemas['shell.column.get'] },
  { ...clientView, id: 'shell.column.set', approval: {result: 'required'}, title: 'Show or hide navigation column',
    examples: { voice: { argsExample: '{"visible":true}' } },
    description: 'Show or hide the current destination column on this client through the shell visibility owner.', sideEffectClass: 'write',
    inputSchema: ScopeActionInputSchemas['shell.column.set'], outputSchema: ScopeActionOutputSchemas['shell.column.set'] },
] as const satisfies readonly PreNormalizedActionSpec[];
