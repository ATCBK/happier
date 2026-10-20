import * as React from 'react';

import type { AgentInputControlId } from './agentInputControlTypes';
import { AGENT_INPUT_CONTROL_REGISTRY } from './agentInputControlRegistry';
import { resolveAgentInputControlLines } from './resolveAgentInputControlLines';

type ControlNodesById = Partial<Record<AgentInputControlId, ReadonlyArray<React.ReactNode>>>;

export function resolveRenderedAgentInputControls(params: Readonly<{
    layout: 'wrap' | 'scroll' | 'collapsed';
    coreControlNodesById: ControlNodesById;
    extraControlNodesById: ControlNodesById;
    extraChips: readonly React.ReactNode[];
    singleRow?: boolean;
    /**
     * Collapsed layout only: the controls the host keeps on its bar, in bar order. Everything
     * else is reached from the actions menu (which omits these). Unset: every control shows.
     */
    barControlIds?: readonly AgentInputControlId[];
    /**
     * Every layout: the only controls this composer contains (a compact composer). Controls outside
     * it, and chips that name no control, are not rendered. Unset: every control the host offers.
     */
    containedControlIds?: readonly AgentInputControlId[];
}>): Readonly<{
    chips: readonly React.ReactNode[];
    /** Location rail controls that lead the folder and resume controls (the machine). */
    secondaryLeadingControls: readonly React.ReactNode[];
    /** Location rail controls that follow them (checkout, session-list folder and tags, automation). */
    secondaryTrailingControls: readonly React.ReactNode[];
    hasPermissionControl: boolean;
}> {
    const contained = params.containedControlIds ? new Set(params.containedControlIds) : null;
    const controlNodesById: ControlNodesById = Object.fromEntries(Object.entries({
        ...params.coreControlNodesById,
        ...params.extraControlNodesById,
    }).filter(([controlId]) => !contained || contained.has(controlId as AgentInputControlId)));
    const extraChips = contained ? [] : params.extraChips;

    const controlIds = Object.entries(controlNodesById)
        .filter(([, nodes]) => (nodes?.length ?? 0) > 0)
        .map(([controlId]) => controlId as AgentInputControlId);

    const controlLines = resolveAgentInputControlLines({
        layout: params.layout,
        controlIds,
        singleRow: params.singleRow,
    });

    const resolveControlNodes = (ids: readonly AgentInputControlId[]) =>
        ids.flatMap((controlId) => controlNodesById[controlId] ?? []);

    // The registry order is the location rail's order: the folder and resume controls sit where the
    // registry puts them and the rail's own row renders them there, so what the registry lists before
    // the folder leads them and what it lists after resume trails them.
    const folderIndex = AGENT_INPUT_CONTROL_REGISTRY.findIndex((control) => control.id === 'path');
    const secondaryPlacement = (controlId: AgentInputControlId) =>
        AGENT_INPUT_CONTROL_REGISTRY.findIndex((control) => control.id === controlId) < folderIndex ? 'leading' : 'trailing';
    const rowControlIds = controlLines.secondary.filter((controlId) => controlId !== 'path' && controlId !== 'resume');
    const secondaryLeadingControls = resolveControlNodes(rowControlIds.filter((controlId) => secondaryPlacement(controlId) === 'leading'));
    const secondaryTrailingControls = resolveControlNodes(rowControlIds.filter((controlId) => secondaryPlacement(controlId) === 'trailing'));

    const chips = params.layout === 'collapsed'
        ? resolveControlNodes(contained ? controlLines.collapsed : params.barControlIds ?? controlLines.collapsed).filter(Boolean)
        : [
            ...resolveControlNodes(controlLines.primary),
            ...extraChips,
        ].filter(Boolean);

    return {
        chips,
        secondaryLeadingControls,
        secondaryTrailingControls,
        hasPermissionControl: (params.layout === 'collapsed'
            ? (contained ? controlLines.collapsed : params.barControlIds ?? controlLines.collapsed)
            : [...controlLines.primary, ...controlLines.secondary]).includes('permission')
            && (controlNodesById.permission?.length ?? 0) > 0,
    };
}
