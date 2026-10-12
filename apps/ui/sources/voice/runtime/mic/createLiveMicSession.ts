import { rejectRefusedMicrophone, requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/platform/microphonePermissions';

import { createNativeMicSession } from './NativeMicSession';
import type { CreateMicSessionOptions } from './MicSession';

export function createLiveMicSession(options: CreateMicSessionOptions = {}) {
    return createNativeMicSession({
        ...(options.onFailure ? { onFailure: options.onFailure } : {}),
        ensureActive: async () => {
            rejectRefusedMicrophone(await requestMicrophonePermission(), showMicrophonePermissionDeniedAlert);
        },
    });
}
