import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';

import { McpServerRuleV1Schema, type ReachPlaceV1, type McpServerRuleV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { resolveCreateReachV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';

import { McpBindingTargetFields, describeBindingTarget } from '@/components/settings/mcpServers/McpBindingTargetFields';
import { InlineAddExpander } from '@/components/ui/forms/InlineAddExpander';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { McpWorkspaceRootPickerModal } from './McpWorkspaceRootPickerModal';
import { resolveMcpBindingTargetTypeChange } from './resolveMcpBindingTarget';

function createDraftBinding(serverId: string, _machines: readonly Machine[]): McpServerRuleV1 {
    const reach = resolveCreateReachV1({ kind: 'mcp_server', caller: { surface: 'ui' },
        ctx: { nowMs: Date.now(), newId: randomUUID } });
    if (!reach.ok) throw new Error(reach.code);
    return { ...reach.rules[0]!, serverId };
}

export const McpServerBindingDraftExpander = React.memo(function McpServerBindingDraftExpander(props: Readonly<{
    serverId: string;
    machines: readonly Machine[];
    favoriteDirectories: string[];
    onChangeFavoriteDirectories: (next: string[]) => void;
    onAddBinding: (binding: McpServerRuleV1) => void;
    expandedContainerStyle?: React.ComponentProps<typeof InlineAddExpander>['expandedContainerStyle'];
}>) {
    const [isOpen, setIsOpen] = React.useState(false);
    const [draftBinding, setDraftBinding] = React.useState<McpServerRuleV1>(() => createDraftBinding(props.serverId, props.machines));
    const draftBindingParse = React.useMemo(() => McpServerRuleV1Schema.safeParse(draftBinding), [draftBinding]);

    React.useEffect(() => {
        setDraftBinding((current) => ({ ...current, serverId: props.serverId }));
    }, [props.serverId]);

    const resetDraftBinding = React.useCallback(() => {
        setDraftBinding(createDraftBinding(props.serverId, props.machines));
    }, [props.machines, props.serverId]);

    const updateDraftBinding = React.useCallback((updater: (current: McpServerRuleV1) => McpServerRuleV1) => {
        setDraftBinding((current) => updater(current));
    }, []);

    const setDraftBindingTargetType = React.useCallback((nextType: ReachPlaceV1['t'], selectedMachineId?: string) => {
        updateDraftBinding((current) => {
            const now = Date.now();
            const nextTarget = resolveMcpBindingTargetTypeChange(current.target, nextType, props.machines, selectedMachineId);
            if (!nextTarget) {
                Modal.alert(t('common.error'), t('settings.mcpServersNoMachineSelected'));
                return current;
            }

            return {
                ...current,
                target: nextTarget,
                updatedAt: now,
            };
        });
    }, [props.machines, updateDraftBinding]);

    const setDraftBindingMachineId = React.useCallback((machineId: string) => {
        updateDraftBinding((current) => {
            const now = Date.now();
            if (current.target.t === 'allMachines' || current.target.t === 'project') return current;
            return { ...current, target: { ...current.target, machineId }, updatedAt: now };
        });
    }, [updateDraftBinding]);

    const openDraftWorkspacePicker = React.useCallback(() => {
        const { target } = draftBinding;
        if (target.t !== 'workspace') return;
        const machine = props.machines.find((item) => item.id === target.machineId) ?? null;
        const homeDir = machine?.metadata?.homeDir || '/home';
        Modal.show({
            component: McpWorkspaceRootPickerModal,
            props: {
                machineId: target.machineId,
                machineHomeDir: homeDir,
                machinePlatform: machine?.metadata?.platform ?? null,
                selectedPath: target.workspaceRoot,
                onSelectPath: (workspaceRoot: string) =>
                    updateDraftBinding((current) => {
                        if (current.target.t !== 'workspace') return current;
                        return {
                            ...current,
                            target: { ...current.target, workspaceRoot },
                            updatedAt: Date.now(),
                        };
                    }),
                favoriteDirectories: props.favoriteDirectories,
                onChangeFavoriteDirectories: props.onChangeFavoriteDirectories,
            },
            chrome: {
                kind: 'card',
                title: t('settings.mcpServersPickWorkspaceTitle'),
                dimensions: { size: 'lg' },
            },
            closeOnBackdrop: true,
        });
    }, [
        draftBinding,
        props.favoriteDirectories,
        props.machines,
        props.onChangeFavoriteDirectories,
        updateDraftBinding,
    ]);

    const handleCancel = React.useCallback(() => {
        setIsOpen(false);
        resetDraftBinding();
    }, [resetDraftBinding]);

    const handleSave = React.useCallback(() => {
        if (!draftBindingParse.success) {
            Modal.alert(t('common.error'), t('settings.mcpServersValidationFailed'));
            return;
        }
        props.onAddBinding(draftBindingParse.data);
        setIsOpen(false);
        resetDraftBinding();
    }, [draftBindingParse, props, resetDraftBinding]);

    return (
        <InlineAddExpander
                isOpen={isOpen}
                onOpenChange={(nextOpen) => {
                    setIsOpen(nextOpen);
                    if (nextOpen) {
                        resetDraftBinding();
                    } else {
                        handleCancel();
                    }
                }}
                title={t('settings.mcpServersAddApplyRule')}
                helpText={t('settings.mcpServersAddApplyRuleHelp')}
                onCancel={handleCancel}
                onSave={handleSave}
                saveDisabled={!draftBindingParse.success}
                cancelLabel={t('common.cancel')}
                saveLabel={t('settings.mcpServersAddApplyRuleSave')}
                expandedContainerStyle={props.expandedContainerStyle}
            >
                <Text style={styles.draftBindingSummary}>
                    {describeBindingTarget(draftBinding.target, props.machines)}
                </Text>
                <McpBindingTargetFields
                    target={draftBinding.target}
                    machines={props.machines}
                    onChangeTargetType={setDraftBindingTargetType}
                    onChangeMachineId={setDraftBindingMachineId}
                    onOpenWorkspacePicker={openDraftWorkspacePicker}
                />
            </InlineAddExpander>
    );
});

const styles = StyleSheet.create((theme) => ({
    draftBindingSummary: {
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text.secondary,
        marginBottom: theme.space.s12,
    },
}));
