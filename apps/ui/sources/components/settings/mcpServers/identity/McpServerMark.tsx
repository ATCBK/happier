import * as React from 'react';
import { Image } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { McpServerCatalogEntryTransportV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';

import { Icon } from '@/components/ui/icons/Icon';

import { resolveTransportIconName } from '../mcpServerUi';

/**
 * The one MCP server mark: the registry's icon when the server came with one, else the neutral glyph for
 * how it runs (the transport glyph). Never a hand-drawn brand
 * mark, never a tile behind it. Used by rows, headers, the homepage ring and the session popover.
 */
export const McpServerMark = React.memo(function McpServerMark(props: Readonly<{
    transport: McpServerCatalogEntryTransportV1;
    iconUrl?: string | null;
    size?: number;
}>) {
    const { theme } = useUnistyles();
    const size = props.size ?? 20;
    if (props.iconUrl) {
        return <Image source={{ uri: props.iconUrl }} style={{ width: size, height: size }} accessibilityIgnoresInvertColors />;
    }
    return <Icon name={resolveTransportIconName(props.transport)} size={size} color={theme.colors.text.secondary} />;
});
