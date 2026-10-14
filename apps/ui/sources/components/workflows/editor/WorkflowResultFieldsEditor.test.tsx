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

const confirm = vi.fn(async () => true);

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

/** Renders the editor over a live draft so every change feeds the next render, as the host does. */
async function renderLive(initial: WorkflowEditorDraft, blockId: string) {
  let draft = initial;
  let screen: Awaited<ReturnType<typeof renderScreen>>;
  const element = () => {
    const block = findWorkflowBlock(draft, blockId) as Extract<
      WorkflowBlock,
      { kind: 'step' }
    >;
    return (
      <WorkflowResultFieldsEditor
        draft={draft}
        block={block}
        onChange={(next) => {
          draft = next as WorkflowEditorDraft;
          screen.update(element());
        }}
        testIDPrefix="opts"
      />
    );
  };
  screen = await renderScreen(element());
  return { screen: () => screen, draft: () => draft };
}

describe('WorkflowResultFieldsEditor', () => {
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

  it('lets a reference pick a named field from its producer', async () => {
    const result = buildWorkflowResultFieldsContract([
      { name: 'fixed', type: 'boolean', required: true },
    ]);
    const draft = createWorkflowEditorDraft({
      draftId: 'd',
      name: 'Release',
      blocks: [step('check', { result })],
    });
    const changes: unknown[] = [];
    const screen = await renderScreen(
      <WorkflowResultFieldPathInput
        draft={draft}
        testID="ref"
        reference={{
          kind: 'result',
          producer: { blockId: 'check', scope: { kind: 'current' } },
          path: [],
        }}
        onChange={(next) => changes.push(next)}
      />,
    );
    const select = byTestID(screen.root, 'ref-field', 'onSelect');
    expect(select.props.items.map((item: { id: string }) => item.id)).toEqual([
      'whole',
      'fixed',
      'other',
    ]);
    await act(async () => {
      select.props.onSelect('fixed');
    });
    expect(changes.at(-1)).toMatchObject({ path: ['fixed'] });
  });
});
