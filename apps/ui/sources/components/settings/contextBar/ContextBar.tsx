import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { PathInputBrowseButton } from '@/components/ui/pathBrowser/PathInputBrowseButton';
import { openMachinePathBrowserModal } from '@/components/ui/pathBrowser/openMachinePathBrowserModal';
import { t } from '@/text';

export type ContextBarMode = 'machine_only' | 'workspace_only' | 'machine_and_workspace';

type ContextBarProps = Readonly<{
    mode: ContextBarMode;
    machine?: Readonly<{
        title?: string;
        selectedId: string | null;
        subtitle: string;
        items: DropdownMenuItem[];
        onSelect: (machineId: string) => void;
    }>;
    workspace?: Readonly<{
        value: string;
        placeholder: string;
        onChange: (value: string) => void;
        testID?: string;
        browse?: Readonly<{
            machineId: string | null;
            serverId?: string | null;
            title?: string;
            enabled?: boolean;
        }>;
    }>;
}>;

const styles = StyleSheet.create(() => ({
    container: {
        gap: 10,
    },
    workspaceInputRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
    },
    workspaceInput: {
        flex: 1,
    },
}));

export const ContextBar = React.memo(function ContextBar(props: ContextBarProps) {
    const [machineMenuOpen, setMachineMenuOpen] = React.useState(false);

    const showMachine = props.mode === 'machine_only' || props.mode === 'machine_and_workspace';
    const showWorkspace = props.mode === 'workspace_only' || props.mode === 'machine_and_workspace';

    const handleBrowseWorkspace = React.useCallback(async () => {
        if (!props.workspace?.browse?.machineId) return;
        const selected = await openMachinePathBrowserModal({
            machineId: props.workspace.browse.machineId,
            serverId: props.workspace.browse.serverId,
            title: props.workspace.browse.title,
            initialPath: props.workspace.value,
        });
        if (selected) {
            props.workspace.onChange(selected);
        }
    }, [props.workspace]);

    return (
        <View style={styles.container}>
            {showMachine && props.machine ? (
                <DropdownMenu
                    open={machineMenuOpen}
                    onOpenChange={setMachineMenuOpen}
                    items={props.machine.items}
                    selectedId={props.machine.selectedId}
                    onSelect={props.machine.onSelect}
                    itemTrigger={{
                        title: props.machine.title ?? t('contextBar.machine'),
                        subtitle: props.machine.subtitle,
                    }}
                    rowKind="item"
                    connectToTrigger
                    variant="default"
                />
            ) : null}

            {showWorkspace && props.workspace ? (
                <Item
                    title={t('contextBar.projectDirectory')}
                    accessoryLayout="stacked"
                    showChevron={false}
                    rightElement={(
                        <View style={styles.workspaceInputRow}>
                            <FieldTextInput
                                testID={props.workspace.testID}
                                style={styles.workspaceInput}
                                value={props.workspace.value}
                                onChangeText={props.workspace.onChange}
                                accessibilityLabel={t('contextBar.projectDirectory')}
                                placeholder={props.workspace.placeholder}
                                autoCapitalize="none"
                                monospace
                            />
                            {props.workspace.browse?.enabled !== false ? (
                                <PathInputBrowseButton
                                    onPress={handleBrowseWorkspace}
                                    disabled={!props.workspace.browse?.machineId}
                                />
                            ) : null}
                        </View>
                    )}
                />
            ) : null}
        </View>
    );
});
