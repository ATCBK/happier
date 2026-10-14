import { proxyLocalServicePreviewHttpRequest as proxyShared, type ProxyLocalServicePreviewHttpRequestInput as SharedInput } from "@happier-dev/peer-mediation/localServices/preview/httpAdapter";
import { createPeerMediationFlowEvent, createPeerMediationHttpRequestFinishedEvent, createPeerMediationHttpRequestStartedEvent, createPeerMediationHttpRequestAbortedEvent, type PeerMediationObservabilityEmitter } from "@/app/api/socket/peer/mediation/observability/events";
import { log } from "@/utils/logging/log";
import { prepareCooperativePreview } from './collectorBootstrap';
export * from "@happier-dev/peer-mediation/localServices/preview/httpAdapter";
export type ProxyLocalServicePreviewHttpRequestInput = Omit<SharedInput, "observability" | "openTunnel"> & Readonly<{
    observability?: PeerMediationObservabilityEmitter;
    openTunnel?: SharedInput['openTunnel'];
}>;
export async function proxyLocalServicePreviewHttpRequest(input: ProxyLocalServicePreviewHttpRequestInput) {
    const prepared = await prepareCooperativePreview(input);
    if (!prepared) return { ok: true } as const;
    const observability = input.observability;
    return await proxyShared({
        ...prepared,
        // Routes with no transport use the same typed refusal as a tunnel that cannot open.
        openTunnel: prepared.openTunnel ?? (async () => { throw new Error('pms_tunnel_unavailable'); }),
        onTransportUnavailable: (event) => {
            prepared.onTransportUnavailable?.(event);
            log(event, `Local service preview tunnel unavailable: ${event.reasonCode}`);
        },
        observability: observability ? {
            createPeerMediationFlowEvent: (event) => observability.emit(createPeerMediationFlowEvent(event)),
            createPeerMediationHttpRequestFinishedEvent: (event) => observability.emit(createPeerMediationHttpRequestFinishedEvent(event)),
            createPeerMediationHttpRequestStartedEvent: (event) => observability.emit(createPeerMediationHttpRequestStartedEvent(event)),
            createPeerMediationHttpRequestAbortedEvent: (event) => observability.emit(createPeerMediationHttpRequestAbortedEvent(event)),
        } : undefined,
    });
}
