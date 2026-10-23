import {
    DaemonVoiceInferenceModelsListResponseSchema,
    DaemonVoiceInferenceModelsStatusRequestSchema,
    DaemonVoiceInferenceModelsStatusResponseSchema,
    type DaemonVoiceInferenceModelStatus,
    type DaemonVoiceInferenceModelsListResponse,
    type DaemonVoiceInferenceModelsStatusResponse,
} from '@happier-dev/protocol/daemon/voiceInference';

/** One daemon inventory serves both discovery and exact-pack freshness reads. */
export function answerVoiceModelCatalogRpcRequest(
    request: Readonly<{ method: string; params?: unknown }>,
    models: readonly DaemonVoiceInferenceModelStatus[],
): DaemonVoiceInferenceModelsListResponse | DaemonVoiceInferenceModelsStatusResponse | null {
    if (request.method.endsWith(':daemon.voiceInference.models.list')) {
        return DaemonVoiceInferenceModelsListResponseSchema.parse({ ok: true, models });
    }
    if (request.method.endsWith(':daemon.voiceInference.models.status')) {
        const { packIds } = DaemonVoiceInferenceModelsStatusRequestSchema.parse(request.params);
        return DaemonVoiceInferenceModelsStatusResponseSchema.parse({ ok: true,
            models: packIds ? models.filter(model => packIds.includes(model.packId)) : models });
    }
    return null;
}
