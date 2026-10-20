import React from 'react';
import { BaseModal } from './BaseModal';
import {
    CustomModalConfig,
    type CustomModalChromeConfig,
    type CustomModalDismissReason,
} from '../types';
import { ModalCardFrame } from './card/ModalCardFrame';
import { useDeviceType } from '@/utils/platform/responsive';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { areChromeConfigsEqual, mergeChromeConfig, resolveCustomModalPresentation } from './customModalChrome';

interface CustomModalProps {
    config: CustomModalConfig;
    onClose: () => void;
    showBackdrop?: boolean;
    visible: boolean;
    zIndexBase?: number;
}

function isPromiseLikeDismissDecision(value: unknown): value is PromiseLike<boolean | void> {
    return typeof value === 'object'
        && value !== null
        && 'then' in value
        && typeof value.then === 'function';
}


export function CustomModal({ config, onClose, showBackdrop = true, visible, zIndexBase }: CustomModalProps) {
    const Component = config.component;
    const dismissible = config.dismissible !== false;
    const dismissalPendingRef = React.useRef(false);
    const [chromeOverride, setChromeOverride] = React.useState<CustomModalChromeConfig | null | undefined>(undefined);
    const effectiveChrome = chromeOverride === undefined ? config.chrome : chromeOverride;
    const deviceType = useDeviceType();
    const presentation = resolveCustomModalPresentation(effectiveChrome, deviceType);
    const chrome = presentation.card;
    const insets = useChromeSafeAreaInsets();
    const accessibilityLabel = config.accessibilityLabel
        ?? (typeof effectiveChrome?.title === 'string' ? effectiveChrome.title : undefined);

    const completeDismiss = React.useCallback((notifyRequestClose: boolean) => {
        if (notifyRequestClose) {
            try {
                config.onRequestClose?.();
            } catch {
                // A legacy dismissal observer cannot prevent closure.
            }
        }
        onClose();
    }, [config.onRequestClose, onClose]);

    const requestDismiss = React.useCallback((reason: CustomModalDismissReason, notifyRequestClose: boolean) => {
        const dismissalGuard = config.onDismissRequest;
        if (!dismissalGuard) {
            completeDismiss(notifyRequestClose);
            return;
        }
        if (dismissalPendingRef.current) {
            return;
        }

        let decision: boolean | void | PromiseLike<boolean | void>;
        try {
            decision = dismissalGuard(reason);
        } catch {
            // A guard error leaves the modal open.
            return;
        }

        if (!isPromiseLikeDismissDecision(decision)) {
            if (decision !== false) {
                completeDismiss(notifyRequestClose);
            }
            return;
        }

        dismissalPendingRef.current = true;
        void Promise.resolve(decision)
            .then((allowed) => {
                if (allowed !== false) {
                    completeDismiss(notifyRequestClose);
                }
            })
            .catch(() => {
                // A rejected guard leaves the modal open without an unhandled rejection.
            })
            .finally(() => {
                dismissalPendingRef.current = false;
            });
    }, [completeDismiss, config.onDismissRequest]);

    const handleSharedDismiss = React.useCallback(() => {
        if (!dismissible) {
            return;
        }
        requestDismiss('shared', true);
    }, [dismissible, requestDismiss]);

    const handleComponentClose = React.useCallback(() => {
        requestDismiss('action', dismissible);
    }, [dismissible, requestDismiss]);

    const setChrome = React.useCallback((nextChrome: CustomModalChromeConfig | null) => {
        setChromeOverride((prevOverride) => {
            const prevEffective = prevOverride === undefined ? (config.chrome ?? null) : prevOverride;
            const nextEffective = mergeChromeConfig(prevEffective, nextChrome);
            if (areChromeConfigsEqual(prevEffective, nextEffective)) {
                return prevOverride;
            }
            return nextEffective;
        });
    }, [config.chrome]);

    // Card chrome is derived from the modal content's own render output, so applying it must not
    // feed back into that render. Holding the content element identity stable lets React skip the
    // content subtree whenever only chrome state changed; without that, a consumer whose chrome
    // dependencies are not referentially stable republishes on every applied chrome and the
    // publish cycle never closes.
    const content = React.useMemo(() => (
        <Component {...config.props} onClose={handleComponentClose} setChrome={setChrome} />
    ), [Component, config.props, handleComponentClose, setChrome]);

    const { phoneSheet, phoneFullscreen } = presentation;
    return (
        <BaseModal
            visible={visible}
            onClose={handleSharedDismiss}
            accessibilityLabel={accessibilityLabel}
            testID={effectiveChrome?.kind === 'stage' ? effectiveChrome.testID : undefined}
            focusReturnRef={config.focusReturnRef}
            closeOnBackdrop={config.closeOnBackdrop ?? true}
            showBackdrop={showBackdrop && presentation.showBackdrop}
            motion={presentation.motion}
            zIndexBase={zIndexBase}
            webPortalTarget={config.webPortalTarget ?? null}
            webPlacement={config.webPlacement}
            placement={presentation.placement}
            scrollHost={presentation.scrollHost}
        >
            {effectiveChrome?.kind === 'stage' ? content : <ModalCardFrame
                framed={chrome !== null}
                material={chrome?.material}
                header={chrome?.header}
                headerInset={chrome?.headerInset}
                leading={chrome?.leading}
                title={chrome?.title}
                subtitle={chrome?.subtitle}
                actions={chrome?.actions}
                footer={chrome?.footer}
                testID={chrome?.testID}
                titleTestID={chrome?.titleTestID}
                subtitleTestID={chrome?.subtitleTestID}
                closeButtonTestID={chrome?.closeButtonTestID}
                scrollHost={chrome?.scrollHost}
                bodyScroll={chrome?.bodyScroll ?? 'none'}
                dimensions={chrome?.dimensions}
                presentation={phoneFullscreen ? 'fullscreen' : phoneSheet ? 'sheet' : 'card'}
                safeAreaInsets={phoneFullscreen ? insets : undefined}
                sheetBottomInset={phoneSheet ? insets.bottom : undefined}
                onClose={chrome && dismissible ? handleSharedDismiss : undefined}
            >
                {content}
            </ModalCardFrame>}
        </BaseModal>
    );
}
