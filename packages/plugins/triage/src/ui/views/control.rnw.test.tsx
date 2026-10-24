// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { Button, Text, defineUiSurface } from '@happier-dev/plugin-ui';
import { PluginUiProvider } from '@happier-dev/plugin-ui/advanced';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';

import { CORPUS_DEFAULT_SMART_POLICY_V1 } from '../../corpus/query/smartPolicy.js';
import { TRIAGE_LIST_NO_FILTERS_V1 } from '../../projection/listWindow.js';
import {
  CORPUS_EMPTY_SAVED_VIEWS_V1, TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1,
  mutateTriageSavedViews, readTriageSavedViews, type CorpusSavedViewCommandV1,
} from '../../settings/savedViews.js';
import { createTestkitAccountKv } from '../../settings/testkit/accountKv.test-support.js';
import { useTriageViewsControl } from './control.js';
import { readTriageSavedViewLensStatusV1 } from './divergence.js';
import { triageRenameSavedViewInputV1, triageUpdateSavedViewInputV1, type TriageSavedViewLensV1 } from './savedViewsCommand.js';
import { pressToolbarMenuItem } from '../shell/toolbarMenus.test-support.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
afterEach(async () => { for (const fixture of mounted.splice(0)) await fixture.dispose(); });

async function typeName(value: string) {
  // The semantic testkit has no typing action; use the real DOM input boundary.
  const input = document.querySelector('input');
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('keeps select/create/rename/update/delete at Triage’s durable Account owner through the shared picker', async () => {
  const account = createTestkitAccountKv();
  const deps = {
    catalog: account.catalog(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1),
    mintViewId: () => '00000001-0000-4000-8000-000000000000',
  };
  const initialLens: TriageSavedViewLensV1 = {
    query: 'review', filters: TRIAGE_LIST_NO_FILTERS_V1, order: 'oldest',
    smartPolicy: CORPUS_DEFAULT_SMART_POLICY_V1, view: 'board',
  };
  function Surface() {
    const [catalog, setCatalog] = React.useState(CORPUS_EMPTY_SAVED_VIEWS_V1);
    const [lens, setLens] = React.useState(initialLens);
    const selected = catalog.views.find((view) => view.viewId === catalog.selectedViewId) ?? null;
    async function apply(command: CorpusSavedViewCommandV1) {
      const result = await mutateTriageSavedViews(deps, command);
      if (result.status !== 'applied') return false;
      setCatalog(result.value);
      if (command.kind === 'select') {
        const view = result.value.views.find((entry) => entry.viewId === result.value.selectedViewId);
        if (view) setLens(view);
      }
      return true;
    }
    const revision = () => account.revision(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1);
    const { control, details } = useTriageViewsControl({
      views: catalog.views, selectedViewId: catalog.selectedViewId,
      status: readTriageSavedViewLensStatusV1({ selected, lens }),
      namesUnavailableSources: false, busy: false, unavailableReason: null,
      unreadable: false, notice: null, text: (_key, fallback) => fallback,
      onSelectView: (viewId) => { void apply({ kind: 'select', viewId, expectedRevision: revision() }); },
      onCreateView: (label) => apply({ ...lens, kind: 'create', label, select: true, expectedRevision: revision() }),
      onRenameView: (view, label) => apply(triageRenameSavedViewInputV1(view, label, revision())),
      onUpdateView: (view) => { void apply(triageUpdateSavedViewInputV1(view, lens, revision())); },
      onDeleteView: (view) => { void apply({ kind: 'delete', viewId: view.viewId, expectedRevision: revision() }); },
    });
    return <>{control}{details}<Text>{lens.query}</Text><Button title="Edit lens" onPress={() => {
      setLens({ ...lens, query: 'changed', order: 'newest', view: 'list' });
    }} /></>;
  }
  let fixture!: PluginUiTestkit;
  await act(async () => { fixture = await createPluginUiTestkit({
    identity: { instanceId: 'triage-views', mountNonce: 'triage-views' },
    authorPlugin: { id: 'happier.triage', version: '0.0.0' },
    surface: defineUiSurface(() => <Surface />), surfaceContext: createSurfaceContextFixture(),
    adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
  }); });
  mounted.push(fixture);
  const press = async (name: string) => { await act(async () => { await fixture.press(await fixture.getByRole('button', { name })); }); };
  const stored = async () => (await readTriageSavedViews(deps)).value;
  await pressToolbarMenuItem(fixture, 'Views', 'menuitem', 'Save as new view');
  await typeName('My review');
  expect(await stored()).toEqual(CORPUS_EMPTY_SAVED_VIEWS_V1);
  await press('Save view');
  const created = await stored();
  expect(created.selectedViewId).toBe(created.views[0]?.viewId);
  expect(created.views[0]).toMatchObject({ label: 'My review', ...initialLens });
  await press('Edit lens');
  expect(await stored()).toEqual(created);
  await pressToolbarMenuItem(fixture, 'Views', 'menuitem', 'Rename');
  await typeName('Renamed review');
  await press('Save view');
  expect((await stored()).views[0]).toMatchObject({ label: 'Renamed review', ...initialLens });
  await pressToolbarMenuItem(fixture, 'Views', 'menuitem', 'Update this view');
  expect((await stored()).views[0]).toMatchObject({ label: 'Renamed review', query: 'changed', order: 'newest', view: 'list' });
  await pressToolbarMenuItem(fixture, 'Views', 'menuitemradio', 'No saved view');
  expect((await stored()).selectedViewId).toBeNull();
  await pressToolbarMenuItem(fixture, 'Views', 'menuitemradio', 'Renamed review');
  expect((await stored()).selectedViewId).toBe(created.selectedViewId);
  await pressToolbarMenuItem(fixture, 'Views', 'menuitem', 'Delete');
  expect(await stored()).toEqual(CORPUS_EMPTY_SAVED_VIEWS_V1);
});

it('withdraws Triage’s private naming draft when the captured Account host changes while a save is pending', async () => {
  const accounts = { a: createTestkitAccountKv(), b: createTestkitAccountKv() };
  let acceptA: (() => void) | undefined;
  const pendingA = new Promise<void>((resolve) => { acceptA = resolve; });
  function TriageControl({ account }: { account: 'a' | 'b' }) {
    const boundary = accounts[account];
    const { control, details } = useTriageViewsControl({
      views: [], selectedViewId: null, status: 'unsaved', namesUnavailableSources: false,
      busy: false, unavailableReason: null, unreadable: false, notice: null,
      text: (_key, fallback) => fallback,
      onSelectView: () => undefined,
      onCreateView: async (label) => {
        if (account === 'a') await pendingA;
        const result = await mutateTriageSavedViews({
          catalog: boundary.catalog(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1),
          mintViewId: () => '00000001-0000-4000-8000-000000000000',
        }, {
          kind: 'create', label, select: true, expectedRevision: boundary.revision(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1),
          query: '', filters: TRIAGE_LIST_NO_FILTERS_V1, order: 'newest', smartPolicy: CORPUS_DEFAULT_SMART_POLICY_V1,
        });
        return result.status === 'applied';
      },
      onRenameView: async () => false, onUpdateView: () => undefined, onDeleteView: () => undefined,
    });
    return <>{control}{details}</>;
  }
  const surface = defineUiSurface((context) => {
    const [account, setAccount] = React.useState<'a' | 'b'>('a');
    // Host boundary: production rebuilds this facade for a new captured Account
    // (PluginSurfaceHost canonicalHostApiAdapter depends on Account lifetime).
    const hostApi = React.useMemo(() => ({ ...context.hostApi }), [account, context.hostApi]);
    return <PluginUiProvider hostApi={hostApi} context={context.surface}>
      <TriageControl account={account} />
      <Button title="Switch Account" onPress={() => setAccount('b')} />
    </PluginUiProvider>;
  });
  let fixture!: PluginUiTestkit;
  await act(async () => { fixture = await createPluginUiTestkit({
    identity: { instanceId: 'triage-account', mountNonce: 'triage-account' },
    authorPlugin: { id: 'happier.triage', version: '0.0.0' },
    surface, surfaceContext: createSurfaceContextFixture(),
    adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
  }); });
  mounted.push(fixture);
  const press = async (name: string) => { await act(async () => { await fixture.press(await fixture.getByRole('button', { name })); }); };
  await pressToolbarMenuItem(fixture, 'Views', 'menuitem', 'Save as new view');
  await typeName('Private Account A');
  await press('Save view');
  await press('Switch Account');
  expect(await fixture.queryByRole('textbox', { name: 'View name' })).toBeUndefined();
  await pressToolbarMenuItem(fixture, 'Views', 'menuitem', 'Save as new view');
  await typeName('Private Account B');
  await act(async () => { acceptA?.(); });
  expect(document.querySelector('input')?.value).toBe('Private Account B');
  expect(accounts.a.read(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1)).toMatchObject({ views: [{ label: 'Private Account A' }] });
  expect(accounts.b.read(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1)).toBeUndefined();
});
