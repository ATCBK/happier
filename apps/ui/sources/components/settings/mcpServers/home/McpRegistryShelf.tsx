import * as React from 'react';
import { Image } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { RegistryShelf, type RegistryShelfCard } from '@/components/capabilities/add/RegistryShelf';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { useRegistrySources } from '@/registries/useRegistrySources';
import { t } from '@/text';

import type { McpHomeServer } from './mcpHomeModel';

/**
 * The registry's suggested servers (P4's one rule, IR-79: Happier picks, else the first page of the
 * built-in MCP registry) as the shared three-card shelf. A server already added reads Open.
 */
export const McpRegistryShelf = React.memo(function McpRegistryShelf(props: Readonly<{
    shelf: Readonly<{ items: readonly RegistryShelfCard[]; sourceId: string | null; loading: boolean }>;
    servers: readonly McpHomeServer[];
    onAdd: (card: RegistryShelfCard) => void;
    onOpen: (serverId: string) => void;
}>) {
    const sources = useRegistrySources('mcpServer');
    const sourceTitle = sources.sources.find((source) => source.id === props.shelf.sourceId)?.title ?? null;
    const { servers, onAdd, onOpen } = props;
    const addedId = React.useCallback((card: RegistryShelfCard) => servers.find((server) => {
        const origin = server.server.origin;
        return origin?.kind === 'registry' && origin.provenance.sourceId === card.sourceId && origin.provenance.itemId === card.itemId;
    })?.id ?? null, [servers]);
    // The publisher, unless it only repeats the name ("Notion" by Notion).
    const where = React.useCallback((card: RegistryShelfCard) => (card.publisher && card.publisher.name !== card.title ? card.publisher.name : null), []);
    const glyph = React.useCallback((card: RegistryShelfCard) => (card.iconUrl
        ? <Image source={{ uri: card.iconUrl }} style={styles.mark} accessibilityIgnoresInvertColors />
        : null), []);
    const action = React.useCallback((card: RegistryShelfCard) => {
        const added = addedId(card);
        return added ? (
            <RoundButton testID={`mcp.home.shelf.${card.itemId}.open`} size="small" display="secondary" title={t('common.open')} onPress={() => onOpen(added)} />
        ) : (
            <RoundButton testID={`mcp.home.shelf.${card.itemId}.add`} size="small" display="secondary" title={t('capabilities.mcpHome.shelfAdd')} onPress={() => onAdd(card)} />
        );
    }, [addedId, onAdd, onOpen]);
    return (
        <RegistryShelf
            testID="mcp.home.shelf"
            title={t('capabilities.mcpHome.shelfTitle')}
            {...(sourceTitle ? { description: t('capabilities.mcpHome.shelfFrom', { source: sourceTitle }) } : {})}
            items={props.shelf.items}
            loading={props.shelf.loading}
            where={where}
            glyph={glyph}
            action={action}
            columnTitle={t('settings.mcpServers')}
        />
    );
});

const styles = StyleSheet.create(() => ({
    mark: { width: 26, height: 26 },
}));
