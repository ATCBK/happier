import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import * as publicComponents from '@happier-dev/plugin-ui/components';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiActionResultFor } from '@happier-dev/plugin-sdk/ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';

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
  return mountThroughReactNativeWeb(<PluginUiProvider hostApi={createHostApiStub(context, { executeAction })} context={context}>
    <DocEditProposalExample />
  </PluginUiProvider>);
}

describe('external author Doc edit proposal', () => {
  it.each([
    { requested: 'Decline', result: { state: 'accepted', acceptedRevision: { headerVersion: 8, bodyVersion: 27 },
      decidedBy: { accountId: 'other-editor', atMs: 123 } }, receipt: 'Accepted by other-editor · now version 27' },
    { requested: 'Accept', result: { state: 'declined', decidedBy: { accountId: 'other-editor', atMs: 123 } },
      receipt: 'Declined by other-editor' },
  ] as const)('shows the recorded $result.state after an opposite $requested retry through the public facade', async ({ requested, result, receipt }) => {
    const response = { proposalRef: { kind: 'discussion', discussion: { serverId: 'home', discussionId: 'd1' }, messageId: 'm1' },
      docEditProposalDispositionV1: result } satisfies PluginUiActionResultFor<'doc.edit.accept'>;
    const executeAction = vi.fn(async () => response);
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'doc-retry', mountNonce: 'doc-retry-mount' },
      authorPlugin: { id: 'external-doc-review', version: '1.0.0' },
      surface: defineUiSurface(DocEditProposalExample), surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: ({ action, input }) => executeAction(action, input) },
    });
    try {
      await fixture.press(await fixture.getByRole('button', { name: requested }));
      await flush();
      await expect(fixture.getByText(receipt)).resolves.toBeDefined();
      expect(executeAction).toHaveBeenCalledWith(requested === 'Accept' ? 'doc.edit.accept' : 'doc.edit.decline',
        expect.objectContaining({ proposalRef: response.proposalRef }));
    } finally { await fixture.dispose(); }
  });

  it('draws the suggestion and settles only on the Doc Action’s answer', async () => {
    expect(typeof publicComponents.DocEditProposal).toBe('function');
    expect(typeof publicComponents.HappierDocEditProposal).toBe('function');
    const executeAction = vi.fn(async () => ({ proposalRef: { kind: 'discussion', discussion: { serverId: 'home', discussionId: 'd1' }, messageId: 'm1' },
      docEditProposalDispositionV1: { state: 'accepted', acceptedRevision: { headerVersion: 4, bodyVersion: 19 },
        decidedBy: { accountId: 'reviewing-person', atMs: 123 } } } satisfies PluginUiActionResultFor<'doc.edit.accept'>));
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
      expect(byId(mounted.container, 'author-proposal.accepted')!.textContent).toContain('Accepted by reviewing-person · now version 19');
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

  it('keeps the suggestion pending until the decision is acknowledged', async () => {
    const result = { proposalRef: { kind: 'discussion', discussion: { serverId: 'home', discussionId: 'd1' }, messageId: 'm1' },
      docEditProposalDispositionV1: { state: 'declined', decidedBy: { accountId: 'reviewing-person', atMs: 123 } },
    } satisfies PluginUiActionResultFor<'doc.edit.decline'>;
    let resolve!: (value: typeof result) => void;
    const pending = new Promise<typeof result>(complete => { resolve = complete; });
    const mounted = mount(vi.fn(() => pending));
    try {
      act(() => byId(mounted.container, 'author-proposal.decline')!.click());
      await flush();
      expect(byId(mounted.container, 'author-proposal')!.textContent).toContain('Declining…');
      expect(byId(mounted.container, 'author-proposal.accept')!.getAttribute('aria-disabled')).toBe('true');
      expect(byId(mounted.container, 'author-proposal.accepted')).toBeNull();
      expect(byId(mounted.container, 'author-proposal.declined')).toBeNull();
      await act(async () => { resolve(result); await pending; });
      expect(byId(mounted.container, 'author-proposal.declined')!.textContent).toContain('Declined by reviewing-person');
    } finally { resolve(result); mounted.unmount(); }
  });
});
