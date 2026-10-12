import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { Button, Form } from './index.js';

function mountSurface(children: ReactNode) {
  const context = createSurfaceContext();
  return mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      {children}
    </PluginUiProvider>,
  );
}

/** The section action cluster Happier's own pages use (`SectionButtonRow` is core's adapter over it). */
describe('Form.Actions: the shared section action cluster', () => {
  it('puts the trailing (irreversible) action after the others and announces a refusal under them', () => {
    const mount = mountSurface(
      <Form.Actions
        testID="actions"
        trailing={<Button testID="delete" title="Delete" variant="destructive" onPress={() => undefined} />}
        footnote="Enter a name first."
        footnoteTone="danger"
        footnoteTestID="refusal"
      >
        <Button testID="save" title="Save" onPress={() => undefined} />
        <Button testID="cancel" title="Cancel" variant="secondary" onPress={() => undefined} />
      </Form.Actions>,
    );
    const order = [...mount.container.querySelectorAll('[data-testid="actions"] [role="button"]')]
      .map((node) => node.getAttribute('data-testid'));
    expect(order).toEqual(['save', 'cancel', 'delete']);
    const refusal = mount.container.querySelector('[data-testid="refusal"]');
    expect(refusal?.getAttribute('role')).toBe('alert');
    expect(refusal?.textContent).toBe('Enter a name first.');
    mount.unmount();
  });

  it('keeps a consequence note static and draws no line without one', () => {
    const note = mountSurface(
      <Form.Actions footnote="Deleting removes the Team for everyone." footnoteTestID="note">
        <Button title="Delete" onPress={() => undefined} />
      </Form.Actions>,
    );
    expect(note.container.querySelector('[data-testid="note"]')?.getAttribute('role')).toBeNull();
    note.unmount();
    const bare = mountSurface(<Form.Actions footnote={null} footnoteTestID="note"><Button title="Save" onPress={() => undefined} /></Form.Actions>);
    expect(bare.container.querySelector('[data-testid="note"]')).toBeNull();
    bare.unmount();
  });
});
