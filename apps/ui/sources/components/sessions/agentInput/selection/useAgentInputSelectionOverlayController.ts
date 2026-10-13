import * as React from 'react';

import {
    hasAgentInputCollapsedOptionsPopoverContent,
    type AgentInputExtraActionChip,
    type AgentInputPopoverAnchor,
} from '../agentInputContracts';
import type {
    AgentInputSelectionOverlayId,
    AgentInputSelectionOverlayState,
} from './agentInputSelectionOverlayTypes';

function isCollapsedExtraOverlay(
    overlay: AgentInputSelectionOverlayState | null,
): overlay is Extract<AgentInputSelectionOverlayState, { id: 'collapsedExtra' }> {
    return overlay?.id === 'collapsedExtra';
}

function hasSameOverlayIdentity(
    left: AgentInputSelectionOverlayState | null,
    right: AgentInputSelectionOverlayState | null,
): boolean {
    if (!left || !right) return left === right;
    if (left.id !== right.id) return false;
    if (left.id !== 'collapsedExtra' || right.id !== 'collapsedExtra') return true;
    return left.chipKey === right.chipKey;
}

function hasCollapsedExtraPopover(chip: AgentInputExtraActionChip): boolean {
    return Boolean(
        chip.renderCollapsedPopover
        || (
            chip.collapsedOptionsPopover
            && hasAgentInputCollapsedOptionsPopoverContent(chip.collapsedOptionsPopover)
        )
        || chip.collapsedContentPopover,
    );
}

function isSelectionOverlaySupported(
    overlay: AgentInputSelectionOverlayState | null,
    params: Readonly<{
        shouldRenderSessionModeChip: boolean;
        canChangePermission: boolean;
        hasMachinePopover: boolean;
        hasPathPopover: boolean;
        hasResumePopover: boolean;
        hasProfilePopover: boolean;
        hasEnvVarsPopover: boolean;
        hasAgentPickerOptions: boolean;
        extraActionChips?: ReadonlyArray<AgentInputExtraActionChip>;
    }>,
): boolean {
    if (!overlay) return true;

    switch (overlay.id) {
        case 'agent':
            return params.hasAgentPickerOptions;
        case 'sessionMode':
            return params.shouldRenderSessionModeChip;
        case 'permission':
            return params.canChangePermission;
        case 'machine':
            return params.hasMachinePopover;
        case 'path':
            return params.hasPathPopover;
        case 'resume':
            return params.hasResumePopover;
        case 'profile':
            return params.hasProfilePopover;
        case 'envVars':
            return params.hasEnvVarsPopover;
        case 'collapsedExtra':
            return (params.extraActionChips ?? []).some((chip) => (
                chip.key === overlay.chipKey
                && chip.controlId
                && hasCollapsedExtraPopover(chip)
            ));
    }
}

export function useAgentInputSelectionOverlayController(params: Readonly<{
    shouldRenderSessionModeChip: boolean;
    canChangePermission: boolean;
    hasMachinePopover: boolean;
    hasPathPopover: boolean;
    hasResumePopover: boolean;
    hasProfilePopover: boolean;
    hasEnvVarsPopover: boolean;
    hasAgentPickerOptions: boolean;
    extraActionChips?: ReadonlyArray<AgentInputExtraActionChip>;
    retainKeyboardLift?: () => () => void;
    onSelectionOverlayDismiss?: (id: AgentInputSelectionOverlayId) => void;
}>): Readonly<{
    activeSelectionOverlay: AgentInputSelectionOverlayState | null;
    isSelectionOverlayOpen: (id: AgentInputSelectionOverlayId) => boolean;
    openSelectionOverlay: (
        id: AgentInputSelectionOverlayId,
        anchor: AgentInputPopoverAnchor,
        chipKey?: string,
    ) => void;
    toggleSelectionOverlay: (
        id: AgentInputSelectionOverlayId,
        anchor: AgentInputPopoverAnchor,
        chipKey?: string,
    ) => void;
    closeSelectionOverlay: (id?: AgentInputSelectionOverlayId) => void;
    resetSelectionOverlays: () => void;
    closeAllSelectionOverlays: () => void;
    activeExtraCollapsedPopoverChip: AgentInputExtraActionChip | null;
}> {
    const [activeSelectionOverlay, setActiveSelectionOverlay] = React.useState<AgentInputSelectionOverlayState | null>(null);
    const activeSelectionOverlayRef = React.useRef<AgentInputSelectionOverlayState | null>(null);
    const onSelectionOverlayDismissRef = React.useRef(params.onSelectionOverlayDismiss);
    onSelectionOverlayDismissRef.current = params.onSelectionOverlayDismiss;
    const releaseKeyboardLiftRef = React.useRef<(() => void) | null>(null);

    const replaceActiveSelectionOverlay = React.useCallback((next: AgentInputSelectionOverlayState | null) => {
        const previous = activeSelectionOverlayRef.current;
        activeSelectionOverlayRef.current = next;
        if (previous && !hasSameOverlayIdentity(previous, next)) {
            onSelectionOverlayDismissRef.current?.(previous.id);
        }
        setActiveSelectionOverlay(next);
    }, []);

    const retainKeyboardLift = React.useCallback(() => {
        if (releaseKeyboardLiftRef.current) return;
        releaseKeyboardLiftRef.current = params.retainKeyboardLift?.() ?? null;
    }, [params.retainKeyboardLift]);

    const releaseKeyboardLift = React.useCallback(() => {
        const release = releaseKeyboardLiftRef.current;
        releaseKeyboardLiftRef.current = null;
        release?.();
    }, []);

    const activeExtraCollapsedPopoverChip = React.useMemo(() => {
        if (!isCollapsedExtraOverlay(activeSelectionOverlay)) return null;
        const activeChipKey = activeSelectionOverlay.chipKey;
        return (
            (params.extraActionChips ?? []).find((chip) => (
                chip.key === activeChipKey
                && chip.controlId
                && hasCollapsedExtraPopover(chip)
            )) ?? null
        );
    }, [activeSelectionOverlay, params.extraActionChips]);

    React.useEffect(() => {
        if (!isSelectionOverlaySupported(activeSelectionOverlay, params)) {
            replaceActiveSelectionOverlay(null);
        }
    }, [
        activeSelectionOverlay,
        params.canChangePermission,
        params.extraActionChips,
        params.hasMachinePopover,
        params.hasAgentPickerOptions,
        params.hasPathPopover,
        params.hasResumePopover,
        params.hasEnvVarsPopover,
        params.hasProfilePopover,
        params.shouldRenderSessionModeChip,
        replaceActiveSelectionOverlay,
    ]);

    React.useEffect(() => {
        if (activeSelectionOverlay) {
            retainKeyboardLift();
            return;
        }
        releaseKeyboardLift();
    }, [activeSelectionOverlay, releaseKeyboardLift, retainKeyboardLift]);

    React.useEffect(() => releaseKeyboardLift, [releaseKeyboardLift]);

    const isSelectionOverlayOpen = React.useCallback((id: AgentInputSelectionOverlayId) => {
        return activeSelectionOverlay?.id === id;
    }, [activeSelectionOverlay]);

    const openSelectionOverlay = React.useCallback((
        id: AgentInputSelectionOverlayId,
        anchor: AgentInputPopoverAnchor,
        chipKey?: string,
    ) => {
        if (id === 'collapsedExtra') {
            if (!chipKey || chipKey.length === 0) {
                releaseKeyboardLift();
                replaceActiveSelectionOverlay(null);
                return;
            }
            retainKeyboardLift();
            replaceActiveSelectionOverlay({ id, anchor, chipKey });
            return;
        }
        retainKeyboardLift();
        replaceActiveSelectionOverlay({ id, anchor });
    }, [releaseKeyboardLift, replaceActiveSelectionOverlay, retainKeyboardLift]);

    const toggleSelectionOverlay = React.useCallback((
        id: AgentInputSelectionOverlayId,
        anchor: AgentInputPopoverAnchor,
        chipKey?: string,
    ) => {
        retainKeyboardLift();
        const current = activeSelectionOverlayRef.current;
        const collapsedChipKey = current?.id === 'collapsedExtra' ? current.chipKey : null;
        const matchesRequestedOverlay = current?.id === id
            && current.anchor === anchor
            && (id !== 'collapsedExtra' || collapsedChipKey === chipKey);
        if (matchesRequestedOverlay) {
            replaceActiveSelectionOverlay(null);
            return;
        }
        if (id === 'collapsedExtra') {
            replaceActiveSelectionOverlay(chipKey ? { id, anchor, chipKey } : null);
            return;
        }
        replaceActiveSelectionOverlay({ id, anchor });
    }, [replaceActiveSelectionOverlay, retainKeyboardLift]);

    const closeSelectionOverlay = React.useCallback((id?: AgentInputSelectionOverlayId) => {
        const current = activeSelectionOverlayRef.current;
        if (!current || (id && current.id !== id)) return;
        replaceActiveSelectionOverlay(null);
    }, [replaceActiveSelectionOverlay]);

    const resetSelectionOverlays = React.useCallback(() => {
        releaseKeyboardLift();
        replaceActiveSelectionOverlay(null);
    }, [releaseKeyboardLift, replaceActiveSelectionOverlay]);

    return {
        activeSelectionOverlay,
        isSelectionOverlayOpen,
        openSelectionOverlay,
        toggleSelectionOverlay,
        closeSelectionOverlay,
        resetSelectionOverlays,
        closeAllSelectionOverlays: resetSelectionOverlays,
        activeExtraCollapsedPopoverChip,
    };
}
