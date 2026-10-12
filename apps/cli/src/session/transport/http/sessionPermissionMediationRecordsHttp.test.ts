import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import { readPermissionMediationRecordHttp, listPermissionMediationRecordsHttp, writePermissionMediationRecordHttp } from './sessionPermissionMediationRecordsHttp';

describe('permission mediation stored HTTP rows', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['read', 'list', 'write'] as const)('opens retained rows on %s and keeps routing envelopes strict', async (operation) => {
    const identity = { sessionId: 'session', turnId: 'turn', requestId: 'request' };
    const canonical = { ...identity, kind: 'remote_settlement.v1' as const,
      content: { t: 'encrypted' as const, c: 'opaque' }, revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ' };
    const record = { ...canonical, content: { ...canonical.content, retiredField: true } };
    const body = operation === 'list' ? { records: [record], nextCursor: null, hasNext: false } : { record };
    const invalidRecord = { ...canonical, retiredRoutingField: true };
    vi.spyOn(axios, operation === 'write' ? 'put' : 'get')
      .mockResolvedValueOnce({ status: 200, data: body })
      .mockResolvedValueOnce({ status: 200, data: operation === 'list'
        ? { records: [invalidRecord], nextCursor: null, hasNext: false } : { record: invalidRecord } })
      .mockResolvedValueOnce({ status: 200, data: { ...body, retiredEnvelopeField: true } });
    const open = async () => operation === 'read'
      ? readPermissionMediationRecordHttp({ token: 'token', identity })
      : operation === 'list'
        ? (await listPermissionMediationRecordsHttp({ token: 'token', sessionId: identity.sessionId })).records[0]
        : writePermissionMediationRecordHttp({ token: 'token', identity, request: {
          kind: canonical.kind, content: canonical.content, expectedRevision: null,
        } });
    await expect(open()).resolves.toEqual(canonical);
    await expect(open()).rejects.toThrow();
    await expect(open()).rejects.toThrow();
  });
});
