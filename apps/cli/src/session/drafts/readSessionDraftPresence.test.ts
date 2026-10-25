import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { readSessionDraftPresence } from './readSessionDraftPresence';

// The authenticated HTTP boundary is the only mock; paging and schema reads stay real.
vi.mock('axios', () => ({ default: { post: vi.fn() } }));
const requester = { token: 'requester-token', serverHttpBaseUrl: 'https://server.invalid', isCurrent: async () => true };

describe('session draft presence', () => {
  // Discussion and new-Discussion drafts are Account-owned and carry no Session id, so only these kinds can mark a Session.
  it.each(['session', 'run'] as const)('finds a %s draft after a page of unrelated/deleted drafts', async kind => {
    vi.mocked(axios.post).mockReset().mockResolvedValueOnce({ data: { items: [{
      address: { kind: 'session', sessionId: 'another' }, content: null, revision: 1, createdAt: 1, updatedAt: 2,
    }], nextAfter: 'session/another' } }).mockResolvedValueOnce({ data: { items: [{
      address: { kind, sessionId: 'target', ...(kind === 'run' ? { runId: 'run-1' } : {}) },
      content: { t: 'encrypted', c: 'opaque' }, revision: 1, createdAt: 1, updatedAt: 20,
    }] } });
    expect(await readSessionDraftPresence({ sessionId: 'target', requester })).toEqual({ status: 'present', updatedAt: 20 });
  });
  it('proves absent only after complete paging and ignores tombstones', async () => {
    vi.mocked(axios.post).mockReset().mockResolvedValue({ data: { items: [{
      address: { kind: 'session', sessionId: 'target' }, content: null, revision: 1, createdAt: 1, updatedAt: 2,
    }] } });
    expect(await readSessionDraftPresence({ sessionId: 'target', requester })).toEqual({ status: 'absent', updatedAt: 2 });
  });
  it('fails closed for missing requester authority, expired admission, unavailable predecessors and malformed pages', async () => {
    vi.mocked(axios.post).mockReset().mockRejectedValueOnce(new Error('404')).mockResolvedValueOnce({ data: { items: [{}] } });
    expect(await readSessionDraftPresence({ sessionId: 'target', requester: null })).toEqual({ status: 'unknown' });
    expect(await readSessionDraftPresence({ sessionId: 'target', requester: { ...requester, isCurrent: async () => false } })).toEqual({ status: 'unknown' });
    expect(await readSessionDraftPresence({ sessionId: 'target', requester })).toEqual({ status: 'unknown' });
    expect(await readSessionDraftPresence({ sessionId: 'target', requester })).toEqual({ status: 'unknown' });
  });
});
