import { ScopeActionInputSchemas, ScopeActionOutputSchemas } from '../scopeActionFamily.js';
import type { ActionSpecProjectionMetadata, PreNormalizedActionSpec } from '../actionSpecs.js';

const clientView = {
  safety: 'safe', requiredAuthority: 'account_automation', executionPlacement: 'client', placements: [],
  surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
  toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only', cli: 'discoverable_only' },
  inputHints: { fields: [] },
} as const;

type ScopeActionSpec = {
  [Id in keyof typeof ScopeActionInputSchemas]: ActionSpecProjectionMetadata & Omit<typeof clientView, 'inputHints' | 'safety'> & Readonly<{
    id: Id;
    safety: 'safe' | 'danger';
    inputHints: PreNormalizedActionSpec['inputHints'];
    approval: { result: 'required' };
    inputSchema: (typeof ScopeActionInputSchemas)[Id];
    outputSchema: (typeof ScopeActionOutputSchemas)[Id];
  }>;
}[keyof typeof ScopeActionInputSchemas];
export const SCOPE_ACTION_SPECS: readonly ScopeActionSpec[] = [
  { ...clientView, id: 'file.editor.save', safety: 'danger', approval: { result: 'required' }, title: 'Save open file edits',
    examples: { voice: { argsExample: '{}' } }, bindings: { sdkMethod: 'file.editor.save' },
    cli: { acceptsServerId: true, commands: [] },
    description: 'Save the mounted file editor buffer through its guarded save owner. Omit tabId for the most recently mounted editor; no mounted editor returns unavailable.', sideEffectClass: 'write',
    inputHints: { fields: [{ path: 'tabId', title: 'File tab', widget: 'text', description: 'Mounted file tab id; defaults to the most recently mounted editor.' }] },
    inputSchema: ScopeActionInputSchemas['file.editor.save'], outputSchema: ScopeActionOutputSchemas['file.editor.save'] },
  { ...clientView, id: 'file.editor.resolve', safety: 'danger', approval: { result: 'required' }, title: 'Resolve open file conflict',
    examples: { voice: { argsExample: '{"resolution":"useTheirs"}' } }, bindings: { sdkMethod: 'file.editor.resolve' },
    cli: { acceptsServerId: true, commands: [] },
    description: 'Resolve a mounted file editor conflict by using the draft or disk version, or discard the draft, through the same editor owner as the UI.', sideEffectClass: 'write',
    inputHints: { fields: [
      { path: 'tabId', title: 'File tab', widget: 'text', description: 'Mounted file tab id; defaults to the most recently mounted editor.' },
      { path: 'resolution', title: 'Resolution', widget: 'text', required: true, description: 'useMine, useTheirs or discardDraft.' },
    ] },
    inputSchema: ScopeActionInputSchemas['file.editor.resolve'], outputSchema: ScopeActionOutputSchemas['file.editor.resolve'] },
  { ...clientView, id: 'file.view.get', approval: { result: 'required' }, title: 'Read File page view',
    examples: { voice: { argsExample: '{}' } }, bindings: { sdkMethod: 'file.view.get' },
    description: 'Read the mounted File page mode, Changes scope and blame visibility on this client. Omit tabId for the active file.', sideEffectClass: 'read',
    inputHints: { fields: [{ path: 'tabId', title: 'File tab', widget: 'text', description: 'Mounted file tab id; defaults to the active File page.' }] },
    inputSchema: ScopeActionInputSchemas['file.view.get'], outputSchema: ScopeActionOutputSchemas['file.view.get'] },
  { ...clientView, id: 'file.view.set', approval: { result: 'required' }, title: 'Change File page view',
    examples: { voice: { argsExample: '{"mode":"changes","blame":false}' } }, bindings: { sdkMethod: 'file.view.set' },
    description: 'Change the mounted File page mode, typed Changes scope or blame visibility through the same per-tab view owner as the UI. Unsupported controls fail explicitly.', sideEffectClass: 'write',
    inputHints: { fields: [
      { path: 'tabId', title: 'File tab', widget: 'text', description: 'Mounted file tab id; defaults to the active File page.' },
      { path: 'mode', title: 'Mode', widget: 'text', description: 'view, changes, preview, source or edit; only modes available for the file are accepted.' },
      { path: 'changesScope', title: 'Changes scope', widget: 'json', description: 'workingTree, session, or turn with its turnId.' },
      { path: 'blame', title: 'Blame', widget: 'boolean', description: 'Whether to show file attribution, when the workspace supports it.' },
    ] },
    inputSchema: ScopeActionInputSchemas['file.view.set'], outputSchema: ScopeActionOutputSchemas['file.view.set'] },
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
  { ...clientView, id: 'shell.column.get', approval: {result: 'required'}, title: 'Read column state',
    examples: { voice: { argsExample: '{}' } },
    description: 'Read the navigation (default), main or side column on this client, including its visibility, availability, host label and offered side-panel tabs.', sideEffectClass: 'read',
    inputSchema: ScopeActionInputSchemas['shell.column.get'], outputSchema: ScopeActionOutputSchemas['shell.column.get'] },
  { ...clientView, id: 'shell.column.set', approval: {result: 'required'}, title: 'Show or hide column',
    examples: { voice: { argsExample: '{"visible":true}' } },
    description: 'Show or hide the navigation (default), main or side column through its mounted owner. On the side column, an offered tab id selects that tab and opens the panel, including plugin tabs. Absent surfaces and unavailable controls fail explicitly.', sideEffectClass: 'write',
    inputSchema: ScopeActionInputSchemas['shell.column.set'], outputSchema: ScopeActionOutputSchemas['shell.column.set'] },
] as const satisfies readonly PreNormalizedActionSpec[];
