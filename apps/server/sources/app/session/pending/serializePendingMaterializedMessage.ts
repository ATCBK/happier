import type { PendingProviderAction } from '@happier-dev/protocol/sessions/pending/pendingProviderAction';
import type { PendingRequestedActionV1 } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import type { SessionInputAdmissionReceiptV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { SessionMessageDeliveryResolutionV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageDeliveryResolutionV1';

type MaterializedPendingMessage = Readonly<{
    id: string | null;
    seq: number | null;
    localId: string;
    messageRole: "user" | "agent" | "event" | "unknown" | null;
    content: PrismaJson.SessionMessageContent;
    requestedAction?: PendingRequestedActionV1;
    providerAction?: PendingProviderAction;
    inputAdmissionReceipt?: SessionInputAdmissionReceiptV1 | null;
    deliveryResolution?: SessionMessageDeliveryResolutionV1 | null;
    createdAt: Date;
    updatedAt: Date;
}>;

export function serializePendingMaterializedMessage(message: MaterializedPendingMessage) {
    return {
        id: message.id,
        seq: message.seq,
        localId: message.localId,
        ...(typeof message.messageRole === "string" ? { messageRole: message.messageRole } : {}),
        content: message.content,
        ...(message.requestedAction ? { requestedAction: message.requestedAction } : {}),
        ...(message.providerAction ? { providerAction: message.providerAction } : {}),
        ...(message.inputAdmissionReceipt ? { inputAdmissionReceipt: message.inputAdmissionReceipt } : {}),
        ...(message.deliveryResolution ? { deliveryResolution: message.deliveryResolution } : {}),
        createdAt: message.createdAt.getTime(),
        updatedAt: message.updatedAt.getTime(),
    };
}
