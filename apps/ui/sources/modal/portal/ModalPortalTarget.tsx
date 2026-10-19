import * as React from 'react';

export type ModalPortalTarget = Element | DocumentFragment | null;

const NO_MODAL_PORTAL_PROVIDER = Symbol('happier.modalPortalTarget.noProvider');
type ModalPortalTargetContextValue = ModalPortalTarget | typeof NO_MODAL_PORTAL_PROVIDER;

const ModalPortalTargetContext = React.createContext<ModalPortalTargetContextValue>(NO_MODAL_PORTAL_PROVIDER);

/** The z-index of the dialog layer a subtree renders in; `null` outside any dialog. */
const ModalLayerZIndexContext = React.createContext<number | null>(null);

export function ModalPortalTargetProvider(props: {
    target: ModalPortalTarget;
    /** The dialog's own layer (set by the dialog); nested providers inherit it. */
    layerZIndex?: number;
    children: React.ReactNode;
}) {
    const provided = (
        <ModalPortalTargetContext.Provider value={props.target}>
            {props.children}
        </ModalPortalTargetContext.Provider>
    );
    if (props.layerZIndex === undefined) return provided;
    return <ModalLayerZIndexContext.Provider value={props.layerZIndex}>{provided}</ModalLayerZIndexContext.Provider>;
}

/** A body-level surface opened from inside a dialog stacks above this layer, not below the dialog. */
export function useModalLayerZIndex(): number | null {
    return React.useContext(ModalLayerZIndexContext);
}

export function useModalPortalTarget(): ModalPortalTarget {
    const value = React.useContext(ModalPortalTargetContext);
    return value === NO_MODAL_PORTAL_PROVIDER ? null : value;
}

export function useHasModalPortalTargetProvider(): boolean {
    return React.useContext(ModalPortalTargetContext) !== NO_MODAL_PORTAL_PROVIDER;
}
