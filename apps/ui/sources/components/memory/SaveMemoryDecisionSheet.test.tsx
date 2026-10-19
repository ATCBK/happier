import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoordinationMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createMemoryDecisionHomeFixture } from '@/dev/testkit/harness/memoryDecisionHomeFixture';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { MemoryDocBodyV1Schema } from '@happier-dev/protocol/prompts/library/memoryDocV1';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
installDisconnectedServerSocketBoundary();

const { SaveMemoryDecisionForm, seedMemoryDecisionFromMessage } = await import('./SaveMemoryDecisionSheet');
afterEach(standardCleanup);

async function mount(fixture: Awaited<ReturnType<typeof createMemoryDecisionHomeFixture>>, onSaved = vi.fn()) {
  const source: CoordinationMessageRefV1 = { kind: 'discussion',
    discussion: { serverId: fixture.serverId, discussionId: 'discussion-1' }, messageId: 'committed-source' };
  const seed = seedMemoryDecisionFromMessage(source, 'Retry cap stays at 5\nBackoff ran out too early.');
  const screen = await renderScreen(<SaveMemoryDecisionForm seed={seed} onClose={vi.fn()} onSaved={onSaved} />);
  return { screen, onSaved, source };
}

async function save(screen: Awaited<ReturnType<typeof renderScreen>>) {
  const button = screen.find(node => node.props?.testID === 'save-memory-decision.save' && typeof node.props.action === 'function');
  await act(async () => { await button.props.action(); });
}

describe('Save as decision from a Discussion message', () => {
  it('saves into the person’s own memory with the exact Discussion message as its source', async () => {
    const f = await createMemoryDecisionHomeFixture();
    const { screen, onSaved, source } = await mount(f);
    try {
      await save(screen);
      const saved = f.home.boundary.list().filter(row => f.home.boundary.readPlainBody(row.id)?.includes('Retry cap stays at 5'));
      expect(saved).toHaveLength(1);
      const body = MemoryDocBodyV1Schema.parse(JSON.parse(f.home.boundary.readPlainBody(saved[0]!.id)!));
      expect(body.index[0]).toMatchObject({ text: 'Retry cap stays at 5',
        decision: { reason: 'Backoff ran out too early.', sourceMessageRef: source } });
      expect(f.readSource().attachments).toEqual([]);
      expect(onSaved).toHaveBeenCalledTimes(1);
    } finally { await screen.unmount(); await f.home.dispose(); }
  });

  it('says a refused disclosure plainly and keeps what was typed', async () => {
    const f = await createMemoryDecisionHomeFixture();
    f.refuseDecision('memory_decision_disclosure_denied');
    const { screen, onSaved } = await mount(f);
    try {
      await save(screen);
      expect(screen.findByTestId('save-memory-decision.disclosure')).toBeTruthy();
      expect(screen.findAllByTestId('save-memory-decision.refused')).toHaveLength(0);
      expect(onSaved).not.toHaveBeenCalled();
      expect(screen.findByTestId('save-memory-decision.text')?.props.value).toBe('Retry cap stays at 5');
      expect(f.home.boundary.list()).toEqual([]);
    } finally { await screen.unmount(); await f.home.dispose(); }
  });

  it('resubmits the same Discussion save with the reviewed duplicate choice', async () => {
    const f = await createMemoryDecisionHomeFixture();
    const { screen, onSaved, source } = await mount(f);
    try {
      // Save once through this form, then reopen it against the real persisted duplicate.
      await save(screen);
      const saved = f.home.boundary.list()[0];
      if (!saved) throw new Error('Missing persisted initial decision');
      const before = MemoryDocBodyV1Schema.parse(JSON.parse(f.home.boundary.readPlainBody(saved.id)!));
      await screen.unmount();
      const reopened = await mount(f, onSaved);
      try {
        onSaved.mockClear();
        await save(reopened.screen);
        expect(onSaved).not.toHaveBeenCalled();
        expect(reopened.screen.findByTestId('save-memory-decision.duplicate')).toBeTruthy();
        await save(reopened.screen);
        expect(onSaved).toHaveBeenCalledTimes(1);
        const after = MemoryDocBodyV1Schema.parse(JSON.parse(f.home.boundary.readPlainBody(saved.id)!));
        expect(after.index).toHaveLength(1);
        expect(after.index[0]).toMatchObject({ supersedes: before.index[0]!.id, decision: { sourceMessageRef: source } });
        expect(after.topics.find(topic => topic.title === 'archive')?.facts).toContainEqual(before.index[0]);
      } finally { await reopened.screen.unmount(); }
    } finally { await f.home.dispose(); }
  });

  async function flush(screen: Awaited<ReturnType<typeof renderScreen>>) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    return screen;
  }
  const projectChoice = (f: Awaited<ReturnType<typeof createMemoryDecisionHomeFixture>>) => `save-memory-decision.target:project:${f.serverId}:payments`;
  async function choosePayments(screen: Awaited<ReturnType<typeof renderScreen>>, f: Awaited<ReturnType<typeof createMemoryDecisionHomeFixture>>) {
    await flush(screen);
    const choice = screen.find(node => node.props?.testID === projectChoice(f) && typeof node.props.onPress === 'function');
    await act(async () => { choice.props.onPress(); });
  }

  it('offers Only me and the writable Project, defaults to the source’s own place and saves where it is told', async () => {
    const f = await createMemoryDecisionHomeFixture();
    f.recover();
    const { screen, onSaved } = await mount(f);
    try {
      await flush(screen);
      // A Discussion's natural place is the person's own memory; no memory exists yet, so only they can see it.
      expect(screen.findByTestId('save-memory-decision.target')).toBeTruthy();
      expect(screen.findByTestId('save-memory-decision.audience')).toBeTruthy();
      await choosePayments(screen, f);
      await save(screen);
      expect(onSaved).toHaveBeenCalledTimes(1);
      expect(f.readSource().attachments?.length).toBe(1);
      const attachment = f.readSource().attachments![0];
      if (attachment?.purpose !== 'context') throw new Error('Expected a context attachment');
      const attached = attachment.entry.ref;
      const body = MemoryDocBodyV1Schema.parse(JSON.parse(f.home.boundary.readPlainBody(attached.artifactId)!));
      expect(body.index[0]).toMatchObject({ text: 'Retry cap stays at 5' });
    } finally { await screen.unmount(); await f.home.dispose(); }
  });

  it('says Saved, not attached yet, links the saved fact and attaches that same document on demand', async () => {
    const f = await createMemoryDecisionHomeFixture();
    const { screen, onSaved } = await mount(f);
    try {
      await choosePayments(screen, f);
      await save(screen);
      expect(screen.findByTestId('save-memory-decision.saved')).toBeTruthy();
      expect(screen.findByTestId('save-memory-decision.openSaved')).toBeTruthy();
      // The sheet stays usable: Save gives way to Done, and nothing was reported saved-and-closed yet.
      expect(screen.findAllByTestId('save-memory-decision.save')).toHaveLength(0);
      expect(onSaved).not.toHaveBeenCalled();
      const saved = f.home.boundary.list();
      expect(saved).toHaveLength(1);
      f.recover();
      const attach = screen.find(node => node.props?.testID === 'save-memory-decision.attach' && typeof node.props.action === 'function');
      await act(async () => { await attach.props.action(); });
      const recovered = f.readSource().attachments?.[0];
      expect(recovered?.purpose === 'context' && recovered.entry.ref.artifactId).toBe(saved[0]!.id);
      expect(f.home.boundary.list()).toHaveLength(1);
      expect(onSaved).toHaveBeenCalledTimes(1);
    } finally { await screen.unmount(); await f.home.dispose(); }
  });
});
