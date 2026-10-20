import { act } from 'react';
import { describe, expect, it } from 'vitest';
import * as publicComponents from '@happier-dev/plugin-ui/components';

import { ReplyQuoteExample } from '../../fixtures/external-authoring/src/replyQuoteSurface.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';

describe('external author reply quotes', () => {
  it('opens each admitted source and removes both private text and navigation when it becomes unavailable', () => {
    expect(typeof publicComponents.ReplyQuote).toBe('function');
    const context = createSurfaceContext();
    const mounted = mountThroughReactNativeWeb(<PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <ReplyQuoteExample />
    </PluginUiProvider>);
    for (const [id, destination] of [['message', 'message'], ['doc', 'document'], ['task', 'task']]) {
      const quote = mounted.container.querySelector(`[data-testid="author-${id}-quote"]`);
      expect(quote?.getAttribute('role')).toBe('link');
      act(() => (quote as HTMLElement).click());
      expect(mounted.container.textContent).toContain(`Opened ${destination}`);
    }
    expect(mounted.container.textContent).toContain('Private selected passage.');
    const withdraw = [...mounted.container.querySelectorAll('[role="button"]')].find(node => node.textContent?.includes('Withdraw'));
    act(() => (withdraw as HTMLElement).click());
    const unavailable = mounted.container.querySelector('[data-testid="author-doc-quote"]');
    expect(unavailable?.textContent).toContain('Source unavailable');
    expect(mounted.container.textContent).not.toContain('Private selected passage.');
    expect(unavailable?.getAttribute('role')).not.toBe('link');
    act(() => (unavailable as HTMLElement).click());
    expect(mounted.container.textContent).toContain('Opened task');
    mounted.unmount();
  });
});
