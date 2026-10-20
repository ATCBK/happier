import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactTestInstance } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import type {
  WorkflowBlock,
  WorkflowStep,
} from '@happier-dev/protocol/workflows/workflowV1';
import { findWorkflowBlock } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import {
  buildWorkflowResultFieldsContract,
  projectWorkflowResultFields,
} from '@happier-dev/protocol/workflows/workflowResultFieldsV1';
import type { WorkflowAuthoredResultReference } from '@happier-dev/protocol/workflows/workflowReferenceV1';
import {
  createWorkflowEditorDraft,
  type WorkflowEditorDraft,
} from '@/sync/domains/workflows/workflowEditorDraft';
import { WorkflowResultFieldsEditor } from './WorkflowResultFieldsEditor';
import { WorkflowResultFieldPathInput } from './WorkflowStepDataEditor';

/**
 * Result → Named fields (04 §6.1, lab S5): the editor writes the protocol's
 * named-field contract, never rewrites an advanced schema, and renaming a field
 * that later steps read asks first, then repairs every reader in one change.
 */

const { confirm } = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }));

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ spies: { confirm } }).module;
});
vi.mock('@/components/ui/popover/Popover', async (importOriginal) =>
  (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(
    importOriginal,
  ),
);

afterEach(async () => {
  confirm.mockClear();
  await standardCleanup();
});

function step(id: string, extra: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    kind: 'step',
    id,
    document: { text: 'Do it', references: [], attachments: [] },
    input: [],
    result: { kind: 'text' },
    ...extra,
  };
}

function byTestID(
  root: ReactTestInstance,
  testID: string,
  prop: string,
): ReactTestInstance {
  const match = root.findAll(
    (node) =>
      node.props?.testID === testID && typeof node.props?.[prop] === 'function',
  )[0];
  if (match === undefined) throw new Error(`No ${prop} on ${testID}`);
  return match;
}

/** Renders the editor over a live draft held in state, as the host does, so every change feeds the next render. */
async function renderLive(initial: WorkflowEditorDraft, blockId: string) {
  let draft = initial;
  function Host() {
    const [current, setCurrent] = React.useState(initial);
    const block = findWorkflowBlock(current, blockId) as Extract<
      WorkflowBlock,
      { kind: 'step' }
    >;
    return (
      <WorkflowResultFieldsEditor
        draft={current}
        block={block}
        onChange={(next) => {
          draft = next as WorkflowEditorDraft;
          setCurrent(draft);
        }}
        testIDPrefix="opts"
      />
    );
  }
  const screen = await renderScreen(<Host />);
  return { screen: () => screen, draft: () => draft };
}

describe('WorkflowResultFieldsEditor', () => {
  it('refuses the unsupported name with the existing invalid-name state and preserves the draft', async () => {
    const initial = createWorkflowEditorDraft({ draftId: 'd', name: 'Release', blocks: [step('check', {
      result: buildWorkflowResultFieldsContract([{ name: 'fixed', type: 'boolean', required: true }]),
    })] });
    const live = await renderLive(initial, 'check');
    await act(async () => { byTestID(live.screen().root, 'opts-result-field-fixed-header', 'onPress').props.onPress(); });
    await act(async () => { byTestID(live.screen().root, 'opts-result-field-fixed-name', 'onChangeText').props.onChangeText('__proto__'); });
    expect(byTestID(live.screen().root, 'opts-result-field-fixed-name', 'onChangeText').props.error)
      .toBe('workflows.page.inspector.resultFields.nameInvalid');
    await act(async () => { byTestID(live.screen().root, 'opts-result-field-fixed-name', 'onBlur').props.onBlur(); });
    expect(live.draft()).toBe(initial);
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each([false, true])('leaves a retained unsupported result name advanced and untouched (required=%s)', async (required) => {
    const result = buildWorkflowResultFieldsContract([{ name: '__proto__', type: 'text', required }]);
    const before = JSON.stringify(result);
    const live = await renderLive(createWorkflowEditorDraft({ draftId: 'd', name: 'Release', blocks: [step('check', { result })] }), 'check');
    expect(live.screen().root.findAll((node) => node.props?.testID === 'opts-result-advanced').length).toBeGreaterThan(0);
    expect(live.screen().root.findAll((node) => node.props?.testID === 'opts-result-add-field')).toHaveLength(0);
    expect((findWorkflowBlock(live.draft(), 'check') as WorkflowStep).result).toBe(result);
    expect(JSON.stringify(result)).toBe(before);
  });

  it('turns Text into named fields, adds, types and requires them through the shared contract', async () => {
    const live = await renderLive(
      createWorkflowEditorDraft({
        draftId: 'd',
        name: 'Release',
        blocks: [step('check')],
      }),
      'check',
    );
    const tabs = live
      .screen()
      .root.findAll(
        (node) => typeof node.props?.onSelectTab === 'function',
      )[0]!;
    await act(async () => {
      tabs.props.onSelectTab('fields');
    });
    await act(async () => {
      byTestID(
        live.screen().root,
        'opts-result-add-field',
        'onPress',
      ).props.onPress();
    });
    await act(async () => {
      byTestID(
        live.screen().root,
        'opts-result-field-field2-type',
        'onSelect',
      ).props.onSelect('choice');
    });
    await act(async () => {
      byTestID(
        live.screen().root,
        'opts-result-field-field2-choices-new',
        'onChangeText',
      ).props.onChangeText('high');
    });
    await act(async () => {
      byTestID(
        live.screen().root,
        'opts-result-field-field2-choices-new',
        'onSubmitEditing',
      ).props.onSubmitEditing();
    });
    await act(async () => {
      byTestID(
        live.screen().root,
        'opts-result-field-field-required',
        'onValueChange',
      ).props.onValueChange(false);
    });
    const block = findWorkflowBlock(live.draft(), 'check');
    expect(
      block?.kind === 'step' ? projectWorkflowResultFields(block.result) : null,
    ).toEqual({
      kind: 'fields',
      closed: true,
      fields: [
        { name: 'field', type: 'text', required: false },
        { name: 'field2', type: 'choice', required: true, choices: ['high'] },
      ],
    });
  });

  it('describes an advanced schema and leaves it byte-identical', async () => {
    const advanced = {
      kind: 'json' as const,
      schema: {
        type: 'object' as const,
        properties: { n: { type: 'integer' as const } },
      },
    };
    const live = await renderLive(
      createWorkflowEditorDraft({
        draftId: 'd',
        name: 'Release',
        blocks: [step('check', { result: advanced })],
      }),
      'check',
    );
    expect(
      live
        .screen()
        .root.findAll((node) => node.props?.testID === 'opts-result-advanced')
        .length,
    ).toBeGreaterThan(0);
    expect(
      live
        .screen()
        .root.findAll((node) => node.props?.testID === 'opts-result-add-field'),
    ).toHaveLength(0);
    expect(
      (findWorkflowBlock(live.draft(), 'check') as WorkflowStep).result,
    ).toBe(advanced);
  });

  it('asks before renaming a field later steps read, then renames it everywhere in one change', async () => {
    const result = buildWorkflowResultFieldsContract([
      { name: 'fixed', type: 'boolean', required: true },
    ]);
    const reader = step('reopen', {
      input: [
        {
          kind: 'result',
          producer: { blockId: 'check', scope: { kind: 'current' } },
          path: ['fixed'],
        },
      ],
    });
    const live = await renderLive(
      createWorkflowEditorDraft({
        draftId: 'd',
        name: 'Release',
        blocks: [step('check', { result }), reader],
      }),
      'check',
    );
    // The row names who reads it.
    const header = byTestID(
      live.screen().root,
      'opts-result-field-fixed-header',
      'onPress',
    );
    expect(header.props.detail).toContain(
      'workflows.page.inspector.resultFields.usedBy',
    );
    await act(async () => {
      header.props.onPress();
    });
    await act(async () => {
      byTestID(
        live.screen().root,
        'opts-result-field-fixed-name',
        'onChangeText',
      ).props.onChangeText('passed');
    });
    await act(async () => {
      byTestID(
        live.screen().root,
        'opts-result-field-fixed-name',
        'onBlur',
      ).props.onBlur();
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(
      (findWorkflowBlock(live.draft(), 'reopen') as WorkflowStep).input[0],
    ).toMatchObject({ path: ['passed'] });
  });

  it('selects exact authored field names without colliding with whole-result or raw-path controls', async () => {
    const result = buildWorkflowResultFieldsContract([
      { name: 'fixed', type: 'boolean', required: true },
      { name: 'whole', type: 'boolean', required: true },
      { name: 'other', type: 'text', required: false },
    ]);
    const draft = createWorkflowEditorDraft({
      draftId: 'd',
      name: 'Release',
      blocks: [step('check', { result })],
    });
    let reference: WorkflowAuthoredResultReference = {
      kind: 'result' as const,
      producer: { blockId: 'check', scope: { kind: 'current' as const } },
      path: ['whole'],
    };
    function Host() {
      const [current, setCurrent] = React.useState(reference);
      return <WorkflowResultFieldPathInput
        draft={draft}
        testID="ref"
        reference={current}
        onChange={(next) => {
          reference = next;
          setCurrent(next);
        }}
      />;
    }
    const screen = await renderScreen(<Host />);
    const select = () => byTestID(screen.root, 'ref-field', 'onSelect');
    type Option = { id: string; title: string; testID: string };
    const options: Option[] = select().props.items;
    expect(new Set(options.map(item => item.id)).size).toBe(options.length);
    expect(new Set(options.map(item => item.testID)).size).toBe(options.length);
    const field = (name: string) => options.find(item => item.title === name)!;
    expect(select().props.selectedId).toBe(field('whole').id);
    for (const name of ['fixed', 'whole', 'other']) {
      await act(async () => { select().props.onSelect(field(name).id); });
      expect(reference.path).toEqual([name]);
      expect(select().props.selectedId).toBe(field(name).id);
      expect(screen.root.findAll(node => node.props.testID === 'ref' && typeof node.props.onChangeText === 'function')).toHaveLength(0);
    }
    await act(async () => { select().props.onSelect(options[0]!.id); });
    expect(reference.path).toEqual([]);
    expect(select().props.selectedId).toBe(options[0]!.id);
    await act(async () => { select().props.onSelect(options.at(-1)!.id); });
    expect(reference.path).toEqual([]);
    expect(select().props.selectedId).toBe(options.at(-1)!.id);
    await act(async () => { byTestID(screen.root, 'ref', 'onChangeText').props.onChangeText('nested.value'); });
    expect(reference.path).toEqual(['nested', 'value']);
  });
});
