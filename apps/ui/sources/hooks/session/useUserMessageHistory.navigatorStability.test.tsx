import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderHook, createSessionMessagesFixture, createSessionFixture, createRootLayoutFeaturesResponse } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { act } from 'react-test-renderer';
import { createRenderCommitCounter, countStoreNotifications, useRenderCommitCounter } from '@/dev/testkit/performance/counts';

const account = createProviderSettingsAccountHarness();
const { storage } = await import('@/sync/domains/state/storageStore');
const { useUserMessageHistory } = await import('./useUserMessageHistory');
const { useUserMessageHistoryEntries } = await import('./useUserMessageHistoryEntries');
const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
let serverId = '';

describe('useUserMessageHistory', () => {
  beforeEach(async () => {
    await account.reset();
    ({ serverId } = await account.restore());
    storage.setState({ sessions: { s1: createSessionFixture({ id: 's1', serverId }) } });
    account.home.answer(serverId, '/v1/sessions/s1/messages', { body: { messages: [], hasMore: false, nextBeforeSeq: null } });
    const features = createRootLayoutFeaturesResponse();
    features.capabilities.session.messages.role = false;
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
  });
  afterEach(async () => { await account.reset(); });

  it('does no per-Session history work when a sibling streams through the real message owner', async () => {
    const counts = createRenderCommitCounter();
    let historyReads = 0;
    const user = { kind: 'user-text' as const, id: 'u1', localId: null, createdAt: 1,
      get text() { historyReads += 1; return 'my prompt'; } };
    storage.setState(state => ({
      sessions: { ...state.sessions, sibling: createSessionFixture({ id: 'sibling', serverId }) },
      sessionMessages: { ...state.sessionMessages,
        s1: createSessionMessagesFixture({ messageIdsOldestFirst: ['u1'], messagesById: { u1: user }, isLoaded: true }),
      },
    }));
    const hook = await renderHook(() => {
      useRenderCommitCounter(counts);
      return useUserMessageHistoryEntries({ scope: 'perSession', sessionId: 's1', serverId });
    });
    const notifications = countStoreNotifications(storage);
    try {
      const initial = hook.getCurrent().entries;
      expect(initial.map(entry => entry.text)).toEqual(['my prompt']);
      counts.reset(); historyReads = 0;
      for (const chunk of ['one', 'two', 'three']) {
        await act(async () => {
          storage.getState().applyMessages('sibling', [{
            id: `chunk-${chunk}`, localId: null, createdAt: 10,
            isSidechain: false, role: 'agent', content: [{ type: 'text', text: chunk, uuid: `chunk-${chunk}`, parentUUID: null }],
          }]);
        });
      }
      expect(notifications.read().length).toBeGreaterThan(0);
      expect({ work: counts.read(), historyReads }).toEqual({ work: { renders: 0, commits: 0 }, historyReads: 0 });
      expect(hook.getCurrent().entries).toBe(initial);
      // A real change to this history still arrives immediately.
      await act(async () => {
        storage.getState().applyMessages('s1', [{ id: 'new-prompt', localId: null, createdAt: 20,
          isSidechain: false, role: 'user', content: { type: 'text', text: 'next prompt' } }]);
      });
      expect(hook.getCurrent().entries[0]?.text).toBe('next prompt');
    } finally {
      notifications.stop();
      await hook.unmount();
    }
  });

  it('returns a referentially stable navigator when store state is unchanged', async () => {
    const previousState = storage.getState();
    try {
      const messagesById = {
        u1: { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' } as const,
        a1: { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'ok', isThinking: false } as const,
        u2: { kind: 'user-text', id: 'u2', localId: null, createdAt: 3, text: 'bye' } as const,
      };

      storage.setState((state) => ({
        ...state,
        sessionMessages: {
          ...state.sessionMessages,
          s1: createSessionMessagesFixture({
            messageIdsOldestFirst: ['u1', 'a1', 'u2'],
            messagesById,
          }),
        },
      }));

      const hook = await renderHook(() =>
        useUserMessageHistory({ scope: 'global', sessionId: null, maxEntries: 20 }),
      );

      const first = hook.getCurrent();

      await hook.rerender();

      expect(hook.getCurrent()).toBe(first);

      await hook.unmount();
    } finally {
      storage.setState(previousState);
    }
  });

  it('normalizes session ids before reading per-session history', async () => {
    const previousState = storage.getState();
    try {
      const messagesById = {
        u1: { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'first' } as const,
        u2: { kind: 'user-text', id: 'u2', localId: null, createdAt: 2, text: 'expanded second', displayText: '  second\n' } as const,
      };

      storage.setState((state) => ({
        ...state,
        sessionMessages: {
          ...state.sessionMessages,
          s1: createSessionMessagesFixture({
            messageIdsOldestFirst: ['u1', 'u2'],
            messagesById,
          }),
        },
      }));

      const hook = await renderHook(() =>
        useUserMessageHistory({ scope: 'perSession', sessionId: '  s1  ', maxEntries: 20 }),
      );

      expect(hook.getCurrent().moveUp('draft')).toBe('  second\n');

      await hook.unmount();
    } finally {
      storage.setState(previousState);
    }
  });

  it('preserves active per-session browsing when role-query support becomes ready', async () => {
    const previousState = storage.getState();
    try {
      const messagesById = {
        u1: { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'first' } as const,
        u2: { kind: 'user-text', id: 'u2', localId: null, createdAt: 2, text: 'second' } as const,
      };

      storage.setState((state) => ({
        ...state,
        sessionMessages: {
          ...state.sessionMessages,
          s1: createSessionMessagesFixture({
            messageIdsOldestFirst: ['u1', 'u2'],
            messagesById,
          }),
        },
      }));

      const hook = await renderHook(() =>
        useUserMessageHistory({ scope: 'perSession', sessionId: 's1', maxEntries: 20 }),
      );

      const browsingNavigator = hook.getCurrent();
      expect(browsingNavigator.moveUp('draft')).toBe('second');
      expect(browsingNavigator.isBrowsing()).toBe(true);

      const features = createRootLayoutFeaturesResponse();
      features.capabilities.session.messages.role = true;
      primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
      await hook.rerender();

      expect(hook.getCurrent()).toBe(browsingNavigator);
      expect(hook.getCurrent().moveUp('second')).toBe('first');

      await hook.unmount();
    } finally {
      storage.setState(previousState);
    }
  });
});
