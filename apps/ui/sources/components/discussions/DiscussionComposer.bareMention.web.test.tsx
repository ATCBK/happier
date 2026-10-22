/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { createSessionFixture, flushHookEffects } from '@/dev/testkit';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import { installAgentInputCommonModuleMocks } from '@/components/sessions/agentInput/agentInputTestHelpers';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
// The DOM editor, AgentInput's suggestion pipeline and the Discussion's candidate adapter stay real; only native
// rendering adapters, the Home transport and the Discussion roster HTTP read are replaced.
vi.mock(
  '@/components/ui/forms/MultiTextInput',
  async () => import('@/components/ui/forms/MultiTextInput.web'),
);
installAgentInputCommonModuleMocks({
  reactNative: async () => vi.importActual('react-native-web'),
});
vi.doMock('react-native-reanimated', async () => {
  const { createReanimatedModuleMock } =
    await import('@/dev/testkit/mocks/reanimated');
  const mock = createReanimatedModuleMock();
  const rn =
    await vi.importActual<typeof import('react-native-web')>(
      'react-native-web',
    );
  const hosts = { View: rn.View, ScrollView: rn.ScrollView, Text: rn.Text };
  return { ...mock, ...hosts, default: { ...mock.default, ...hosts } };
});
const readParticipants = vi.hoisted(() => vi.fn());
vi.mock('@/sync/api/discussions/discussionActions', () => ({
  createDiscussionClient: () => ({ participants: readParticipants }),
}));
const { installSessionPaneRuntimeTestHarness } =
  await import('@/components/sessions/panes/sessionPaneRuntimeTestHarness');
// `s1` is an ordinary Session of this Account that nobody invited.
const runtime = installSessionPaneRuntimeTestHarness({
  sessionId: 'outsider-session',
});
const { DiscussionComposer } = await import('./DiscussionComposer');
const { storage } = await import('@/sync/domains/state/storage');
let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

// A bare `@` in a Session composer leads with a Recent group from the whole Account. In a Discussion the roster
// (or, before create, the chosen invitees) is the whole candidate set, so nothing outside it is offered.
it.each(['new', 'existing'] as const)(
  'a bare @ in a %s Discussion offers only its participants, never a Recent outsider',
  async (kind) => {
    const serverId = runtime.serverId;
    const outsider = storage.getState().sessions['outsider-session'];
    if (!outsider) throw new Error('Expected the outsider Session');
    storage
      .getState()
      .applySessions([
        {
          ...outsider,
          active: true,
          metadata: {
            ...outsider.metadata!,
            summary: { text: 'Outsider work', updatedAt: 2 },
          },
        },
        createSessionFixture({
          id: 'invited-bot',
          serverId,
          active: true,
          metadata: {
            path: '/review',
            host: 'review-machine',
            summary: { text: 'Invited reviewer', updatedAt: 1 },
          },
        }),
      ]);
    readParticipants.mockResolvedValue({
      kind: 'succeeded',
      value: DiscussionParticipantsListResponseV1Schema.parse({
        discussionId: 'discussion-1',
        ownerAccountId: 'account-a',
        access: 'owner',
        grants: [],
        participants: [
          {
            participant: { kind: 'session', sessionId: 'invited-bot' },
            answerPolicy: 'when_addressed',
            createdAt: 1,
          },
        ],
      }),
    });
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => [],
    });
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => new DOMRect(),
    });
    vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    const scope = runtime.accountScope!;
    const lifetime = {
      scope,
      isCurrent: () => true,
      onRetire: () => ({ dispose: () => undefined }),
    };
    function Host() {
      const [value, setValue] = React.useState({
        text: '',
        mentions: [] as never[],
      });
      return (
        <DiscussionComposer
          scope={scope}
          accountLifetime={lifetime}
          address={{ serverId }}
          {...(kind === 'existing'
            ? { discussionId: 'discussion-1' }
            : {
                invited: {
                  participants: [
                    { kind: 'session' as const, sessionId: 'invited-bot' },
                  ],
                  accounts: new Map(),
                },
              })}
          availability="available"
          value={value}
          onChange={(next) => setValue(next as never)}
          disabled={false}
          onSend={() => undefined}
        />
      );
    }
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <runtime.Wrapper>
          <Host />
        </runtime.Wrapper>,
      );
    });
    const editor = container.querySelector<HTMLElement>(
      '[data-happier-text-input]',
    )!;
    expect(editor).toBeTruthy();
    await act(async () => {
      editor.focus();
      const selection = window.getSelection()!;
      const text = document.createTextNode('@');
      selection.getRangeAt(0).insertNode(text);
      selection.collapse(text, text.length);
      editor.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: '@',
        }),
      );
    });
    await flushHookEffects();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Invited reviewer'),
    );
    expect(document.body.textContent).not.toContain('Outsider work');
  },
);
