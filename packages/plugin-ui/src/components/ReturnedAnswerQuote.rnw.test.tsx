import { act } from 'react';
import { describe, expect, it } from 'vitest';
import * as publicComponents from '@happier-dev/plugin-ui/components';

import { ReturnedAnswerQuoteExample } from '../../fixtures/external-authoring/src/returnedAnswerQuoteSurface.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';

function press(container: HTMLElement, label: string) {
  const target = [...container.querySelectorAll('[role="button"]')].find(node => node.textContent === label);
  expect(target, label).toBeTruthy();
  act(() => (target as HTMLElement).click());
}

describe('external author returned answers', () => {
  it('quotes the answer as information under its answerer and outcome, and discloses the exact question on demand', () => {
    expect(typeof publicComponents.ReturnedAnswerQuote).toBe('function');
    const context = createSurfaceContext();
    const mounted = mountThroughReactNativeWeb(<PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <ReturnedAnswerQuoteExample />
    </PluginUiProvider>);
    const answer = mounted.container.querySelector('[data-testid="author-answer"]') as HTMLElement;
    expect(answer.textContent).toContain('Checkout UI retry states');
    expect(answer.textContent).toContain('answered');
    expect(answer.textContent).toContain('A replayed charge shows Payment confirmed.');
    expect(answer.textContent).toContain('Returned as information. It isn’t asked to reply again.');
    // A failed return names its outcome and carries no body or navigation the author did not give it.
    const failed = mounted.container.querySelector('[data-testid="author-failed"]') as HTMLElement;
    expect(failed.textContent).toContain('couldn’t answer');
    expect(failed.textContent).not.toContain('Open');
    expect(failed.textContent).not.toContain('Your question');

    press(answer, 'Open');
    expect(mounted.container.textContent).toContain('Opened answerer');
    // The question line exists only while disclosed; an unreadable question offers its one recovery.
    expect(answer.textContent).not.toContain('Couldn’t load the question');
    press(answer, 'Your question');
    expect(answer.textContent).toContain('Couldn’t load the question');
    press(answer, 'Retry');
    expect(answer.textContent).toContain('Asked from here');
    press(answer, 'Open question');
    expect(mounted.container.textContent).toContain('Opened question');
    press(answer, 'Your question');
    expect(answer.textContent).not.toContain('Asked from here');
    mounted.unmount();
  });
});
