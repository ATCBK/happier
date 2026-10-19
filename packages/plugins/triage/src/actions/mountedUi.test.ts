// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { TriageMountedUiInputV1Schema } from './mountedUiProtocol.js';
import { createPluginRegistrationScope } from '@happier-dev/plugin-sdk/host/registration';
import { derivePluginClientContributionRegistrationRights } from '@happier-dev/protocol/plugins/contributions/catalog';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginClientActionHandler } from '@happier-dev/plugin-sdk/actions';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { activate } from './mountedUi.js';
import { TriageTaskDraftLaunchV1Schema } from './tasksProtocol.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it.each([
  { name: 'explicit draft', fromMessage: false, input: { title: 'Fix reconnect handling', body: 'Explicit body' }, expected: { title: 'Fix reconnect handling', body: 'Explicit body' } },
  { name: 'selected message', fromMessage: true, input: {}, expected: { body: 'Selected answer\nwith details' } },
  { name: 'explicit draft with a selected message', fromMessage: true, input: { title: 'Keep title', body: 'Explicit body' }, expected: { title: 'Keep title', body: 'Explicit body' } },
  { name: 'explicit empty body', fromMessage: true, input: { body: '' }, expected: { body: '' } },
])('opens a reviewable task draft without writing: $name', async ({ fromMessage, input, expected }) => {
  const declaration = PLUGIN_MANIFEST.contributes.actions.find((action) => action.id === 'tasks/open-create-v1');
  if (declaration?.execution.target !== 'client') throw new Error('Missing Tasks draft Action');
  const target = { ...declaration.execution.client, platform: 'web' as const };
  const scope = createPluginRegistrationScope({ pluginId: PLUGIN_MANIFEST.id, target: { realm: 'client', ...target },
    rights: derivePluginClientContributionRegistrationRights(PLUGIN_MANIFEST.contributes, target) });
  activate(scope.api);
  const registration = scope.commit().find((entry) => entry.family === 'actions' && entry.localId === declaration.id);
  if (registration?.family !== 'actions') throw new Error('Tasks draft Action was not registered');
  // The host capture is opaque; the declared target establishes its client handler realm.
  const handler = registration.value as PluginClientActionHandler;
  const opened: unknown[] = [];
  const fixture = await createPluginUiTestkit({ identity: { instanceId: 'task-launch', mountNonce: 'launch' },
    authorPlugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
    surface: defineUiSurface(() => null), surfaceContext: createSurfaceContextFixture(),
    adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: {
      openSurface: ({ view, input }) => { expect(view).toEqual({ pluginId: 'happier.triage', localId: 'tasks' }); opened.push(input); },
      executeAction: () => { throw new Error('Opening a draft must not write a task'); },
    } });
  try {
    expect(await handler(input, {
      plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
      contribution: { id: declaration.id, qualifiedId: `${PLUGIN_MANIFEST.id}/actions/${declaration.id}` },
      invocationSurface: 'agent', signal: new AbortController().signal,
      ui: fixture.context.hostApi, ephemeralSharedScope: null,
      ...(fromMessage ? { messageAction: {
        sessionId: 'session-a', messageId: 'message-a', observedRevision: 'revision-a',
        role: 'agent' as const, contentCategory: 'text' as const, seq: 1,
        visibleText: 'Selected answer\nwith details', structuredPresentationSummary: null,
        provenanceCategory: 'owner' as const,
      } } : {}),
    })).toEqual({ status: 'applied' });
    expect(opened.map((input) => TriageTaskDraftLaunchV1Schema.parse(input))).toEqual([
      { v: 1, kind: 'createTask', fields: expected },
    ]);
  } finally { await fixture.dispose(); }
});

describe('mounted source-panel intents', () => {
  it('admits linked-session selection without admitting an unaddressed or empty selection', () => {
    expect(TriageMountedUiInputV1Schema.safeParse({ mountId: 'detail', operation: {
      kind: 'selectLinkedSession', sessionId: 'session-other',
    } }).success).toBe(true);
    expect(TriageMountedUiInputV1Schema.safeParse({ mountId: 'detail', operation: {
      kind: 'selectLinkedSession', sessionId: '',
    } }).success).toBe(false);
  });
  it.each([
    { kind: 'selectSourceOccurrence', occurrenceId: 'second' },
    { kind: 'setSourceOrdering', order: 'spread' },
    { kind: 'revealSourceUser', occurrenceId: 'second', revealed: false },
  ])('admits $kind on the existing mounted corridor', (operation) => {
    expect(TriageMountedUiInputV1Schema.safeParse({ mountId: 'mounted-page', operation }).success).toBe(true);
  });
  it.each([
    { kind: 'insertSelectedEvidence', occurrenceId: 'second' },
    { kind: 'revealSourceUser', occurrenceId: 'second', revealed: true },
  ])('does not admit approval-bearing $kind through the ordinary mounted Action', (operation) => {
    expect(TriageMountedUiInputV1Schema.safeParse({ mountId: 'mounted-page', operation }).success).toBe(false);
  });
});
