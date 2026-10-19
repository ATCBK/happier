import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import * as publicComponents from '@happier-dev/plugin-ui/components';

import { DocEditProposalExample } from '../../fixtures/external-authoring/src/docEditProposalSurface.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';

const byId = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

function mount(executeAction: ReturnType<typeof vi.fn>) {
  const context = createSurfaceContext();
  return mountThroughReactNativeWeb(<PluginUiProvider hostApi={createHostApiStub(context, { executeAction } as never)} context={context}>
    <DocEditProposalExample />
  </PluginUiProvider>);
}

describe('external author Doc edit proposal', () => {
  it('draws the suggestion and settles only on the Doc Action’s answer', async () => {
    expect(typeof publicComponents.DocEditProposal).toBe('function');
    expect(typeof publicComponents.HappierDocEditProposal).toBe('function');
    const executeAction = vi.fn(async () => ({ docEditProposalDispositionV1: { state: 'accepted' } }));
    const mounted = mount(executeAction);
    try {
      const card = byId(mounted.container, 'author-proposal')!;
      for (const text of ['Suggested edit', 'Based on version 14', 'Two rows.', 'One row with a replayed badge.',
        'Before', 'After', 'Replays are recorded once now.']) expect(card.textContent).toContain(text);
      expect(byId(mounted.container, 'author-proposal.current')!.textContent).toBe('Version 14 · current');

      act(() => byId(mounted.container, 'author-proposal.accept')!.click());
      await flush();
      expect(executeAction).toHaveBeenCalledWith('doc.edit.accept', expect.objectContaining({
        expectedRevision: { headerVersion: 3, bodyVersion: 14 } }), undefined);
      expect(byId(mounted.container, 'author-proposal.accepted')!.textContent).toContain('You accepted the edit');
      // A settled suggestion folds to its receipt: no diff and no decision buttons remain.
      expect(byId(mounted.container, 'author-proposal.diff')).toBeNull();
      expect(byId(mounted.container, 'author-proposal.accept')).toBeNull();
    } finally { mounted.unmount(); }
  });

  it('stays open with the decision buttons when the person’s approval refuses it', async () => {
    const executeAction = vi.fn(async () => { throw new Error('approval_denied'); });
    const mounted = mount(executeAction);
    try {
      act(() => byId(mounted.container, 'author-proposal.decline')!.click());
      await flush();
      expect(executeAction).toHaveBeenCalledWith('doc.edit.decline', expect.anything(), undefined);
      expect(byId(mounted.container, 'author-proposal.declined')).toBeNull();
      expect(byId(mounted.container, 'author-proposal')!.textContent).toContain('Couldn’t save your decision. Try again.');
      expect(byId(mounted.container, 'author-proposal.accept')).not.toBeNull();
    } finally { mounted.unmount(); }
  });
});
