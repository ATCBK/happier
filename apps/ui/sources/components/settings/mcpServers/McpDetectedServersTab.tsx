import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { DaemonMcpServersDetectWarningV1, DetectedMcpServerV1 } from '@happier-dev/protocol';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PathInputBrowseButton } from '@/components/ui/pathBrowser/PathInputBrowseButton';
import { openMachinePathBrowserModal } from '@/components/ui/pathBrowser/openMachinePathBrowserModal';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { t } from '@/text';

import { formatDetectedWarning, resolveDetectedServerStatusLabel } from './mcpServerUi';
import { SettingRow } from '@/components/settings/shell/SettingRow';
import { MCP_FOUND_SETTINGS } from '@/components/settings/mcpServers/mcpSettings';
import { collectionListStyles } from '@/components/ui/lists/collection/CollectionList';

/** A finding is named by the Agent that configures it and its name; a rescan hands back new objects for the same finding. */
const isSameFinding = (left: DetectedMcpServerV1 | null | undefined, right: DetectedMcpServerV1) =>
    left?.provider === right.provider && left?.name === right.name;

/**
 * The servers other agents configure on the managed machine: where to look, what was found, and an
 * Import for each. Everything here reads the machine, so it waits on the page's machine chip.
 */
export const McpDetectedServersTab = React.memo(function McpDetectedServersTab(props: Readonly<{
    selectedMachineId: string | null;
    selectedServerId: string | null;
    canExecute: boolean;
    canImport: boolean;
    directory: string;
    onChangeDirectory: (value: string) => void;
    loading: boolean;
    detected: DetectedMcpServerV1[] | null;
    warnings: DaemonMcpServersDetectWarningV1[] | null;
    onRefresh: () => void;
    onImport: (server: DetectedMcpServerV1) => void;
    /** The finding being added, and what asks for the values it names; the panel opens under that finding's row. */
    adopting?: DetectedMcpServerV1 | null;
    adoptionPanel?: React.ReactNode;
}>) {
    const handleBrowseDirectory = React.useCallback(async () => {
        if (!props.selectedMachineId || !props.selectedServerId || !props.canExecute) return;
        const selected = await openMachinePathBrowserModal({
            machineId: props.selectedMachineId,
            serverId: props.selectedServerId,
            initialPath: props.directory,
            title: t('settings.mcpServersDetectedDirectoryTitle'),
        });
        if (selected) {
            props.onChangeDirectory(selected);
        }
    }, [props.canExecute, props.directory, props.onChangeDirectory, props.selectedMachineId, props.selectedServerId]);

    return (
        <>
            <ItemGroup
                title={t('mcpSettings.onMachineSearchSection')}
                description={t('mcpSettings.onMachineSearchDescription')}
                action={(
                    <SectionActionButton
                        testID="settings.mcpServers.detect.refresh"
                        icon="magnifying-glass"
                        title={t('mcpSettings.scan')}
                        loading={props.loading}
                        disabled={props.loading || !props.canExecute}
                        onPress={props.onRefresh}
                    />
                )}
            >
                <SettingRow
                    testID="settings.mcpServers.detect.directory"
                    setting={MCP_FOUND_SETTINGS.settings.mcpServersDetectedDirectory}
                    showChevron={false}
                    accessoryLayout="adaptive"
                    rightElement={(
                        <View style={styles.directoryInputRow}>
                            <FieldTextInput
                                testID="settings.mcpServers.detect.directoryInput"
                                style={styles.directoryInput}
                                value={props.directory}
                                onChangeText={props.onChangeDirectory}
                                accessibilityLabel={t('settings.mcpServersDetectedDirectoryTitle')}
                                placeholder={t('settings.mcpServersDetectedDirectoryPlaceholder')}
                                monospace
                            />
                            <PathInputBrowseButton
                                onPress={handleBrowseDirectory}
                                disabled={!props.canExecute}
                            />
                        </View>
                    )}
                />
            </ItemGroup>

            {props.warnings && props.warnings.length > 0 ? (
                <ItemGroup title={t('settings.mcpServersDetectedWarningsTitle')}>
                    {props.warnings.map((warning, index) => (
                        <Item
                            key={`${warning.provider}:${warning.code}:${index}`}
                            title={formatDetectedWarning(warning)}
                            subtitleLeading={<View style={collectionListStyles.troubleDot} />}
                            mode="info"
                            showChevron={false}
                        />
                    ))}
                </ItemGroup>
            ) : null}

            <ItemGroup title={t('mcpSettings.onMachineFoundSection')} description={t('mcpSettings.onMachineFoundDescription')}>
                {props.detected && props.detected.length > 0 ? (
                    props.detected.map((server, index) => (
                        <React.Fragment key={`${server.provider}:${server.name}:${index}`}>
                            <Item
                                testID={`mcp.detected.card.${index}`}
                                title={server.name}
                                subtitle={[
                                    resolveDetectedServerStatusLabel(server.provider, server.enabled),
                                    server.transport === 'stdio'
                                        ? [server.stdio?.command ?? '', ...(server.stdio?.args ?? [])].filter(Boolean).join(' ')
                                        : (server.remote?.url ?? ''),
                                ].filter(Boolean).join(' · ')}
                                showChevron={false}
                                rightElementOutsidePressable
                                // While its panel is open, the panel holds the one Add.
                                rightElement={isSameFinding(props.adopting, server) ? undefined : (
                                    <RoundButton
                                        testID={`mcp.detected.import.${index}`}
                                        size="small"
                                        display="secondary"
                                        title={t('capabilities.mcpAdd.add')}
                                        disabled={!props.canImport}
                                        onPress={() => props.onImport(server)}
                                    />
                                )}
                            />
                            {isSameFinding(props.adopting, server) ? props.adoptionPanel : null}
                        </React.Fragment>
                    ))
                ) : (
                    <Item
                        testID="settings.mcpServers.detect.empty"
                        title={props.loading ? t('common.loading') : t('settings.mcpServersDetectedEmptyTitle')}
                        subtitle={props.loading ? undefined : t('settings.mcpServersDetectedEmptySubtitle')}
                        showChevron={false}
                        mode="info"
                    />
                )}
            </ItemGroup>
        </>
    );
});

const styles = StyleSheet.create(() => ({
    directoryInputRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flexShrink: 1,
    },
    directoryInput: {
        flex: 1,
        minWidth: 0,
    },
}));
