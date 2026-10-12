import { rejectRefusedMicrophone, requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/platform/microphonePermissions';
import {
    getVoiceNativeWebRtcRuntime,
    type VoiceNativeWebRtcMediaStream,
} from '@/voice/runtime/nativeWebRtcRuntime';

import { createNativeMicSession } from './NativeMicSession';
import type { CreateMicSessionOptions } from './MicSession';

export function createRealtimeMicSession(options: CreateMicSessionOptions = {}) {
    return createNativeMicSession({
        ...(options.onFailure ? { onFailure: options.onFailure } : {}),
        ensurePermission: async () => {
            rejectRefusedMicrophone(await requestMicrophonePermission(), showMicrophonePermissionDeniedAlert);
        },
        acquireStream: async () => {
            const { mediaDevices } = getVoiceNativeWebRtcRuntime();
            return (await mediaDevices.getUserMedia({ audio: true, video: false })) as unknown as MediaStream;
        },
        releaseStream: (stream) => {
            (stream as unknown as VoiceNativeWebRtcMediaStream).release();
        },
    });
}
