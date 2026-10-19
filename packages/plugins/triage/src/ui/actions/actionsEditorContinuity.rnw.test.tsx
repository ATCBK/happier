// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { administerTriageAction, readTriageActionsForSurface } from '../../actions/actionsCatalog.js';
import {
  TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1,
  TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1,
  TriageAdministerActionInputV1Schema,
} from '../../actions/actionsCatalogProtocol.js';
import { TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1 } from '../../settings/actions.js';
import { createTestkitAccountKv } from '../../settings/testkit/accountKv.test-support.js';
import { TriageActionsEditor } from './ActionsEditor.js';
import { useTriageActions } from './useTriageActions.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: PluginUiTestkit[] = [];
const editorSurface = defineUiSurface(() => <TriageActionsEditor actions={useTriageActions()} />);

async function mountEditor() {
  const account = createTestkitAccountKv();
  const deps = { catalog: account.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1), mintActionId: () => 'custom-action' };
  let release!: () => void;
  let settlement: 'apply' | 'fail' = 'apply';
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-editor-continuity', mountNonce: 'fixture-editor-continuity' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: editorSurface,
      surfaceContext: createSurfaceContextFixture({}),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        // Only the Action transport and Account KV boundaries are replaced;
        // the hook, command parser, catalog mutation and revision CAS stay real.
        executeAction: async ({ action, input }) => {
          const actionId = typeof action === 'string' ? action : action.localId;
          if (actionId === TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1) {
            return await readTriageActionsForSurface({ v: 1 }, deps);
          }
          if (actionId === TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1) {
            await pending;
            if (settlement === 'fail') throw new Error('Account transport unavailable');
            return await administerTriageAction(TriageAdministerActionInputV1Schema.parse(input), deps);
          }
          throw new Error('Unrelated catalog is unavailable');
        },
      },
    });
  });
  mounted.push(fixture);
  await act(async () => { await Promise.resolve(); });
  return {
    fixture,
    account,
    async settle(outcome: 'apply' | 'fail' = 'apply') {
      settlement = outcome;
      await act(async () => { release(); await pending; });
    },
    async read() { return await readTriageActionsForSurface({ v: 1 }, deps); },
  };
}

async function press(fixture: PluginUiTestkit, name: string) {
  await act(async () => {
    const controls = await fixture.getAllByRole('button');
    // Item includes its description in the accessible name, while standalone
    // Save/Cancel controls carry only their label.
    const control = controls.find((candidate) => candidate.name === name)
      ?? controls.find((candidate) => candidate.name?.startsWith(name));
    expect(control, JSON.stringify(controls.map((candidate) => candidate.name))).toBeDefined();
    await fixture.press(control!);
  });
}

function nameField(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('input[aria-label="Name"]');
}

async function typeName(value: string) {
  const field = nameField();
  expect(field).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(nameField()?.value).toBe(value);
}

afterEach(async () => {
  for (const fixture of mounted.splice(0)) await act(async () => { await fixture.dispose(); });
});

describe('action editor draft settlement', () => {
  it('keeps newer update input and saves it against the acknowledged revision', async () => {
    const editor = await mountEditor();
    await press(editor.fixture, 'Ask');
    await typeName('Submitted name');
    await press(editor.fixture, 'Save');
    await typeName('Newer name');
    await editor.settle();

    expect(nameField()?.value).toBe('Newer name');
    expect((await editor.read()).actions.find((action) => action.actionId === 'ask')?.label).toBe('Submitted name');
    expect((await editor.fixture.getByRole('button', { name: 'Save' })).state?.disabled).not.toBe(true);
    await press(editor.fixture, 'Save');
    expect((await editor.read()).actions.find((action) => action.actionId === 'ask')?.label).toBe('Newer name');
    expect(nameField()).toBeNull();
  });

  it('keeps newer create input until the person explicitly cancels it', async () => {
    const editor = await mountEditor();
    await press(editor.fixture, 'Add an action');
    await typeName('Submitted creation');
    await press(editor.fixture, 'Save');
    await typeName('Next creation');
    await editor.settle();

    expect(nameField()?.value).toBe('Next creation');
    expect((await editor.read()).actions.find((action) => action.actionId === 'custom-action')?.label).toBe('Submitted creation');
    await press(editor.fixture, 'Cancel');
    await press(editor.fixture, 'Add an action');
    expect(nameField()?.value).toBe('');
  });

  it('does not restore a cancelled pending draft or clear a reopened editor', async () => {
    const editor = await mountEditor();
    await press(editor.fixture, 'Ask');
    await typeName('Submitted name');
    await press(editor.fixture, 'Save');
    await press(editor.fixture, 'Cancel');
    expect(nameField()).toBeNull();
    await editor.settle();
    expect(nameField()).toBeNull();
    await press(editor.fixture, 'Submitted name');
    expect(nameField()?.value).toBe('Submitted name');
    await typeName('Reopened name');
    await press(editor.fixture, 'Cancel');
    await press(editor.fixture, 'Submitted name');
    expect(nameField()?.value).toBe('Submitted name');
  });

  it.each(['conflict', 'fail'] as const)('retains exact newer input after %s', async (outcome) => {
    const editor = await mountEditor();
    await press(editor.fixture, 'Ask');
    await typeName('Submitted name');
    await press(editor.fixture, 'Save');
    await typeName('  Newer unsaved name  ');
    if (outcome === 'conflict') {
      editor.account.seed(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1, { v: 1, actions: [] });
    }
    await editor.settle(outcome === 'fail' ? 'fail' : 'apply');

    expect(nameField()?.value).toBe('  Newer unsaved name  ');
    expect((await editor.read()).actions.find((action) => action.actionId === 'ask')?.label).toBe('Ask');
    expect((await editor.fixture.getByRole('button', { name: 'Save' })).state?.disabled).toBe(true);
  });
});
