import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { CapabilityKitExample } from '../../fixtures/external-authoring/src/capabilityKitSurface.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';

const byId = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('external author capability kit', () => {
  it('speaks the most blocking status with its fix, keeps healthy rows quiet, and clears once fixed', () => {
    const onSignIn = vi.fn();
    const context = createSurfaceContext();
    const mounted = mountThroughReactNativeWeb(<PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <CapabilityKitExample onSignIn={onSignIn} />
    </PluginUiProvider>);
    try {
      const header = byId(mounted.container, 'author-capability.header')!;
      expect(header.textContent).toContain('Linear');
      expect(header.textContent).toContain('Runs scripts');
      expect(header.textContent).toContain('12 tools');
      expect(header.textContent).toContain('2.4k tokens a turn');
      expect(header.textContent).toContain('ext/linear');
      // Sign-in blocks more than the update: the header and the notice speak it.
      expect(byId(mounted.container, 'author-capability.header.status')!.textContent).toContain('Needs sign-in');
      expect(byId(mounted.container, 'author-capability.banner')!.textContent).toContain('Linear is signed out');
      // A stop keeps the pill short and says its reason on its own line.
      const chip = byId(mounted.container, 'author-capability.chip')!;
      expect(chip.textContent).toContain('Stopped on build-box');
      expect(chip.textContent).toContain('node is missing');
      expect(byId(mounted.container, 'author-capability.facts')!.textContent?.replace(/\s+/gu, ' ').trim()).toBe('You · Text only · 1.2k tokens');
      // The list: a speaking status takes the facts line; a healthy row keeps its facts.
      expect(byId(mounted.container, 'author-capability.row.linear:status')!.textContent).toContain('Needs sign-in');
      expect(byId(mounted.container, 'author-capability.row.figma:status')).toBeNull();
      expect(byId(mounted.container, 'author-capability.row.figma')!.textContent).toContain('2 projects');

      const fix = [...byId(mounted.container, 'author-capability.banner')!.querySelectorAll<HTMLElement>('[role="button"]')]
        .find((node) => node.textContent === 'Sign in')!;
      act(() => fix.click());
      expect(onSignIn).toHaveBeenCalledWith('linear');
      expect(byId(mounted.container, 'author-capability.banner')).toBeNull();
      expect(byId(mounted.container, 'author-capability.header.status')).toBeNull();
    } finally { mounted.unmount(); }
  });
});
