import { afterEach, describe, expect, it, vi } from 'vitest';

import { request } from '../dev/hostRequest.js';

describe('fixture host request', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('surfaces the server error body instead of replacing it with only the HTTP status', async () => {
        vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
            error: 'Session creation failed (session_spawn_failed): Claude CLI was not found.',
        }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
        }));

        await expect(request('/api/leads/northstar/chat', {})).rejects.toThrow(
            'Session creation failed (session_spawn_failed): Claude CLI was not found.',
        );
    });

    it('falls back to the HTTP status when the server has no readable error detail', async () => {
        vi.stubGlobal('fetch', async () => new Response(null, { status: 502 }));

        await expect(request('/api/leads/northstar/chat', {})).rejects.toThrow(
            'Request failed (502)',
        );
    });
});
