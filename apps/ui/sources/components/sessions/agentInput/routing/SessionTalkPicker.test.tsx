import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);

const { getStorage } = await import('@/sync/domains/state/storage');
const { SessionTalkPicker } = await import('./SessionTalkPicker');
const { resolveSessionTalkChipLabel } =
  await import('../definitions/createRecipientActionChip');
type Intent = React.ComponentProps<typeof SessionTalkPicker>['intent'];

const previous = getStorage().getState();
afterEach(() => {
  standardCleanup();
  getStorage().setState(previous, true);
});

function seedRelations() {
  const session = (id: string, name: string, lead: string | null) =>
    createSessionFixture({
      id,
      serverId: 'home-a',
      metadata: { path: '/repo', host: 'host', name },
      manager: lead ? { sessionId: lead } : null,
    });
  getStorage().setState({
    sessions: {
      lead: session('lead', 'Payments v2 rollout', null),
      api: session('api', 'Idempotent retries', 'lead'),
      ui: session('ui', 'Checkout UI retry states', 'lead'),
    },
  });
}

/** The person's picks go through the same intent writer the composer's submit branch reads. */
async function renderPicker(initial: Intent = null) {
  const writes: Intent[] = [];
  const closes: number[] = [];
  function Host() {
    const [intent, setIntent] = React.useState<Intent>(initial);
    return (
      <SessionTalkPicker
        sessionId="api"
        serverId="home-a"
        intent={intent}
        onIntentChange={(next) => {
          writes.push(next);
          setIntent(next);
        }}
        participants={null}
        requestClose={() => closes.push(1)}
      />
    );
  }
  const screen = await renderScreen(<Host />);
  return { screen, writes, closes };
}

describe('SessionTalkPicker (composer To: Send · Ask · Post update)', () => {
  it('writes an Ask that returns here when the person picks Siblings, and closes', async () => {
    seedRelations();
    const { screen, writes, closes } = await renderPicker();
    expect(screen.getTextContent()).toContain('Checkout UI retry states');
    await act(async () => screen.pressByTestId('session-talk-target:siblings'));
    expect(writes).toEqual([
      { kind: 'ask', target: { selector: 'siblings' }, reply: 'return' },
    ]);
    expect(closes).toHaveLength(1);
  });

  it('keeps a relation with nobody behind it visible but not choosable', async () => {
    seedRelations();
    const { screen, writes } = await renderPicker();
    const workers = screen.findByTestId('session-talk-target:workers');
    expect(workers?.props.disabled).toBe(true);
    expect(writes).toEqual([]);
  });

  it('turns into Post update and back without losing the chosen sessions', async () => {
    seedRelations();
    const { screen, writes } = await renderPicker({
      kind: 'send',
      target: { selector: 'manager' },
    });
    await act(async () =>
      screen.pressByTestId('session-talk-verb:post_update'),
    );
    expect(screen.findByTestId('session-talk-audience')).not.toBeNull();
    await act(async () => screen.pressByTestId('session-talk-verb:ask'));
    expect(writes).toEqual([
      { kind: 'post_update' },
      { kind: 'ask', target: { selector: 'manager' }, reply: 'return' },
    ]);
  });

  it('returns to ordinary chat from "This session"', async () => {
    seedRelations();
    const { screen, writes } = await renderPicker({
      kind: 'send',
      target: { selector: 'manager' },
    });
    await act(async () => screen.pressByTestId('session-talk-target:self'));
    expect(writes).toEqual([null]);
  });

  it('says the whole sentence on the chip', () => {
    expect(resolveSessionTalkChipLabel(null, null)).toBe(
      'session.participants.to',
    );
    expect(
      resolveSessionTalkChipLabel(
        { kind: 'ask', target: { selector: 'siblings' }, reply: 'return' },
        null,
      ),
    ).toContain('session.participants.talk.chipAsk');
    expect(resolveSessionTalkChipLabel({ kind: 'post_update' }, null)).toBe(
      'session.participants.talk.chipPostUpdate',
    );
  });
});
