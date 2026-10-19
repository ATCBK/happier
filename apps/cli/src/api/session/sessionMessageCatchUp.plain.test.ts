import { describe, expect, it, vi } from 'vitest';

vi.mock('@/configuration', () => ({
  configuration: { serverUrl: 'http://example.test', apiServerUrl: 'http://example.test' },
}));

vi.mock('../client/loopbackUrl', () => ({
  resolveLoopbackHttpUrl: (url: string) => url,
}));

import axios, { AxiosHeaders, type AxiosResponse } from 'axios';

import { HttpStatusError } from '@/api/client/httpStatusError';
import type { Update } from '../types';
import { encryptSessionPayload, type SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionEncryptionContext';

import { catchUpSessionMessagesAfterSeq } from './sessionMessageCatchUp';
import { handleSessionNewMessageUpdate } from './sessionNewMessageUpdate';

describe('sessionMessageCatchUp (stored-content envelopes)', () => {
  it('rejects malformed page metadata before publishing valid rows', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        messages: [{ id: 'm11', seq: 11, createdAt: 1, updatedAt: 1, localId: null,
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } } }],
        hasMore: 'false', nextAfterSeq: null,
      },
    });
    const updates: Update[] = [];
    await expect(catchUpSessionMessagesAfterSeq({
      mode: 'plain', ctx: null, token: 't', sessionId: 's1', afterSeq: 10,
      onUpdate: (update) => updates.push(update),
    })).rejects.toMatchObject({ code: 'session_transcript_stored_content_unavailable' });
    expect(updates).toEqual([]);
  });
  it.each(['legacy', 'dataKey'] as const)('replays authenticated %s history under the established E2EE context', async (encryptionVariant) => {
    const ctx = { encryptionKey: new Uint8Array(32), encryptionVariant };
    const content = {
      t: 'encrypted' as const,
      c: encryptSessionPayload({ ctx, payload: { role: 'agent', content: { type: 'text', text: 'history' } } }),
    };
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: { messages: [{ id: 'm11', seq: 11, createdAt: 1, content }], hasMore: false, nextAfterSeq: null },
    });
    const updates: Update[] = [];

    await catchUpSessionMessagesAfterSeq({
      mode: 'e2ee',
      ctx,
      token: 't',
      sessionId: 's1',
      afterSeq: 10,
      onUpdate: (update) => updates.push(update),
    });

    expect(updates).toEqual([expect.objectContaining({ body: expect.objectContaining({
      message: expect.objectContaining({ id: 'm11', content }),
    }) })]);
  });

  it.each(['plain-in-e2ee', 'encrypted-in-plain', 'unopenable-e2ee'] as const)(
    'rejects %s without publishing valid neighbors or advancing recovery',
    async (scenario) => {
      const ctx = { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' as const };
      const crypto: SessionStoredContentCryptoContext = scenario === 'encrypted-in-plain'
        ? { mode: 'plain', ctx: null }
        : { mode: 'e2ee', ctx };
      const payload = { role: 'agent', content: { type: 'text', text: 'history' } };
      const plain = { t: 'plain' as const, v: payload };
      const encrypted = { t: 'encrypted' as const, c: encryptSessionPayload({ ctx, payload }) };
      const rejected = scenario === 'plain-in-e2ee' ? plain
        : scenario === 'encrypted-in-plain' ? encrypted
          : { t: 'encrypted' as const, c: 'unopenable' };
      const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
        status: 200,
        data: {
          messages: [
            { id: 'm11', seq: 11, createdAt: 1, content: crypto.mode === 'plain' ? plain : encrypted },
            { id: 'm12', seq: 12, createdAt: 1, content: rejected },
          ],
          hasMore: true,
          nextAfterSeq: 12,
        },
      });
      const updates: Update[] = [];

      await expect(catchUpSessionMessagesAfterSeq({
        ...crypto,
        token: 't',
        sessionId: 's1',
        afterSeq: 10,
        onUpdate: (update) => updates.push(update),
      })).rejects.toMatchObject({ code: 'session_transcript_stored_content_unavailable' });

      expect(updates).toEqual([]);
      expect(getSpy).toHaveBeenCalledTimes(1);
    },
  );

  it('drains producer-shaped forward pages beyond ten pages using the last returned sequence', async () => {
    const getSpy = vi.spyOn(axios, 'get');
    for (let seq = 11; seq <= 22; seq++) {
      getSpy.mockResolvedValueOnce({
        status: 200,
        data: {
          messages: [{
            id: `m${seq}`,
            seq,
            createdAt: 1,
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: `message ${seq}` } } },
          }],
          hasMore: seq < 22,
          nextAfterSeq: seq < 22 ? seq : null,
        },
      });
    }
    const updates: Update[] = [];

    await catchUpSessionMessagesAfterSeq({
      mode: 'plain',
      ctx: null,
      token: 't',
      sessionId: 's1',
      afterSeq: 10,
      onUpdate: (update) => updates.push(update),
    });

    expect(updates.map((update) => update.body.t === 'new-message' ? update.body.message.id : null))
      .toEqual(Array.from({ length: 12 }, (_, index) => `m${index + 11}`));
    expect(getSpy.mock.calls.map((call) => Number(new URL(String(call[0])).searchParams.get('afterSeq'))))
      .toEqual(Array.from({ length: 12 }, (_, index) => index + 10));
  });

  it('rejects a nonprogressing continuation without publishing or requesting another page', async () => {
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        messages: [{
          id: 'm10',
          seq: 10,
          createdAt: 1,
          content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'repeated' } } },
        }],
        hasMore: true,
        nextAfterSeq: 10,
      },
    });
    const updates: Update[] = [];

    await expect(catchUpSessionMessagesAfterSeq({
      mode: 'plain',
      ctx: null,
      token: 't',
      sessionId: 's1',
      afterSeq: 10,
      onUpdate: (update) => updates.push(update),
    })).rejects.toMatchObject({ code: 'session_transcript_stored_content_unavailable' });

    expect(updates).toEqual([]);
    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it('advances through sidechain rows while replaying only the main chain', async () => {
    const content = { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'history' } } };
    const getSpy = vi.spyOn(axios, 'get')
      .mockResolvedValueOnce({ status: 200, data: {
        messages: [{ id: 'side11', seq: 11, createdAt: 1, sidechainId: 'subagent', content }],
        hasMore: true, nextAfterSeq: 11,
      } })
      .mockResolvedValueOnce({ status: 200, data: {
        messages: [{ id: 'main12', seq: 12, createdAt: 1, content }],
        hasMore: false, nextAfterSeq: null,
      } });
    const updates: Update[] = [];

    await catchUpSessionMessagesAfterSeq({
      mode: 'plain', ctx: null, token: 't', sessionId: 's1', afterSeq: 10,
      onUpdate: (update) => updates.push(update),
    });

    expect(updates.map((update) => update.body.t === 'new-message' ? update.body.message.id : null)).toEqual(['main12']);
    expect(getSpy.mock.calls.map((call) => {
      const query = new URL(String(call[0])).searchParams;
      return [query.get('scope'), query.get('afterSeq')];
    })).toEqual([['all', '10'], ['all', '11']]);
  });

  it('emits new-message updates for plaintext transcript messages', async () => {
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: {
        messages: [
          {
            id: 'm1',
            seq: 12,
            localId: 'l1',
            createdAt: 123,
            updatedAt: 456,
            sourceCreatedAt: 23,
            sourceUpdatedAt: 56,
            transcriptObservationProvenance: { kind: 'non_dependent', source: 'history' },
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
          },
        ],
      },
    } as any);

    const updates: any[] = [];
    await catchUpSessionMessagesAfterSeq({
      mode: 'plain',
      ctx: null,
      token: 't',
      sessionId: 's1',
      afterSeq: 10,
      onUpdate: (u) => updates.push(u),
    });

    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.body?.t).toBe('new-message');
    expect(updates[0]?.body?.message?.content?.t).toBe('plain');
    expect(updates[0]?.body?.message?.localId).toBe('l1');
    expect(updates[0]?.body?.message?.sidechainId).toBeNull();
    expect(updates[0]?.body?.message?.createdAt).toBe(123);
    expect(updates[0]?.body?.message?.updatedAt).toBe(456);
    expect(updates[0]?.body?.message?.sourceCreatedAt).toBe(23);
    expect(updates[0]?.body?.message?.sourceUpdatedAt).toBe(56);
    expect(updates[0]?.body?.message?.transcriptObservationProvenance).toEqual({
      kind: 'non_dependent',
      source: 'history',
    });
  });

  it('projects persisted catch-up history at source time without feeding live effects', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: {
        messages: [
          {
            id: 'historical-agent-message',
            seq: 13,
            localId: 'historical-agent-local',
            createdAt: 1_000,
            updatedAt: 1_100,
            sourceCreatedAt: 123,
            sourceUpdatedAt: 456,
            transcriptObservationProvenance: { kind: 'non_dependent', source: 'history' },
            content: {
              t: 'plain',
              v: { role: 'agent', content: { type: 'text', text: 'historical output' } },
            },
          },
        ],
      },
    } as any);
    const observeMessage = vi.fn();
    const observeCommittedUserMessageSeq = vi.fn();
    const onConnectedServiceTurnLifecycleEvent = vi.fn();
    const emit = vi.fn();

    await catchUpSessionMessagesAfterSeq({
      mode: 'plain',
      ctx: null,
      token: 't',
      sessionId: 's1',
      afterSeq: 10,
      onUpdate: (update) => {
        handleSessionNewMessageUpdate({
          serverId: 'home',
          update,
          sessionId: 's1',
          mode: 'plain',
          ctx: null,
          receivedMessageIds: new Set<string>(),
          lastObservedMessageSeq: 10,
          lastObservedUserMessageSeq: 0,
          emit,
          observeMessage,
          observeCommittedUserMessageSeq,
          onConnectedServiceTurnLifecycleEvent,
          debug: vi.fn(),
          debugLargeJson: vi.fn(),
        });
      },
    });

    expect(observeMessage).not.toHaveBeenCalled();
    expect(observeCommittedUserMessageSeq).not.toHaveBeenCalled();
    expect(onConnectedServiceTurnLifecycleEvent).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('message', expect.objectContaining({
      createdAt: 123,
      serverCreatedAt: 1_000,
    }));
  });

  it('preserves the exact opaque local id during transcript restart catch-up', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: {
        messages: [
          {
            id: 'm1',
            seq: 12,
            localId: ' request-1 ',
            createdAt: 1,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
          },
        ],
      },
    } as any);

    const updates: any[] = [];
    await catchUpSessionMessagesAfterSeq({
      mode: 'plain',
      ctx: null,
      token: 't',
      sessionId: 's1',
      afterSeq: 10,
      onUpdate: (u) => updates.push(u),
    });

    expect(updates[0]?.body?.message?.localId).toBe(' request-1 ');
  });

  it('rejects a page missing the protocol-required creation timestamp as unavailable', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: {
        messages: [
          {
            id: 'm1',
            seq: 12,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
          },
        ],
      },
    } as any);

    const updates: any[] = [];
    await expect(catchUpSessionMessagesAfterSeq({
      mode: 'plain',
      ctx: null,
      token: 't',
      sessionId: 's1',
      afterSeq: 10,
      onUpdate: (u) => updates.push(u),
    })).rejects.toMatchObject({ code: 'session_transcript_stored_content_unavailable' });
    expect(updates).toHaveLength(0);
  });

  it('rejects transcript messages with malformed seq values', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: {
        messages: [
          {
            id: 'm1',
            seq: '12',
            createdAt: 123,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
          },
        ],
      },
    } as any);

    const updates: any[] = [];
    await expect(catchUpSessionMessagesAfterSeq({
      mode: 'plain',
      ctx: null,
      token: 't',
      sessionId: 's1',
      afterSeq: 10,
      onUpdate: (u) => updates.push(u),
    })).rejects.toMatchObject({
      code: 'session_transcript_stored_content_unavailable',
      response: { status: 503 },
    });

    expect(updates).toHaveLength(0);
  });

  it('rejects a malformed authoritative row without publishing any page updates or following its cursor', async () => {
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: {
        messages: [
          {
            id: 'm11',
            seq: 11,
            createdAt: 1,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'before' } } },
          },
          {
            id: 'm12',
            seq: 12,
            createdAt: 1,
            content: { t: 'future', value: 'unreadable' },
          },
          {
            id: 'm13',
            seq: 13,
            createdAt: 1,
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'after' } } },
          },
        ],
        nextAfterSeq: 13,
      },
    } as any);

    const updates: any[] = [];
    await expect(catchUpSessionMessagesAfterSeq({
      mode: 'plain',
      ctx: null,
      token: 't',
      sessionId: 's1',
      afterSeq: 10,
      onUpdate: (update) => updates.push(update),
    })).rejects.toMatchObject({
      name: 'HttpStatusError',
      code: 'session_transcript_stored_content_unavailable',
      response: { status: 503 },
    });

    expect(updates).toEqual([]);
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(new URL(String(getSpy.mock.calls[0]?.[0])).searchParams.get('afterSeq')).toBe('10');
  });

  it('throws terminal auth responses instead of treating them as empty catch-up', async () => {
    const authResponse: AxiosResponse = {
      status: 401,
      statusText: 'Unauthorized',
      headers: {},
      config: { headers: new AxiosHeaders() },
      data: { messages: [] },
    };
    vi.spyOn(axios, 'get').mockResolvedValueOnce(authResponse);

    await expect(
      catchUpSessionMessagesAfterSeq({
        mode: 'plain',
        ctx: null,
        token: 'expired',
        sessionId: 's1',
        afterSeq: 10,
        onUpdate: vi.fn(),
      }),
    ).rejects.toMatchObject({
      name: 'HttpStatusError',
      code: 'not_authenticated',
      response: { status: 401 },
    } satisfies Partial<HttpStatusError & { code: string }>);
  });
});
