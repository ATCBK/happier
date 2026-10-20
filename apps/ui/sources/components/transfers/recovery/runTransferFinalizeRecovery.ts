import { Modal } from '@/modal';
import type {
    TransferFinalizeRecoveryAction,
    TransferFinalizeRecoveryActionResult,
    TransferFinalizeRecoveryContinuation,
} from '@/sync/domains/transfers/runtime/transferRuntime';

import { TransferFinalizeRecoveryModal } from './TransferFinalizeRecoveryModal';

const MODAL_HOST_UNMOUNTED = Symbol('transfer-finalize-recovery-modal-host-unmounted');

async function chooseTransferFinalizeRecoveryAction(params: Readonly<{
    title: string;
    message: string;
    signal?: AbortSignal | null;
}>): Promise<
    TransferFinalizeRecoveryAction
    | typeof MODAL_HOST_UNMOUNTED
    | null
> {
    if (params.signal?.aborted) return null;
    return await new Promise((resolve) => {
        let modalId: string | undefined;
        let settled = false;
        const finish = (action: TransferFinalizeRecoveryAction | typeof MODAL_HOST_UNMOUNTED | null) => {
            if (settled) return;
            settled = true;
            params.signal?.removeEventListener('abort', onAbort);
            resolve(action);
        };
        const onAbort = () => {
            finish(null);
            if (modalId) Modal.hide(modalId);
        };
        params.signal?.addEventListener('abort', onAbort, { once: true });
        modalId = Modal.show({
            component: TransferFinalizeRecoveryModal,
            closeOnBackdrop: false,
            dismissible: false,
            onHostUnmount: () => finish(MODAL_HOST_UNMOUNTED),
            props: {
                title: params.title,
                message: params.message,
                onResolve: finish,
            },
        });
        if (!modalId) {
            finish(null);
        }
        if (params.signal?.aborted) onAbort();
    });
}

export async function runTransferFinalizeRecovery<TResponse>(params: Readonly<{
    recovery: TransferFinalizeRecoveryContinuation<TResponse>;
    title: string;
    message: string;
    signal?: AbortSignal | null;
}>): Promise<TransferFinalizeRecoveryActionResult<TResponse> | null> {
    while (!params.signal?.aborted) {
        const action = await chooseTransferFinalizeRecoveryAction(params);
        if (!action) return null;
        if (action === MODAL_HOST_UNMOUNTED) continue;
        if (params.signal?.aborted) return null;
        let result: TransferFinalizeRecoveryActionResult<TResponse>;
        try {
            result = await params.recovery.invoke(action, params.signal);
        } catch (error) {
            if (params.signal?.aborted) return null;
            throw error;
        }
        if (params.signal?.aborted) return null;
        if (!params.recovery.isActionable()) return result;
    }
    return null;
}
