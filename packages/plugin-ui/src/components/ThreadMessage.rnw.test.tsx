import { act } from 'react';
import { describe, expect, it } from 'vitest';
import * as publicComponents from '@happier-dev/plugin-ui/components';

import { ThreadExample } from '../../fixtures/external-authoring/src/threadSurface.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';

describe('external author thread presentation', () => {
  it('groups attribution while retaining every message, status and author-owned control', () => {
    expect(typeof publicComponents.ThreadMessage).toBe('function');
    const context = createSurfaceContext();
    const mounted = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <ThreadExample />
      </PluginUiProvider>,
    );
    const first = mounted.container.querySelector('[data-testid="author-thread-first"]');
    const next = mounted.container.querySelector('[data-testid="author-thread-next"]');
    expect(first?.textContent).toContain('Mara');
    expect(first?.textContent).toContain('Keep the original question with the answer.');
    expect(first?.textContent).toContain('Waiting for the participant');
    expect(next?.textContent).toBe('And preserve the next message.');
    const select = mounted.container.querySelector('[role="button"]');
    expect(select).toBeInstanceOf(HTMLElement);
    act(() => (select as HTMLElement).click());
    expect(mounted.container.textContent).toContain('Message selected');
    expect(next?.textContent).toBe('And preserve the next message.');
    mounted.unmount();
  });
});
