import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { McpToolAnnotationsV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { t } from '@/text';

/** What a tool says it does, from its annotations: read-only, writes (the safe assumption), or destructive. */
export type McpToolEffect = 'read' | 'write' | 'destructive';

export function mcpToolEffect(annotations: McpToolAnnotationsV1 | undefined): McpToolEffect {
    if (annotations?.readOnlyHint === true) return 'read';
    if (annotations?.destructiveHint === true) return 'destructive';
    return 'write';
}

/**
 * A tool's annotation badge (Read-only · Writes · Destructive), quiet ink with its glyph; Destructive reads
 * in the primary ink so it is seen before it is allowed. Reused by the session approval card (P8).
 */
export const McpToolDecisionBadges = React.memo(function McpToolDecisionBadges(props: Readonly<{ effect: McpToolEffect; testID?: string }>) {
    const { theme } = useUnistyles();
    const spec = props.effect === 'read'
        ? { icon: 'eye' as const, label: t('capabilities.mcp.tools.readOnly'), color: theme.colors.text.secondary }
        : props.effect === 'destructive'
            ? { icon: 'trash' as const, label: t('capabilities.mcp.tools.destructive'), color: theme.colors.text.primary }
            : { icon: 'pencil-simple' as const, label: t('capabilities.mcp.tools.writes'), color: theme.colors.text.secondary };
    return (
        <StatusPill
            testID={props.testID}
            variant="neutral"
            chrome="plain"
            foregroundColor={spec.color}
            label={spec.label}
            leading={<Icon name={spec.icon} size={ICON_SIZE.xs} color={spec.color} />}
        />
    );
});
