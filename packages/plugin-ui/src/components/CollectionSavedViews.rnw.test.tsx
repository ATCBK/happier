import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '../testing/index.js';
import { useCollectionSavedViewsControl } from './index.js';
import { defineUiSurface } from '../surfaceEntry.js';

const mounted: PluginUiTestkit[] = [];
afterEach(async () => { for (const fixture of mounted.splice(0)) await fixture.dispose(); });

const labels = {
  title: 'Spaces', unselected: 'No space', actions: 'Space actions', create: 'New space',
  rename: 'Rename', update: 'Update', delete: 'Delete', modified: 'Filtered',
  name: 'Space name', confirm: 'Save space', cancel: 'Cancel',
};

async function press(fixture: PluginUiTestkit, role: 'button' | 'menuitem' | 'menuitemradio', name: string) {
  await act(async () => { await fixture.press(await fixture.getByRole(role, { name })); });
}

async function typeName(value: string) {
  // Text input is a DOM boundary; the semantic testkit currently supports presses only.
  const field = document.querySelector('input');
  expect(field).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the public controlled collection saved-view presentation', () => {
  it('selects typed items and preserves a refused name until acceptance, without writing on edit or cancel', async () => {
    const writes: string[] = [];
    let accept = false;
    function Surface() {
      const [items, setItems] = React.useState([{ id: 'review', label: 'Review', filter: 'open' }]);
      const [selectedId, setSelectedId] = React.useState<string | null>(null);
      const { control, details } = useCollectionSavedViewsControl({
        items, selectedId, modified: false, labels,
        onSelect: setSelectedId,
        onCreate: async (label) => {
          writes.push(label);
          if (!accept) return false;
          setItems((current) => [...current, { id: 'new', label, filter: 'new' }]);
          setSelectedId('new');
          return true;
        },
        onRename: async (item, label) => {
          writes.push(item.filter);
          setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, label } : entry));
          return true;
        },
        onUpdate: () => undefined,
        onDelete: () => undefined,
      });
      return <>{control}{details}</>;
    }
    let fixture!: PluginUiTestkit;
    await act(async () => { fixture = await createPluginUiTestkit({
      identity: { instanceId: 'saved-views', mountNonce: 'saved-views' },
      authorPlugin: { id: 'happier.example', version: '0.0.0' },
      surface: defineUiSurface(() => <Surface />),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
    }); });
    mounted.push(fixture);
    await press(fixture, 'button', 'Spaces: No space');
    await press(fixture, 'menuitemradio', 'Review');
    await press(fixture, 'button', 'Spaces: Review');
    await press(fixture, 'menuitem', 'Rename');
    await typeName('Renamed');
    expect(writes).toEqual([]);
    await press(fixture, 'button', 'Save space');
    expect(writes).toEqual(['open']);
    await press(fixture, 'button', 'Spaces: Renamed');
    await press(fixture, 'menuitem', 'New space');
    await typeName('Mine');
    await press(fixture, 'button', 'Save space');
    await expect(fixture.getByRole('textbox', { name: 'Space name' })).resolves.toBeDefined();
    accept = true;
    await press(fixture, 'button', 'Save space');
    await expect(fixture.getByRole('button', { name: 'Spaces: Mine' })).resolves.toBeDefined();
    await press(fixture, 'button', 'Spaces: Mine');
    await press(fixture, 'menuitem', 'New space');
    await press(fixture, 'button', 'Cancel');
    expect(writes).toEqual(['open', 'Mine', 'Mine']);
  });
});
