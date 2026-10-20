import { fireAndForget } from '@/utils/system/fireAndForget';
import { createFrontDoorUiActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { getVoiceSessionPresentedAttemptId } from '@/voice/session/voiceSessionStore';
import { VoiceConversationActionOutputSchemas } from '@happier-dev/protocol/actions/voiceConversationActionFamily';

const executeAction = createFrontDoorUiActionExecutor();


/**
 * The Voice surface's own actions. Recovery is **not** one of them: the
 * placement-neutral attempt projection owns the single recovery derivation and
 * dispatch every surface fires (`voiceAttemptRecovery.ts`).
 */
export function createVoiceSurfaceActionHandlers(params: Readonly<{
    sessionId: string | null | undefined;
    snapSessionId: string | null;
    expectedAttempt?: string | null;
}>) {
    const expectedAttempt = params.expectedAttempt ?? getVoiceSessionPresentedAttemptId();
    const turnControl = async (control: 'interrupt' | 'cancel') => {
        if (!params.snapSessionId?.trim() || !expectedAttempt) return false;
        try {
            const result = await executeAction('ui.voice_global.turn_control', { expectedAttempt, control });
            return VoiceConversationActionOutputSchemas['ui.voice_global.turn_control'].parse(result).status === 'completed';
        } catch (error) {
            fireAndForget(Promise.reject(error), { tag: `VoiceSurface.${control}` });
            return false;
        }
    };
    return {
        onBargeIn: () => turnControl('interrupt'),
        onCancelTurn: () => turnControl('cancel'),
        onTeleport: () => {
            const sessionId = String(params.sessionId ?? '').trim();
            if (!sessionId) return;
            fireAndForget(executeAction('ui.voice_agent.teleport', { sessionId }), { tag: 'VoiceSurface.teleport' });
        },
    };
}
