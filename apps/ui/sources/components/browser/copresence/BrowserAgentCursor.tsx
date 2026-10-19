import {
    HappierAgentCursor,
    type HappierAgentPageRect,
    type HappierAgentPoint,
    type HappierAgentTarget,
} from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { reanimatedAgentCursorMotion } from '@/components/ui/motion/reanimatedAgentCursorMotion';
import { CORE_CAPSULE_HOST } from '@/components/ui/status/capsuleHost';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

/**
 * Happier core's binding of the one agent cursor (`HappierAgentCursor` in
 * `@happier-dev/plugin-ui/presentation`, the same owner plugins draw): the agent's hand on the page and
 * the cased ring around the element it acts on. This binding supplies only the app's leaves: the agent
 * mark from the catalog, the icon pack, the Reanimated motion, the reduced-motion preference and the
 * colour tokens (agent marks are monochrome `text.primary`; the catalog carries no per-agent accent).
 */
export function BrowserAgentCursor(props: Readonly<{
    target: HappierAgentTarget | null;
    /** The agent's latest pointer action, so a short one is still shown (see `HappierAgentPoint`). */
    point?: HappierAgentPoint | null;
    /** The drawn page inside this layer, when it does not fill it (a fitted stream). */
    pageRect?: HappierAgentPageRect | null;
    agentId?: string | null;
    testID: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const colors = React.useMemo(() => ({
        line: theme.colors.text.primary,
        casing: theme.colors.surface.base,
    }), [theme.colors.surface.base, theme.colors.text.primary]);
    const agentId = props.agentId;
    const renderAgentMark = React.useMemo(
        () => (agentId ? (size: number) => <AgentIcon agentId={agentId} size={size} /> : undefined),
        [agentId],
    );
    return (
        <HappierAgentCursor
            target={props.target}
            point={props.point}
            pageRect={props.pageRect}
            renderAgentMark={renderAgentMark}
            renderGlyph={CORE_CAPSULE_HOST.renderGlyph}
            colors={colors}
            reducedMotion={reducedMotion}
            motion={reanimatedAgentCursorMotion}
            testID={props.testID}
        />
    );
}
