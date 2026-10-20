import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { resetServerReachabilitySupervisors } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { getFriendsList } from './apiFriends';

afterEach(async () => {
    await resetServerReachabilitySupervisors();
    resetRuntimeFetch();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

const credentials: AuthCredentials = { token: 't', secret: 's' };

function mockError(status: number, payload: unknown) {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
            return Response.json({});
        }
        // Keep status, Headers and body consumption real at the HTTP transport boundary.
        return Response.json(payload, { status });
    });
    setRuntimeFetch(fetch);
    return fetch;
}

describe('getFriendsList', () => {
    it('returns an empty array when the friends routes are not available (404)', async () => {
        mockError(404, { error: 'not_found' });

        await expect(getFriendsList(credentials)).resolves.toEqual([]);
    });
});
