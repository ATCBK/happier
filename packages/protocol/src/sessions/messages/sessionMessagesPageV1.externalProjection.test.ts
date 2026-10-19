import { describe, expect, it } from 'vitest';
import { SessionExternalShareableMessagesPageV1Schema } from './sessionMessagesPageV1.js';

describe('external-shareable message page', () => {
  it('retains exact admitted visual references while rejecting malformed grants', () => {
    const reference = { v: 1, references: [{ v: 1, itemId: 'visual', itemRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
      sourceAddress: { serverId: 'home', sessionId: 'session' } }] };
    const row = { id: 'answer', seq: 1, createdAt: 1, content: { t: 'plain', v: {} }, surfaceItemReference: reference };
    expect(SessionExternalShareableMessagesPageV1Schema.parse({ messages: [row], hasMore: false }).messages[0])
      .toHaveProperty('surfaceItemReference', reference);
    expect(SessionExternalShareableMessagesPageV1Schema.safeParse({ messages: [{ ...row,
      surfaceItemReference: { ...reference, references: [{ ...reference.references[0], itemRevision: 'invalid' }] } }], hasMore: false }).success).toBe(false);
    expect(SessionExternalShareableMessagesPageV1Schema.parse({ messages: [{ ...row, surfaceItemReference: null }], hasMore: false }).messages[0])
      .toHaveProperty('surfaceItemReference', null);
  });
  it('preserves an opaque cursor witness without disclosing Account identity or admission receipts', () => {
    const page = SessionExternalShareableMessagesPageV1Schema.parse({
      messages: [{
        id: 'm1', seq: 1, createdAt: 1,
        content: { t: 'encrypted' },
        accountActor: { accountId: 'private-account' },
        inputAdmissionReceipt: { issuer: 'authenticatedMachine' },
        externalShareableActor: 'machine',
      }, { id: 'm2', seq: 2, createdAt: 1 }],
      hasMore: false, nextAfterSeq: null,
      externalShareableSnapshot: { turns: [] },
    });
    expect(page.messages[0]).toMatchObject({ id: 'm1', seq: 1, externalShareableActor: 'machine' });
    expect(page.messages[0]?.content).toBeUndefined();
    expect(page.messages[1]).toMatchObject({ id: 'm2', seq: 2 });
    expect(page.messages[1]?.content).toBeUndefined();
    expect(page.messages[1]?.externalShareableActor).toBeUndefined();
    expect(page.messages[0]).not.toHaveProperty('accountActor');
    expect(page.messages[0]).not.toHaveProperty('inputAdmissionReceipt');
  });
});
