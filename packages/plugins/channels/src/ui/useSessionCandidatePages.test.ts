// @vitest-environment jsdom
import { act, createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import {
  CONVERSATION_MANAGEMENT_ACTION_IDS_V1,
  ConversationStartInputV1Schema,
  ConversationStartResultV1Schema,
} from '@happier-dev/channels-protocol/v1';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkitExecuteActionInput } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface, Text, useExecutePluginAction } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { useSessionCandidatePages } from './useSessionCandidatePages.js';
import { createSessionCandidatePageFixture } from '../testkit/sessionCandidatePageFixture.js';

describe('Channels Session candidate pages', () => {
  it('keeps an empty continuing page reachable and accepts valid candidate pages beyond the requested count', async () => {
    let pages: ReturnType<typeof useSessionCandidatePages> | undefined;
    function Probe(props: Readonly<{ signal: AbortSignal }>) {
      pages = useSessionCandidatePages({ signal: props.signal });
      return createElement(Text, { value: 'Session candidate probe' });
    }
    const current = () => {
      if (pages === undefined) throw new Error('Expected the mounted candidate hook');
      return pages;
    };
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'empty-session-pages', mountNonce: 'empty-session-pages-mount' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: defineUiSurface((context: RenderContext) => createElement(Probe, { signal: context.signal })),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        executeAction: async ({ action, input }): Promise<JsonValue> => {
          if (action !== 'session.list') throw new Error(`Unexpected host Action ${String(action)}`);
          const cursor = (input as Readonly<{ cursor?: string }>).cursor;
          return createSessionCandidatePageFixture(cursor === undefined
            ? { sessions: [], nextCursor: 'continuing-page' }
            : { sessions: Array.from({ length: 101 }, (_, index) => ({ id: `session-${index}`, title: `Session ${index}` })), nextCursor: null });
        },
      },
    });
    try {
      await act(async () => { await current().load(); });
      expect(current().unavailable).toBe(false);
      expect(current().nextCursor).toBe('continuing-page');
      await act(async () => { await current().load(current().nextCursor); });
      expect(current().unavailable).toBe(false);
      expect(current().candidates).toHaveLength(101);
      expect(current().nextCursor).toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  });

  it('retains the Session cursor through loading and failure, then starts with a second-page Session after retry', async () => {
    let latest: Readonly<{
      pages: ReturnType<typeof useSessionCandidatePages>;
      start: ReturnType<typeof useExecutePluginAction>;
    }> | undefined;
    function Probe(props: Readonly<{ signal: AbortSignal }>) {
      latest = {
        pages: useSessionCandidatePages({ signal: props.signal }),
        start: useExecutePluginAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.conversationStart),
      };
      return createElement(Text, { value: 'Session candidate probe' });
    }
    const current = () => {
      if (latest === undefined) throw new Error('Expected the mounted candidate hook');
      return latest;
    };
    let pageTwoReads = 0;
    let rejectPage: ((reason: unknown) => void) | undefined;
    let startedSessionId: unknown;
    const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === 'session.list') {
        expect(input).toMatchObject({ view: 'awareness', limit: 100 });
        expect(input).not.toHaveProperty('includeLastMessagePreview');
        const cursor = (input as Readonly<{ cursor?: string }>).cursor;
        if (cursor === undefined) return createSessionCandidatePageFixture({
          sessions: [{ id: 'recent-session', title: 'Recent Session' }],
          nextCursor: 'older-session-page',
        });
        expect(cursor).toBe('older-session-page');
        pageTwoReads += 1;
        if (pageTwoReads === 1) return new Promise((_resolve, reject) => { rejectPage = reject; });
        return createSessionCandidatePageFixture({
          sessions: [
            { id: 'recent-session', title: 'Duplicate Session' },
            { id: 'older-session', title: 'Older Session' },
          ],
          nextCursor: null,
        });
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.conversationStart) {
        startedSessionId = ConversationStartInputV1Schema.parse(input).sessionId;
        return ConversationStartResultV1Schema.parse({ kind: 'accepted', custodyId: 'c'.repeat(43) });
      }
      throw new Error(`Unexpected host Action ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'session-pages', mountNonce: 'session-pages-mount' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: defineUiSurface((context: RenderContext) => createElement(Probe, { signal: context.signal })),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction },
    });
    try {
      await act(async () => { await current().pages.load(); });
      const firstCandidates = current().pages.candidates;
      expect(firstCandidates).toEqual([{ id: 'recent-session', label: 'Recent Session' }]);
      expect(current().pages.nextCursor).toBe('older-session-page');
      let pageRequest: Promise<void> | undefined;
      await act(async () => { pageRequest = current().pages.load(current().pages.nextCursor); });
      await vi.waitFor(() => { expect(current().pages.loading).toBe(true); });
      expect(current().pages.candidates).toBe(firstCandidates);
      await act(async () => {
        rejectPage?.(new PluginError({ code: 'plugin_service_unavailable', message: 'Page unavailable' }));
        await pageRequest;
      });
      expect(current().pages.unavailable).toBe(true);
      expect(current().pages.loading).toBe(false);
      expect(current().pages.candidates).toBe(firstCandidates);
      expect(current().pages.nextCursor).toBe('older-session-page');
      await act(async () => { await current().pages.retry(); });
      expect(current().pages.unavailable).toBe(false);
      expect(current().pages.nextCursor).toBeUndefined();
      expect(current().pages.candidates).toEqual([
        { id: 'recent-session', label: 'Recent Session' },
        { id: 'older-session', label: 'Older Session' },
      ]);
      expect(current().pages.candidates[0]).toBe(firstCandidates[0]);
      await act(async () => {
        const chosen = current().pages.candidates.find((candidate) => candidate.id === 'older-session');
        expect(chosen).toBeDefined();
        await current().start.execute({
          routerBindingId: 'router-1', audienceGroupId: 'brief', subject: 'Brief',
          content: { text: 'Morning brief' }, sessionId: chosen!.id,
        });
      });
      expect(startedSessionId).toBe('older-session');
      expect(current().start.execution.status).toBe('success');
      expect(pageTwoReads).toBe(2);
      const namedCandidates = current().pages.candidates;
      // Older hosts may ignore the requested view. An unmarked summary cannot
      // prove the canonical display names were supplied for this picker.
      executeAction.mockImplementationOnce(async () => ({ sessions: [{ id: 'legacy', title: 'Legacy summary' }] }));
      await act(async () => { await current().pages.load(); });
      expect(current().pages.unavailable).toBe(true);
      expect(current().pages.candidates).toBe(namedCandidates);
    } finally {
      await fixture.dispose();
    }
  });
});
