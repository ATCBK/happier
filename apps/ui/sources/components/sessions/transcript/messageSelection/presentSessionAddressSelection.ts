import { Modal } from '@/modal';
import { createDeferredOnce } from '@/modal/async/createDeferredOnce';
import { t } from '@/text';

import { TranscriptSendToSessionModal } from './TranscriptSendToSessionModal';
import { TRANSCRIPT_SEND_TO_SESSION_MODAL_DEFAULT_MAX_HEIGHT_RATIO, TRANSCRIPT_SEND_TO_SESSION_MODAL_SIZE,
    TRANSCRIPT_SEND_TO_SESSION_MODAL_WIDTH } from './resolveTranscriptSendToSessionModalLayout';
import type { SendTranscriptSelectionDestination } from './sendTranscriptSelectionToSession';

/** No-invoke reference mode of the incumbent Home-scoped native Session picker. */
export function presentSessionAddressSelection(serverId: string) {
    const deferred = createDeferredOnce<SendTranscriptSelectionDestination | null>();
    let modalId = '';
    let closed = false;
    const settle = (selection: SendTranscriptSelectionDestination | null) => {
        if (closed) return;
        closed = true;
        deferred.resolve(selection);
        if (modalId) Modal.hide(modalId);
    };
    const close = () => settle(null);
    modalId = Modal.show({
        component: TranscriptSendToSessionModal,
        props: { selectionOnly: true, sourceServerId: serverId, onResolve: settle },
        onRequestClose: close,
        onHostUnmount: close,
        closeOnBackdrop: true,
        chrome: { kind: 'card', title: t('sessionGettingStarted.title.selectSession'), dimensions: {
            width: TRANSCRIPT_SEND_TO_SESSION_MODAL_WIDTH,
            maxHeightRatio: TRANSCRIPT_SEND_TO_SESSION_MODAL_DEFAULT_MAX_HEIGHT_RATIO,
            size: TRANSCRIPT_SEND_TO_SESSION_MODAL_SIZE,
        } },
    });
    if (!modalId) close();
    else if (closed) Modal.hide(modalId);
    return { result: deferred.promise, close };
}
