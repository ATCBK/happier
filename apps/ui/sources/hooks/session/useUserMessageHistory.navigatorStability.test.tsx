import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderHook, createSessionMessagesFixture, createSessionFixture, createRootLayoutFeaturesResponse } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';

const account = createProviderSettingsAccountHarness();
const { storage } = await import('@/sync/domains/state/storageStore');
const { useUserMessageHistory } = await import('./useUserMessageHistory');
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
