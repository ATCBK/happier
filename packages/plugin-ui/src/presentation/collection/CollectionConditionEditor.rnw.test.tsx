import { act } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { describe, expect, it } from 'vitest';
import { createWorkflowListFilterRegistryV1 } from '@happier-dev/protocol/workflows/listing/workflowListFilterV1';
import { admitPluginListFilterFieldV1 } from '@happier-dev/protocol/collections/filter/pluginListFilterFieldV1';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import {
  applyCollectionConditionEdit,
  conditionModelFromFilter,
  type CollectionConditionEdit,
} from './conditionModel.js';
import {
  HappierCollectionConditionEditor,
  type HappierCollectionConditionEditorHost,
  type HappierCollectionConditionEditorLabels,
} from './CollectionConditionEditor.js';

// The host primitives are the injected boundary; the editor's anatomy and edits under test are its own.
const host: HappierCollectionConditionEditorHost = {
  Text: (props) => <Text testID={props.testID}>{props.children}</Text>,
  Icon: (props) => <View testID={`icon-${props.name}`} />,
  SearchField: (props) => (
    <TextInput
      testID={props.testID ?? 'search'}
      value={props.value}
      placeholder={props.placeholder}
    />
  ),
  Button: (props) => (
    <Pressable testID={props.testID} onPress={props.onPress}>
      <Text>{props.label}</Text>
    </Pressable>
  ),
  useColors: () => ({
    fill: '#eee',
    fillHover: '#ddd',
    divider: '#ccc',
    focus: '#00f',
  }),
};

const labels: HappierCollectionConditionEditorLabels = {
  title: 'Filter',
  clear: 'Clear',
  add: 'Add filter',
  addSearch: 'Filter by…',
  back: 'Back',
  or: 'or',
  operators: {
    is: 'is',
    is_not: "isn't",
    before: 'before',
    after: 'after',
    between: 'between',
    unavailable: 'unavailable',
  },
  remove: (field) => `Remove ${field}`,
  count: (count) => `${count} items`,
  countPartial: (count) => `${count} loaded`,
  saveAsSpace: 'Save as space…',
  done: 'Done',
  noFields: 'No fields',
  noValues: 'No values',
};

function stageField() {
  const admitted = admitPluginListFilterFieldV1({
    pluginId: 'test.release',
    factKeys: new Set(['stage']),
    field: {
      id: 'stage',
      title: 'Release stage',
      source: { factKey: 'stage' },
      value: {
        kind: 'set',
        options: [
          { value: 'ready', title: 'Ready' },
          { value: 'blocked', title: 'Blocked' },
        ],
      },
    },
  });
  if (admitted.kind !== 'admitted') throw new Error('Invalid fixture');
  return admitted.field;
}

const press = (container: HTMLElement, testID: string) =>
  act(() => {
    (
      container.querySelector(`[data-testid="${testID}"]`) as HTMLElement
    ).click();
  });

describe('HappierCollectionConditionEditor', () => {
  it('adds, narrows, flips and removes a plugin-owned condition as edits its owner applies', async () => {
    const stage = stageField();
    const registry = createWorkflowListFilterRegistryV1([stage]);
    const bindings = {
      fields: {
        [stage.id]: {
          label: 'Release stage',
          valueOptions: [
            { value: 'ready', label: 'Ready' },
            { value: 'blocked', label: 'Blocked' },
          ],
        },
      },
    };
    let filter: Parameters<typeof applyCollectionConditionEdit>[1] = {
      view: 'all' as const,
    };
    const edits: CollectionConditionEdit[] = [];
    const view = () => (
      <HappierCollectionConditionEditor
        host={host}
        labels={labels}
        model={conditionModelFromFilter(registry, filter, bindings)}
        onChange={(edit) => {
          edits.push(edit);
          filter = applyCollectionConditionEdit(registry, filter, edit);
        }}
        result={{ matchedCount: 3, coverage: 'complete' }}
      />
    );
    const mount = mountThroughReactNativeWeb(view());
    expect(
      mount.container.querySelector('[data-testid="collection-filter-count"]')
        ?.textContent,
    ).toBe('3 items');

    await press(mount.container, 'collection-filter-add');
    await press(mount.container, `collection-filter-field:${stage.id}`);
    await press(mount.container, `collection-filter-value:${stage.id}:ready`);
    expect(edits.at(-1)).toEqual({
      type: 'add',
      condition: { fieldId: stage.id, operator: 'is', values: ['ready'] },
    });
    await mount.render(view());
    // A set field stays open for more; a second value joins the same condition.
    await press(mount.container, `collection-filter-value:${stage.id}:blocked`);
    expect(edits.at(-1)).toMatchObject({
      type: 'change',
      condition: { values: ['ready', 'blocked'] },
    });
    await mount.render(view());
    await press(mount.container, 'collection-filter-back');
    expect(mount.container.textContent).toContain('Ready');
    expect(mount.container.textContent).toContain('Blocked');

    await press(
      mount.container,
      `collection-filter-condition:${stage.id}:is:operator`,
    );
    expect(edits.at(-1)).toMatchObject({
      type: 'change',
      condition: { operator: 'is_not' },
    });
    await mount.render(view());
    await press(
      mount.container,
      `collection-filter-condition:${stage.id}:is_not:remove`,
    );
    expect(edits.at(-1)).toMatchObject({ type: 'remove' });
    await mount.render(view());
    expect(
      mount.container.querySelector(
        `[data-testid^="collection-filter-condition:${stage.id}"]`,
      ),
    ).toBeNull();
    mount.unmount();
  });

  it('keeps a locked base row without its remove, hides base-equal rows, and edits a hidden row when its field is added', async () => {
    const registry = createWorkflowListFilterRegistryV1([]);
    const edits: CollectionConditionEdit[] = [];
    const model = conditionModelFromFilter(
      registry,
      { view: 'triggered' as const },
      {},
    );
    const viewRow = model.rows.find((row) => row.fieldId === 'view')!;
    const mount = mountThroughReactNativeWeb(
      <HappierCollectionConditionEditor
        host={host}
        labels={labels}
        model={model}
        onChange={(edit) => edits.push(edit)}
        lockedFieldIds={new Set(['view'])}
      />,
    );
    expect(
      mount.container.querySelector(
        '[data-testid="collection-filter-condition:view:is"]',
      ),
    ).not.toBeNull();
    expect(
      mount.container.querySelector(
        '[data-testid="collection-filter-condition:view:is:remove"]',
      ),
    ).toBeNull();

    await mount.render(
      <HappierCollectionConditionEditor
        host={host}
        labels={labels}
        model={model}
        onChange={(edit) => edits.push(edit)}
        hiddenFieldIds={new Set(['view'])}
      />,
    );
    expect(
      mount.container.querySelector(
        '[data-testid="collection-filter-condition:view:is"]',
      ),
    ).toBeNull();
    await press(mount.container, 'collection-filter-add');
    await press(mount.container, 'collection-filter-field:view');
    await press(mount.container, 'collection-filter-value:view:running');
    expect(edits.at(-1)).toEqual({
      type: 'change',
      rowId: viewRow.id,
      condition: { fieldId: 'view', operator: 'is', values: ['running'] },
    });
    mount.unmount();
  });
});
