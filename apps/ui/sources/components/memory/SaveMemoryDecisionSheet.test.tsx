import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoordinationMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
installDisconnectedServerSocketBoundary();

const actions = vi.hoisted(() => ({
  calls: [] as Array<{ actionId: string; input: any }>,
  results: [] as unknown[],
}));

// The Action executor is the boundary; the sheet, the Memory adapter and its result readers stay real.
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
  createDefaultActionExecutor: () => ({
    execute: async (actionId: string, input: any) => {
      actions.calls.push({ actionId, input });
      return (
        actions.results.shift() ?? {
          ok: true,
          result: { ok: true, artifactId: 'doc-1', factId: 'fact-1' },
        }
      );
    },
  }),
}));

const { SaveMemoryDecisionForm, seedMemoryDecisionFromMessage } =
  await import('./SaveMemoryDecisionSheet');

const discussionSource: CoordinationMessageRefV1 = {
  kind: 'discussion',
  discussion: { serverId: 'server-a', discussionId: 'discussion-1' },
  messageId: 'message-1',
};
const seed = seedMemoryDecisionFromMessage(
  discussionSource,
  'Retry cap stays at 5\nBackoff ran out too early.',
);

afterEach(() => {
  standardCleanup();
  actions.calls.length = 0;
  actions.results.length = 0;
});

async function mount(onSaved = vi.fn()) {
  const screen = await renderScreen(
    <SaveMemoryDecisionForm seed={seed} onClose={vi.fn()} onSaved={onSaved} />,
  );
  return { screen, onSaved };
}

async function save(screen: Awaited<ReturnType<typeof renderScreen>>) {
  const button = screen.find(
    (node) =>
      node.props?.testID === 'save-memory-decision.save' &&
      typeof node.props.action === 'function',
  );
  await act(async () => {
    await button.props.action();
  });
}

describe('Save as decision from a Discussion message', () => {
  it('saves into the person’s own memory with the exact Discussion message as its source', async () => {
    const { screen, onSaved } = await mount();
    await save(screen);

    expect(actions.calls).toHaveLength(1);
    const [{ actionId, input }] = actions.calls;
    expect(actionId).toBe('memory.decision.save');
    expect(input).toMatchObject({
      scope: 'account',
      text: 'Retry cap stays at 5',
      reason: 'Backoff ran out too early.',
      sourceMessageRef: discussionSource,
    });
    expect(input).not.toHaveProperty('sessionRef');
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('says a refused disclosure plainly and keeps what was typed', async () => {
    actions.results.push({
      ok: false,
      errorCode: 'memory_decision_disclosure_denied',
      error: 'denied',
    });
    const { screen, onSaved } = await mount();
    await save(screen);

    expect(screen.findByTestId('save-memory-decision.disclosure')).toBeTruthy();
    expect(screen.findAllByTestId('save-memory-decision.refused')).toHaveLength(
      0,
    );
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.findByTestId('save-memory-decision.text').props.value).toBe(
      'Retry cap stays at 5',
    );
  });

  it('resubmits the same Discussion save with the reviewed duplicate choice', async () => {
    const ref = {
      kind: 'doc' as const,
      artifactId: 'doc-1',
      serverId: 'server-a',
    };
    const revision = { headerVersion: 1, bodyVersion: 2 };
    actions.results.push({
      ok: true,
      result: {
        ok: false,
        errorCode: 'memory_duplicate_choice_required',
        ref,
        revision,
        candidates: [
          {
            factId: 'old-fact',
            topic: 'Index',
            text: 'Retry cap stays at 5, backoff from 400 ms',
            match: 'related',
          },
        ],
      },
    });
    const { screen, onSaved } = await mount();
    await save(screen);
    expect(onSaved).not.toHaveBeenCalled();
    await save(screen);

    expect(actions.calls).toHaveLength(2);
    expect(actions.calls[1].input).toMatchObject({
      scope: 'account',
      sourceMessageRef: discussionSource,
      reviewedTarget: { ref, expectedRevision: revision },
      duplicateChoice: {
        kind: 'replace',
        factId: 'old-fact',
        expectedRevision: revision,
      },
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});
