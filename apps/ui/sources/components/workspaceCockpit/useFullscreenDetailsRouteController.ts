import * as React from 'react';

export type FullscreenDetailsRouteController = Readonly<{
    onRequestClose: () => void;
}>;

export type UseFullscreenDetailsRouteControllerInput = Readonly<{
    resetKey: string | null;
    enabled: boolean;
    isFocused: boolean;
    hydrated: boolean;
    detailsIsOpen: boolean;
    hasDetails: boolean;
    keepRouteWhenEmpty?: boolean;
    keepRouteWhenDetailsClose?: boolean;
    onDismissRoute: () => void;
    onCloseDetails: () => void;
    onUnmount?: () => void;
}>;

export function useFullscreenDetailsRouteController(
    input: UseFullscreenDetailsRouteControllerInput,
): FullscreenDetailsRouteController {
    const dismissedRef = React.useRef(false);
    const previousDetailsIsOpenRef = React.useRef(input.detailsIsOpen);
    const onUnmountRef = React.useRef(input.onUnmount);

    React.useEffect(() => {
        onUnmountRef.current = input.onUnmount;
    }, [input.onUnmount]);

    React.useEffect(() => {
        dismissedRef.current = false;
        previousDetailsIsOpenRef.current = input.detailsIsOpen;
    }, [input.resetKey]);

    React.useEffect(() => {
        return () => {
            onUnmountRef.current?.();
        };
    }, []);

    const dismissRoute = React.useCallback(() => {
        if (dismissedRef.current) {
            return;
        }
        // Closing the pane and its resulting state transition dismiss one route,
        // not two different states of that route.
        dismissedRef.current = true;
        input.onDismissRoute();
    }, [
        input.onDismissRoute,
    ]);

    React.useEffect(() => {
        if (!input.enabled) {
            previousDetailsIsOpenRef.current = input.detailsIsOpen;
            return;
        }
        if (!input.isFocused) {
            previousDetailsIsOpenRef.current = input.detailsIsOpen;
            return;
        }
        if (!input.hydrated) {
            previousDetailsIsOpenRef.current = input.detailsIsOpen;
            return;
        }

        const wasDetailsOpen = previousDetailsIsOpenRef.current;
        previousDetailsIsOpenRef.current = input.detailsIsOpen;

        if (wasDetailsOpen && !input.detailsIsOpen && input.keepRouteWhenDetailsClose !== true) {
            dismissRoute();
            return;
        }

        if (!input.hasDetails && input.keepRouteWhenEmpty !== true) {
            dismissRoute();
        }
    }, [
        dismissRoute,
        input.detailsIsOpen,
        input.enabled,
        input.hasDetails,
        input.hydrated,
        input.isFocused,
        input.keepRouteWhenDetailsClose,
        input.keepRouteWhenEmpty,
        input.resetKey,
    ]);

    const onRequestClose = React.useCallback(() => {
        if (input.detailsIsOpen) {
            input.onCloseDetails();
            dismissRoute();
            return;
        }
        dismissRoute();
    }, [dismissRoute, input.detailsIsOpen, input.onCloseDetails]);

    return {
        onRequestClose,
    };
}
