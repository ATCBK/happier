import * as React from 'react';
import { Platform } from 'react-native';
import { useDestinationInstanceKey } from '@/components/appShell/workspace/DestinationInstanceHost';

import { CustomModal } from '@/modal/components/CustomModal';
import {
    buildCommandSurfaceCardChrome,
    COMMAND_SURFACE_WEB_PLACEMENT,
} from '@/modal/components/card/commandSurfaceCard';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import type { CustomModalConfig, CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';

import {
    ExternalSessionsBrowseScreen,
    type ExternalSessionsBrowseScopeLock,
} from './ExternalSessionsBrowseScreen';

export type ExternalSessionsBrowseModalProps = CustomModalInjectedProps & Readonly<{
    lockScope?: ExternalSessionsBrowseScopeLock | null;
    closeButton?: boolean;
}>;

/**
 * Browse external sessions as a command surface: the same card as Search / ⌘K (the command-surface
 * card owner), the search band as its top, "External sessions" as the dialog's accessible name.
 */
export const ExternalSessionsBrowseModal = React.memo(function ExternalSessionsBrowseModal(
    props: ExternalSessionsBrowseModalProps,
) {
    const title = t('externalSessions.browseHeaderTitle');
    const chrome = React.useMemo(() => buildCommandSurfaceCardChrome({
        title,
        testID: 'external-sessions-browse:modal',
        // The browser's band carries the field, Titles | Conversations and its scope chips (lab H2).
        layout: 'detail',
    }), [title]);
    useModalCardChrome(props.setChrome, chrome);
    return (
        <ExternalSessionsBrowseScreen
            lockScope={props.lockScope ?? null}
            onRequestClose={props.onClose}
            closeButton={props.closeButton}
        />
    );
});

/**
 * The `/external/browse` route's host. On web the route is a transparent layer and Browse opens in
 * the command-surface modal, so it shares Search's frame and top placement instead of the router's
 * own drawer; native keeps the navigator's modal screen.
 */
export const ExternalSessionsBrowseSurface = React.memo(function ExternalSessionsBrowseSurface(props: Readonly<{
    lockScope: ExternalSessionsBrowseScopeLock | null;
    onRequestClose: () => void;
}>) {
    const hosted = useDestinationInstanceKey() !== null;
    const modalProps = React.useMemo(() => ({ lockScope: props.lockScope, closeButton: true }), [props.lockScope]);
    const config = React.useMemo<CustomModalConfig<ExternalSessionsBrowseModalProps>>(() => ({
        id: 'external-sessions-browse',
        type: 'custom',
        component: ExternalSessionsBrowseModal,
        props: modalProps,
        webPlacement: COMMAND_SURFACE_WEB_PLACEMENT,
    }), [modalProps]);
    if (hosted || Platform.OS !== 'web') {
        return <ExternalSessionsBrowseScreen lockScope={props.lockScope} onRequestClose={props.onRequestClose} />;
    }
    return <CustomModal visible config={config} onClose={props.onRequestClose} />;
});
