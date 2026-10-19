import * as React from 'react';

import type { SessionViewportAnchorSnapshot } from '@/sync/sync';

export type TranscriptExperience = 'classic' | 'cockpit';

export type TranscriptExitEntrySnapshot =
    | Readonly<{
        anchor: null;
        capturedAtMs: number;
        isPinned: true;
        offsetY: 0;
        shouldRestoreViewport: false;
    }>
    | Readonly<{
        anchor: SessionViewportAnchorSnapshot;
        capturedAtMs: number;
        isPinned: false;
        offsetY: number;
        shouldRestoreViewport: true;
    }>;

export type TranscriptExitSnapshotSelection = Readonly<{
    source: 'jump-promotion' | 'physical-exit';
    viewport: TranscriptExitEntrySnapshot;
}>;

export type TranscriptSameSessionHandoff = Readonly<{
    fromExperience: TranscriptExperience;
    producerMountToken: object;
    sessionKey: string;
    source: TranscriptExitSnapshotSelection['source'];
    toExperience: TranscriptExperience;
    viewport: TranscriptExitEntrySnapshot;
}>;

export type TranscriptSameSessionHandoffRoute = Readonly<{
    claimAfterCommit(input: Readonly<{
        incomingMountToken: object;
        sessionKey: string;
        toExperience: TranscriptExperience;
    }>): TranscriptSameSessionHandoff | null;
    peekForRender(input: Readonly<{
        incomingMountToken: object;
        sessionKey: string;
        toExperience: TranscriptExperience;
    }>): TranscriptSameSessionHandoff | null;
    prepareReplacement(input: Readonly<{
        fromExperience: TranscriptExperience;
        sessionKey: string;
        toExperience: TranscriptExperience;
    }>): TranscriptSameSessionHandoff | null;
    refreshForDeletion(input: Readonly<{
        producerMountToken: object;
        selection: TranscriptExitSnapshotSelection | null;
        sessionKey: string;
    }>): boolean;
    registerProducer(input: Readonly<{
        captureForHandoff(): TranscriptExitSnapshotSelection | null;
        experience: TranscriptExperience;
        mountToken: object;
        sessionKey: string;
    }>): () => void;
    experience: TranscriptExperience | null;
}>;

const unavailableRoute: TranscriptSameSessionHandoffRoute = {
    claimAfterCommit: () => null,
    peekForRender: () => null,
    prepareReplacement: () => null,
    refreshForDeletion: () => false,
    registerProducer: () => () => undefined,
    experience: null,
};

const TranscriptSameSessionHandoffContext =
    React.createContext<TranscriptSameSessionHandoffRoute>(unavailableRoute);

export function TranscriptSameSessionHandoffProvider(props: Readonly<{
    children(experience: TranscriptExperience): React.ReactNode;
    desiredExperience: TranscriptExperience;
    sessionAddressKey: string;
}>) {
    return (
        <TranscriptSameSessionHandoffProviderForSession
            key={props.sessionAddressKey}
            {...props}
        />
    );
}

function TranscriptSameSessionHandoffProviderForSession(props: Readonly<{
    children(experience: TranscriptExperience): React.ReactNode;
    desiredExperience: TranscriptExperience;
    sessionAddressKey: string;
}>) {
    const [experience, setExperience] = React.useState(props.desiredExperience);
    const producerRef = React.useRef<Readonly<{
        captureForHandoff(): TranscriptExitSnapshotSelection | null;
        experience: TranscriptExperience;
        mountToken: object;
        sessionKey: string;
    }> | null>(null);
    const slotRef = React.useRef<TranscriptSameSessionHandoff | null>(null);
    const route = React.useMemo<TranscriptSameSessionHandoffRoute>(() => {
        const readEligibleSlot = (input: Readonly<{
            incomingMountToken: object;
            sessionKey: string;
            toExperience: TranscriptExperience;
        }>): TranscriptSameSessionHandoff | null => {
            const slot = slotRef.current;
            if (!slot) return null;
            if (input.sessionKey !== props.sessionAddressKey || slot.sessionKey !== input.sessionKey) return null;
            if (slot.toExperience !== input.toExperience) return null;
            if (slot.producerMountToken === input.incomingMountToken) return null;
            return slot;
        };
        return {
            claimAfterCommit(input) {
                const slot = readEligibleSlot(input);
                if (!slot) return null;
                slotRef.current = null;
                return slot;
            },
            peekForRender: readEligibleSlot,
            prepareReplacement(input) {
                if (input.sessionKey !== props.sessionAddressKey) return null;
                if (input.fromExperience === input.toExperience) return null;
                const producer = producerRef.current;
                if (
                    !producer ||
                    producer.sessionKey !== input.sessionKey ||
                    producer.experience !== input.fromExperience
                ) {
                    return null;
                }
                const selection = producer.captureForHandoff();
                if (!selection) {
                    slotRef.current = null;
                    return null;
                }
                const handoff: TranscriptSameSessionHandoff = {
                    fromExperience: input.fromExperience,
                    producerMountToken: producer.mountToken,
                    sessionKey: input.sessionKey,
                    source: selection.source,
                    toExperience: input.toExperience,
                    viewport: selection.viewport,
                };
                slotRef.current = handoff;
                return handoff;
            },
            refreshForDeletion(input) {
                const slot = slotRef.current;
                if (
                    !slot ||
                    !input.selection ||
                    input.sessionKey !== props.sessionAddressKey ||
                    slot.sessionKey !== input.sessionKey ||
                    slot.producerMountToken !== input.producerMountToken
                ) {
                    return false;
                }
                slotRef.current = {
                    ...slot,
                    source: input.selection.source,
                    viewport: input.selection.viewport,
                };
                return true;
            },
            registerProducer(input) {
                if (input.sessionKey !== props.sessionAddressKey) return () => undefined;
                const current = producerRef.current;
                if (current && current.mountToken !== input.mountToken) {
                    return () => undefined;
                }
                // A layout change can now retain the physical transcript. Its
                // own snapshot is not a handoff to a future unrelated remount.
                const slot = slotRef.current;
                if (slot?.producerMountToken === input.mountToken && slot.toExperience === input.experience) {
                    slotRef.current = null;
                }
                producerRef.current = input;
                return () => {
                    if (producerRef.current?.mountToken === input.mountToken) {
                        producerRef.current = null;
                    }
                };
            },
            experience,
        };
    }, [experience, props.sessionAddressKey]);

    React.useLayoutEffect(() => {
        return () => {
            producerRef.current = null;
            slotRef.current = null;
        };
    }, [props.sessionAddressKey]);

    React.useLayoutEffect(() => {
        if (props.desiredExperience === experience) return;
        route.prepareReplacement({
            fromExperience: experience,
            sessionKey: props.sessionAddressKey,
            toExperience: props.desiredExperience,
        });
        setExperience(props.desiredExperience);
    }, [experience, props.desiredExperience, props.sessionAddressKey, route]);

    return (
        <TranscriptSameSessionHandoffContext.Provider value={route}>
            {props.children(experience)}
        </TranscriptSameSessionHandoffContext.Provider>
    );
}

export function useTranscriptSameSessionHandoffRoute(): TranscriptSameSessionHandoffRoute {
    return React.useContext(TranscriptSameSessionHandoffContext);
}

export function useTranscriptSameSessionHandoff(deps: Readonly<{
    captureForHandoff(): TranscriptExitSnapshotSelection | null;
    explicitJump: boolean;
    sessionKey: string;
}>): Readonly<{
    claimedViewportRef: React.MutableRefObject<TranscriptExitEntrySnapshot | null>;
    refreshForDeletion(selection: TranscriptExitSnapshotSelection | null): void;
    renderViewport: TranscriptExitEntrySnapshot | null;
}> {
    const route = useTranscriptSameSessionHandoffRoute();
    const mountTokenRef = React.useRef<object | null>(null);
    if (mountTokenRef.current === null) {
        mountTokenRef.current = {};
    }
    const mountToken = mountTokenRef.current;
    const renderHandoff = !deps.explicitJump && route.experience
        ? route.peekForRender({
            incomingMountToken: mountToken,
            sessionKey: deps.sessionKey,
            toExperience: route.experience,
        })
        : null;
    const claimedViewportRef = React.useRef<TranscriptExitEntrySnapshot | null>(null);

    React.useInsertionEffect(() => {
        if (!route.experience) return;
        const claimed = route.claimAfterCommit({
            incomingMountToken: mountToken,
            sessionKey: deps.sessionKey,
            toExperience: route.experience,
        });
        if (!deps.explicitJump && claimedViewportRef.current === null) {
            claimedViewportRef.current = claimed?.viewport ?? null;
        }
    }, [deps.explicitJump, deps.sessionKey, mountToken, route]);

    React.useLayoutEffect(() => {
        if (!route.experience) return;
        return route.registerProducer({
            captureForHandoff: deps.captureForHandoff,
            experience: route.experience,
            mountToken,
            sessionKey: deps.sessionKey,
        });
    }, [deps.captureForHandoff, deps.sessionKey, mountToken, route]);

    const refreshForDeletion = React.useCallback((
        selection: TranscriptExitSnapshotSelection | null,
    ) => {
        route.refreshForDeletion({
            producerMountToken: mountToken,
            selection,
            sessionKey: deps.sessionKey,
        });
    }, [deps.sessionKey, mountToken, route]);

    return {
        claimedViewportRef,
        refreshForDeletion,
        renderViewport: renderHandoff?.viewport ?? null,
    };
}
