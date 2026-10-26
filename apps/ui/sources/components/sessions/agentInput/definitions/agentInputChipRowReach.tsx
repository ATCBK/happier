import * as React from 'react';
import { HappierComposerChip, type HappierComposerChipProps } from '@happier-dev/plugin-ui/presentation';

/**
 * A new session's composer stacks two chip rows (setup chips over machine · folder · resume), at least 1 px
 * apart (the web action bar's row gap, `WEB_ACTION_BAR_ROW_GAP_MOBILE_Y`). Each row's hit areas take half
 * that gap, so the two rows meet and never overlap; the free sides keep the target's full reach.
 */
const HALF_ROW_GAP_PX = 0.5;
export const AGENT_INPUT_CHIP_ROW_HIT_REACH = {
    /** Chips in the row above another chip row. */
    upper: { bottom: HALF_ROW_GAP_PX },
    /** Chips in the row below another chip row. */
    lower: { top: HALF_ROW_GAP_PX },
} as const;

const AgentInputChipRowReachContext = React.createContext<HappierComposerChipProps['hitReach']>(undefined);

/** The row's chips (every {@link AgentInputRailChip} under it) take this reach. */
export function AgentInputChipRowReach(props: Readonly<{
    reach: HappierComposerChipProps['hitReach'];
    children: React.ReactNode;
}>) {
    return <AgentInputChipRowReachContext.Provider value={props.reach}>{props.children}</AgentInputChipRowReachContext.Provider>;
}

/** The composer's rail chip: the shared chip shell with the reach its row declares. */
export const AgentInputRailChip = React.forwardRef<unknown, HappierComposerChipProps>(
    function AgentInputRailChip(props, ref) {
        const rowReach = React.useContext(AgentInputChipRowReachContext);
        return <HappierComposerChip ref={ref} {...props} hitReach={props.hitReach ?? rowReach} />;
    },
);
