import { createPluginTestkit, type PluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginRegistrationScope } from '@happier-dev/plugin-sdk/host/registration';
import { derivePluginAccountContributionRegistrationRights } from '@happier-dev/protocol/plugins/contributions/catalog';
import type { PluginServices, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import type { StorageService } from '@happier-dev/plugin-sdk/storage';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/plugin-sdk/manifest';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import {
  TRIAGE_SET_FIX_PULL_REQUEST_ACTION_LOCAL_ID_V1,
  TriageEntryRefV1Schema,
  TriageSetFixPullRequestResultV1Schema,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { TriageDataActionContext } from './actions/dataContext.js';

import { TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1, TriageListEntriesResultV1Schema } from './actions/listEntriesProtocol.js';
import {
  TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
  TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
  TriageSetEntryPinnedResultV1Schema,
  TriageListPinnedEntriesResultV1Schema,
} from './actions/userMarksProtocol.js';
import {
  TRIAGE_ADMINISTER_SAVED_VIEW_ACTION_LOCAL_ID_V1,
  TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1,
  TriageAdministerSavedViewResultV1Schema,
  TriageReadSavedViewsResultV1Schema,
  TriageSavedViewsCatalogValueV1Schema,
} from './actions/savedViewsProtocol.js';
import { TRIAGE_ENTRY_ATTACHMENT_LOCAL_ID_V1 } from './composer/attachmentValue.js';
import { PLUGIN_MANIFEST, TRIAGE_PLUGIN } from './manifest.js';
import { activate } from './activate.js';
import { activate as activateAccount } from './accountRuntime.js';
import { CORPUS_USER_MARKS_COLLECTION } from './corpus/collections/definitions.js';
import {
  CORPUS_SOURCE_INSTANCES_COLLECTION_ID,
  CORPUS_SESSION_LINKS_COLLECTION_ID,
  CORPUS_USER_MARKS_INDEX_ID,
} from './corpus/collections/ids.js';
import { administerConfiguredSourceInstance } from './corpus/configuration/administerConfiguredSourceInstance.js';
import { createTestkitCorpusCollections } from './corpus/testkit/corpusCollections.test-support.js';
import { createTestkitAccountKv } from './settings/testkit/accountKv.test-support.js';
import { TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1 } from './settings/savedViews.js';
import { TRIAGE_LIST_NO_FILTERS_V1 } from './projection/listWindow.js';
import { TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1, TRIAGE_DEFAULT_ACTIONS_V1, planTriageOfferedActionsV1 } from './settings/actions.js';
import { TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1, TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1,
  TriageReadActionsResultV1Schema, TriageAdministerActionResultV1Schema } from './actions/actionsCatalogProtocol.js';
import { createDirectTriageActionsTransport, readTriageActionsProjectionV1 } from './ui/actions/actionsCommand.js';

async function withRegisteredPlugin(run: (fixture: Readonly<{
  plugin: PluginTestkit;
  corpus: ReturnType<typeof createTestkitCorpusCollections>;
  kv: ReturnType<typeof createTestkitAccountKv>;
}>) => Promise<void>) {
  const corpus = createTestkitCorpusCollections();
  const kv = createTestkitAccountKv();
  // Account storage is the network/database boundary. The existing testkits
  // retain real collection schema validation, identity derivation and CAS.
  const storage = { account: {
    kv: kv.kv,
    collection: (definition: { id: string }) => {
      if (definition.id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID) return corpus.collections.sourceInstances;
      if (definition.id === CORPUS_SESSION_LINKS_COLLECTION_ID) return corpus.collections.sessionLinks;
      if (definition.id === CORPUS_USER_MARKS_COLLECTION.id) return corpus.collections.userMarks;
      throw new Error(`Unexpected collection ${definition.id}`);
    },
  } } as unknown as StorageService;
  let plugin!: PluginTestkit;
  // The SDK produces this empty admitted snapshot from the real declarations;
  // the subscription adapter models only the plugin-to-host service boundary.
  const targetedContributions = { observeForSelf: (point: Parameters<PluginTestkit['readTargetedContributionFixture']>[0]) => ({
    readCurrent: async () => plugin.readTargetedContributionFixture(point),
    dispose: () => {},
  }) } as unknown as PluginServices['targetedContributions'];
  plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: TRIAGE_PLUGIN, services: { storage, targetedContributions } });
  try {
    await run({ plugin, corpus, kv });
  } finally {
    await plugin.dispose();
  }
}

describe('Triage activation', () => {
  it('accepts daemon and portable invocation capabilities through the same data handler context', () => {
    expectTypeOf<PluginInvocationContext>().toMatchTypeOf<TriageDataActionContext>();
    expectTypeOf<PluginAccountActionContext>().toMatchTypeOf<TriageDataActionContext>();
  });
  it('registers personal source configuration only through the portable Account activation', async () => {
    const target = { artifactId: 'triage-account-runtime', exportName: 'activate' };
    const account = createPluginRegistrationScope({
      pluginId: PLUGIN_MANIFEST.id,
      target: { realm: 'account', ...target },
      rights: derivePluginAccountContributionRegistrationRights(PLUGIN_MANIFEST.contributes, target),
    });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      await activateAccount(account.api);
      const registrations = account.commit();
      expect(registrations.find(entry => entry.family === 'actions' && entry.localId === 'internal/tasks/configure-v1')).toBeDefined();
      expect(registrations.map(entry => entry.localId).sort())
        .toEqual(PLUGIN_MANIFEST.contributes.actions.filter(action => action.execution.target === 'account').map(action => action.id).sort());
      expect(plugin.registration('actions', 'internal/tasks/configure-v1')).toBeUndefined();
      expect(plugin.registrations().filter(entry => entry.family === 'actions').map(entry => entry.localId).sort())
        .toEqual(PLUGIN_MANIFEST.contributes.actions.filter(action => action.execution.target === 'daemon').map(action => action.id).sort());
    } finally { await Promise.all([plugin.dispose(), account.dispose()]); }
  });

  it.each(['agent', 'mcp', 'cli'] as const)('keeps built-ins and explicit opt-outs identical on registered %s Actions and direct UI reads', async (surface) => {
    await withRegisteredPlugin(async ({ plugin, kv }) => {
      kv.seed(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1, { v: 1, actions: [] });
      const read = async () => TriageReadActionsResultV1Schema.parse(await plugin.invokeAction(
        TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1, { v: 1 }, { surface }));
      const initial = await read();
      expect(initial.actions).toEqual(TRIAGE_DEFAULT_ACTIONS_V1);
      const disabled = TriageAdministerActionResultV1Schema.parse(await plugin.invokeAction(
        TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1, { v: 1, kind: 'delete', actionId: 'explain-pr', expectedRevision: initial.revision }, { surface }));
      expect(disabled.status).toBe('applied');
      const after = await read();
      expect(after.actions.find(action => action.actionId === 'explain-pr')?.enabled).toBe(false);
      const ui = await createDirectTriageActionsTransport(kv.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1), { admitAction: async () => true }).read();
      expect(ui).toEqual(after);
      expect(planTriageOfferedActionsV1(readTriageActionsProjectionV1(ui).value.actions, 'pullRequest')
        .some(action => action.actionId === 'explain-pr')).toBe(false);
      const original = initial.actions.find(action => action.actionId === 'explain-pr');
      if (!original || original.target.kind !== 'agent') throw new Error('Missing built-in explanation Action');
      const enabled = TriageAdministerActionResultV1Schema.parse(await plugin.invokeAction(
        TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1, { v: 1, kind: 'update', actionId: original.actionId,
          expectedRevision: after.revision, label: original.label, enabled: true, appliesTo: original.appliesTo,
          profileId: original.profileId, workspaceMode: original.workspaceMode,
          target: { kind: 'agent', promptInvocationId: original.target.promptInvocationId, delivery: original.target.delivery },
        }, { surface }));
      expect(enabled.status).toBe('applied');
      expect((await read()).actions).toEqual(initial.actions);
      const reset = TriageAdministerActionResultV1Schema.parse(await plugin.invokeAction(
        TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1,
        { v: 1, kind: 'reset', expectedRevision: (await read()).revision }, { surface }));
      expect(reset.status).toBe('applied');
      expect(kv.read(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1)).toBeUndefined();
      const absent = await read();
      expect(absent).toMatchObject({ availability: 'absent', actions: initial.actions, revision: reset.revision });
      expect(await createDirectTriageActionsTransport(kv.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1), { admitAction: async () => true }).read()).toEqual(absent);
    });
  });

  it('registers exactly the daemon and Account Actions the manifest declares', async () => {
    await withRegisteredPlugin(async ({ plugin }) => {
      const registered = plugin.registrations().filter((entry) => entry.family === 'actions').map((entry) => entry.localId);

      // An activation that registers nothing leaves the declared Action
      // undispatchable, and an activation that registers something undeclared
      // exposes a contribution the host never admitted. Both fail here.
      expect(registered).toEqual(expect.arrayContaining([
        TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
        TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
        TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
      ]));
      expect(PLUGIN_MANIFEST.contributes.actions
        .filter((action) => action.execution.target !== 'client')
        .map((action) => action.id).sort()).toEqual([...registered].sort());
    });
  });

  it('registers a runtime for every attachment lifecycle role the manifest declares', async () => {
    await withRegisteredPlugin(async ({ plugin }) => {
      const registered = plugin.registrations().filter((entry) => entry.family === 'composerAttachments').map((entry) => {
        const runtime = plugin.registration('composerAttachments', entry.localId);
        if (!runtime) throw new Error('Attachment runtime missing');
        return { id: entry.localId, roles: Object.keys(runtime).filter((key) => runtime[key as keyof typeof runtime] !== undefined) };
      });

      // A declared role with no registration is a draft the host asks this plugin
      // to resolve and gets nothing back for; a registered role the manifest never
      // declared is never invoked. Both are silent, so both fail here.
      expect(registered).toEqual(PLUGIN_MANIFEST.contributes.composerAttachments
        .filter((attachment) => attachment.runtime !== undefined)
        .map((attachment) => ({
          id: attachment.id,
          roles: Object.keys(attachment.runtime).filter(
            (role) => attachment.runtime[role as keyof typeof attachment.runtime] === true,
          ),
        })));
      expect(registered).toContainEqual({
        id: TRIAGE_ENTRY_ATTACHMENT_LOCAL_ID_V1,
        roles: ['resolveForDispatch', 'resolveForDispatchV2'],
      });
    });
  });

  it('creates, edits and deletes a saved view through registered Actions and strict persisted/read schemas', async () => {
    await withRegisteredPlugin(async ({ plugin, kv }) => {
      const options = { surface: 'agent' as const, sessionId: 'triage-audit-session' };
      const draft = { v: 1 as const, label: 'Review café 🧪', query: '', filters: TRIAGE_LIST_NO_FILTERS_V1,
        order: 'smart', smartPolicy: { v: 1, precedence: ['attention', 'activity'] }, view: 'board' };
      const created = TriageAdministerSavedViewResultV1Schema.parse(await plugin.invokeAction(
        TRIAGE_ADMINISTER_SAVED_VIEW_ACTION_LOCAL_ID_V1, { ...draft, kind: 'create', expectedRevision: 'absent', select: true }, options));
      expect(created.status).toBe('applied');
      if (!created.viewId || !created.revision) throw new Error('Applied view must carry identity and revision');
      expect(created.selectedViewId).toBe(created.viewId);
      expect(TriageSavedViewsCatalogValueV1Schema.parse(kv.read(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1)).views)
        .toEqual(created.views);

      const updated = TriageAdministerSavedViewResultV1Schema.parse(await plugin.invokeAction(
        TRIAGE_ADMINISTER_SAVED_VIEW_ACTION_LOCAL_ID_V1, { ...draft, kind: 'update', viewId: created.viewId,
          expectedRevision: created.revision, label: 'Renamed', query: 'parser', view: 'list' }, options));
      expect(updated.status).toBe('applied');
      expect(TriageReadSavedViewsResultV1Schema.parse(await plugin.invokeAction(
        TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1, { v: 1 }, options)).views)
        .toEqual(updated.views);
      expect(updated.views?.[0]).toMatchObject({ viewId: created.viewId, label: 'Renamed', query: 'parser', view: 'list' });
      expect(TriageAdministerSavedViewResultV1Schema.parse(await plugin.invokeAction(
        TRIAGE_ADMINISTER_SAVED_VIEW_ACTION_LOCAL_ID_V1, { ...draft, kind: 'update', viewId: created.viewId,
          expectedRevision: created.revision }, options))).toEqual({ v: 1, status: 'conflict' });

      const deleted = TriageAdministerSavedViewResultV1Schema.parse(await plugin.invokeAction(
        TRIAGE_ADMINISTER_SAVED_VIEW_ACTION_LOCAL_ID_V1, { v: 1, kind: 'delete', viewId: created.viewId,
          expectedRevision: updated.revision! }, options));
      expect(deleted).toMatchObject({ status: 'applied', views: [], selectedViewId: null });
      const persisted = TriageSavedViewsCatalogValueV1Schema.parse(kv.read(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1));
      expect(persisted).toEqual({ v: 1, views: [], selectedViewId: null });
      expect(TriageSavedViewsCatalogValueV1Schema.safeParse({ ...persisted, providerPayload: {} }).success).toBe(false);
    });
  });

  it('lists from a session-qualified registered Action and retains a configured source whose plugin is unavailable', async () => {
    await withRegisteredPlugin(async ({ plugin, corpus }) => {
      const fixture = createTriageSourceV1Fixture();
      const configured = fixture.configuredInstance;
      if (fixture.administrationInput.kind !== 'create') throw new Error('Canonical fixture must offer source creation');
      expect(await administerConfiguredSourceInstance({ collections: corpus.collections,
        source: configured.instance.source, declaredPurpose: fixture.descriptor.purpose,
        request: { kind: 'create', draft: fixture.administrationInput.draft }, nowMs: 1,
        mintSourceInstanceId: () => configured.instance.sourceInstanceId,
      })).toEqual({ kind: 'active', sourceInstanceId: configured.instance.sourceInstanceId });
      const result = TriageListEntriesResultV1Schema.parse(await plugin.invokeAction(TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
        { v: 1, sources: { kind: 'allConfigured' }, limit: 10, order: 'newest' },
        { surface: 'agent', sessionId: 'triage-audit-session' }));
      expect(result.configuredSources).toEqual([{
        source: configured.instance.source, sourceInstanceId: configured.instance.sourceInstanceId,
        configurationRevision: 1, available: false, displayLabel: configured.locator?.displayLabel,
      }]);
      expect(result.window.rows).toEqual([]);
      expect(result.window.coverage).toBe('partial');
      expect((await corpus.collections.sourceInstances.query({ index: 'by-lifecycle', order: 'asc' })).rows)
        .toHaveLength(1);
      expect(TriageListEntriesResultV1Schema.safeParse({ ...result, providerPayload: {} }).success).toBe(false);
    });
  });

  it('pins, reads and unpins schema2 marks through registered Actions without leaking row identity', async () => {
    await withRegisteredPlugin(async ({ plugin, corpus }) => {
      const pullRequest = createTriageSourceV1Fixture().detailInput.observation.entryRef;
      const entryRef = TriageEntryRefV1Schema.parse({ ...pullRequest, kindId: 'issue', entryId: 'issue-17' });
      const options = { surface: 'agent' as const, sessionId: 'triage-audit-session' };
      const displayAtMark = { title: 'Review café 🧪', scopeLabel: 'example/repository' };
      // Produce the schema2-only relationship through its registered writer;
      // Pin and Unpin must preserve this independent durable user choice.
      expect(TriageSetFixPullRequestResultV1Schema.parse(await plugin.invokeAction(TRIAGE_SET_FIX_PULL_REQUEST_ACTION_LOCAL_ID_V1,
        { v: 1, linked: true, entryRef, displayAtMark, fixPullRequest: pullRequest, displayAtLink: displayAtMark }, options)))
        .toEqual({ v: 1, status: 'linked' });
      expect(TriageSetEntryPinnedResultV1Schema.parse(await plugin.invokeAction(TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
        { v: 1, pinned: true, entryRef, displayAtMark }, options))).toEqual({ v: 1, status: 'pinned' });
      const pinned = TriageListPinnedEntriesResultV1Schema.parse(await plugin.invokeAction(TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
        { v: 1, limit: 1 }, options));
      expect(pinned.pins).toEqual([{ entryRef, displayAtMark, markedAtMs: expect.any(Number) }]);
      const stored = await corpus.collections.userMarks.query({ index: CORPUS_USER_MARKS_INDEX_ID.byPinned, order: 'asc' });
      expect(stored.rows).toHaveLength(1);
      const declared = compilePluginJsonSchema(CORPUS_USER_MARKS_COLLECTION.schema);
      expect(isValidPluginJsonSchemaValue(declared, stored.rows[0]!.value)).toBe(true);
      expect(stored.rows[0]!.value).toMatchObject({ fixPullRequests: { linked: [{ entryRef: pullRequest }] } });
      expect(isValidPluginJsonSchemaValue(declared, { ...stored.rows[0]!.value, providerPayload: {} })).toBe(false);
      expect(pinned.pins[0]).not.toHaveProperty('markTag');

      await expect(plugin.invokeAction(TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
        { v: 1, pinned: false, entryRef, displayAtMark }, options)).rejects.toMatchObject({ code: 'plugin_action_input_schema_invalid' });
      expect(TriageListPinnedEntriesResultV1Schema.parse(await plugin.invokeAction(TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
        { v: 1, limit: 1 }, options)).pins).toEqual(pinned.pins);
      expect(TriageSetEntryPinnedResultV1Schema.parse(await plugin.invokeAction(TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
        { v: 1, pinned: false, entryRef }, options))).toEqual({ v: 1, status: 'unpinned' });
      expect(TriageListPinnedEntriesResultV1Schema.parse(await plugin.invokeAction(TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
        { v: 1, limit: 1 }, options))).toEqual({ v: 1, pins: [] });
      expect((await corpus.collections.userMarks.query({ index: CORPUS_USER_MARKS_INDEX_ID.byPinned, order: 'asc' })).rows)
        .toEqual([expect.objectContaining({ value: expect.objectContaining({ pinned: false,
          fixPullRequests: expect.objectContaining({ linked: [expect.objectContaining({ entryRef: pullRequest })] }),
        }) })]);
    });
  });
});
