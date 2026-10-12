import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' } });
});

/**
 * R2 (qa-4-design-5): the browser's `getUserMedia` is the boundary. A missing microphone is not a
 * question the user can answer: it must not read as "ask again" (setup's Allow did nothing) nor as
 * a denial (Voice said "Microphone access required … click the lock icon").
 */

function rejectWith(name: string) {
    const getUserMedia = vi.fn(async () => { throw Object.assign(new Error(name), { name }); });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('microphone permission owner', () => {
    it('reports a missing microphone as unavailable rather than as a request to ask again', async () => {
        rejectWith('NotFoundError');
        const { readMicrophonePermissionState, requestMicrophonePermission } = await import('./microphonePermissions');
        const result = await requestMicrophonePermission();
        expect(result.granted).toBe(false);
        expect(readMicrophonePermissionState(result)).toBe('unavailable');
    });

    it('keeps a denial blocked and a grant granted', async () => {
        rejectWith('NotAllowedError');
        const { readMicrophonePermissionState, requestMicrophonePermission } = await import('./microphonePermissions');
        expect(readMicrophonePermissionState(await requestMicrophonePermission())).toBe('denied');
        expect(readMicrophonePermissionState({ granted: true })).toBe('granted');
        expect(readMicrophonePermissionState({ granted: false, canAskAgain: true })).toBe('unknown');
    });

    it('fails a missing microphone as unavailable without the permission recovery, and a denial with it', async () => {
        const { isMicrophoneUnavailableError, rejectRefusedMicrophone } = await import('./microphonePermissions');
        const presentDenied = vi.fn();

        let missing: unknown = null;
        try { rejectRefusedMicrophone({ granted: false, unavailable: true }, presentDenied); } catch (error) { missing = error; }
        expect(isMicrophoneUnavailableError(missing)).toBe(true);
        expect(presentDenied).not.toHaveBeenCalled();

        expect(() => rejectRefusedMicrophone({ granted: false, canAskAgain: false }, presentDenied)).toThrow('mic_permission_denied');
        expect(presentDenied).toHaveBeenCalledExactlyOnceWith(false);
        expect(() => rejectRefusedMicrophone({ granted: true }, presentDenied)).not.toThrow();
    });
});
