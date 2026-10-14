import * as React from 'react';
import { useLocalSearchParams, useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
    McpServerRuleV1Schema,
    McpServerCatalogEntryV1Schema,
    type McpServerRuleV1,
    type McpServerCatalogEntryV1,
} from '@happier-dev/protocol/mcp/servers/settingsV1';

import { McpServerConfigureForm } from '@/components/settings/mcpServers/McpServerConfigureForm';
import { McpServerDetailPage } from '@/components/settings/mcpServers/detail/McpServerDetailPage';
import type { McpConfigurationSaveState } from '@/components/settings/mcpServers/McpServerConfigureForm';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Modal } from '@/modal';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { randomUUID } from '@/platform/randomUUID';
import { useAllMachines } from '@/sync/domains/state/storage';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { useMachineAdministrationTargetSelection } from '@/sync/domains/machines/administration/useTargetSelection';
import { t } from '@/text';
import { promptUnsavedChangesAlert } from '@/utils/ui/promptUnsavedChangesAlert';
import { useUnsavedChangesBeforeRemoveGuard } from '@/utils/navigation/useUnsavedChangesBeforeRemoveGuard';
import { Icon } from '@/components/ui/icons/Icon';

import { MCP_COLLECTION_ROUTE, mcpServerDraftTitle, mcpServerRoute } from './collection/mcpServerCollectionModel';
import { resolveTransportIconName, resolveTransportLabel, summarizeBindings } from './mcpServerUi';
import { useMcpServersSettings } from './useMcpServersSettings';
import { McpServerCatalogOperationError, requireUpdatedMcpServerCatalogMutation } from '@/sync/api/account/apiMcpServerCatalog';
import { areAccountSettingsScopesEqual, type AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { reachRulesToDraftsV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';
import { useReachRules } from '@/sync/domains/capabilities/reach/useReachRules';

type NavigationLike = Readonly<{
    setOptions?: (options: Readonly<Record<string, unknown>>) => void;
    dispatch?: (action: unknown) => void;
}>;

function createDefaultServerName(existingNames: ReadonlySet<string>): string {
    if (!existingNames.has('server')) return 'server';
    for (let index = 2; index < 999; index += 1) {
        const candidate = `server_${index}`;
        if (!existingNames.has(candidate)) return candidate;
    }
    return `server_${Date.now()}`;
}

function createDraftServer(existingNames: ReadonlySet<string>): McpServerCatalogEntryV1 {
    const now = Date.now();
    return {
        id: randomUUID(),
        name: createDefaultServerName(existingNames),
        transport: 'stdio',
        stdio: { command: '', args: [] },
        env: {},
        createdAt: now,
        updatedAt: now,
    };
}

export const McpServerEditorScreen = React.memo(function McpServerEditorScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const navigation = useNavigation();
    const nav = navigation as NavigationLike;
    const ignoreBeforeRemoveRef = React.useRef(false);
    const isDirtyRef = React.useRef(false);
    const machines = useAllMachines();
    const administrationTargetSelection = useMachineAdministrationTargetSelection(
        MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.mcpServers,
    );

    const { serverId: serverIdParam } = useLocalSearchParams<{ serverId?: string }>();
    const serverId = typeof serverIdParam === 'string' && serverIdParam.trim() ? serverIdParam.trim() : null;

    const { settings: normalizedSettings, writable: writableMcpSettings, mutate: mutateMcpCatalog, snapshot, scope, approval: catalogApproval } = useMcpServersSettings();
    const reachRules = useReachRules('mcp_server', serverId ?? '');
    const liveScopeRef = React.useRef(scope);
    liveScopeRef.current = scope;
    const draftBaseRef = React.useRef<Readonly<{ scope: AccountSettingsScope; revision: number }> | null>(null);
    const savedSecretCatalog = useSavedSecretCatalog({ scope: draftBaseRef.current?.scope ?? scope });
    const secrets = React.useMemo(() => [...savedSecretCatalog.materializedSecrets], [savedSecretCatalog.materializedSecrets]);
    const { resolveReference } = savedSecretCatalog;
    const secretAvailability = React.useMemo(() => ({ resolveReference }), [resolveReference]);
    const approvalScope = draftBaseRef.current?.scope ?? scope;
    const approval = catalogApproval;
    const settingsLoaded = snapshot.status === 'ready';
    const existingNames = React.useMemo(() => new Set(normalizedSettings.servers.map((server) => server.name)), [normalizedSettings.servers]);

    const existingServer: McpServerCatalogEntryV1 | null = React.useMemo(() => {
        if (!serverId) return null;
        return normalizedSettings.servers.find((server) => server.id === serverId) ?? null;
    }, [normalizedSettings, serverId]);

    const existingBindings: McpServerRuleV1[] = React.useMemo(() => {
        if (!serverId) return [];
        return reachRules.rules.map(rule => ({ ...rule, serverId }));
    }, [reachRules.rules, serverId]);

    const [draftServer, setDraftServer] = React.useState<McpServerCatalogEntryV1>(() => existingServer ?? createDraftServer(existingNames));
    // A new server starts with a generated unique name; until the user names it, it is still unnamed.
    const generatedNameRef = React.useRef(existingServer ? null : draftServer.name);
    const [draftBindings, setDraftBindings] = React.useState<McpServerRuleV1[]>(() => existingBindings);
    const [isDirty, setIsDirty] = React.useState(false);
    const dirtyFields = React.useRef({ server: false, rules: false });
    const liveDraftRef = React.useRef({ server: draftServer, bindings: draftBindings });
    liveDraftRef.current = { server: draftServer, bindings: draftBindings };
    React.useEffect(() => {
        if (!scope || snapshot.status !== 'ready' || snapshot.authority !== 'active' || snapshot.revision === 'absent') return;
        if (draftBaseRef.current && !areAccountSettingsScopesEqual(draftBaseRef.current.scope, scope)) return;
        if (!draftBaseRef.current) draftBaseRef.current = { scope, revision: snapshot.revision };
        if (isDirty) return;
        draftBaseRef.current = { scope, revision: snapshot.revision };
        if (existingServer) {
            dirtyFields.current = { server: false, rules: false };
            setDraftServer(existingServer);
            setDraftBindings(existingBindings);
            setIsDirty(false);
        }
    }, [existingBindings, existingServer, isDirty, scope, snapshot.status, snapshot.authority, snapshot.revision]);

    React.useEffect(() => {
        isDirtyRef.current = isDirty;
    }, [isDirty]);

    React.useEffect(() => {
        // Match profile edit behavior: disable iOS gesture navigation while the draft is dirty.
        const setOptions = nav.setOptions;
        if (typeof setOptions !== 'function') return;
        setOptions({ gestureEnabled: !isDirty });
    }, [isDirty, nav.setOptions]);

    React.useEffect(() => {
        const setOptions = nav.setOptions;
        if (typeof setOptions !== 'function') return;
        return () => {
            setOptions({ gestureEnabled: true });
        };
    }, [nav.setOptions]);

    const saveDisabled = React.useMemo(() => {
        if (!writableMcpSettings) return true;
        if (draftBaseRef.current && !areAccountSettingsScopesEqual(draftBaseRef.current.scope, scope)) return true;
        const parsedServer = McpServerCatalogEntryV1Schema.safeParse(draftServer);
        if (!parsedServer.success) return true;
        return dirtyFields.current.rules && draftBindings.some((binding) => !McpServerRuleV1Schema.safeParse(binding).success);
    }, [draftBindings, draftServer, scope, writableMcpSettings]);

    const closeToMcpServersSettings = React.useCallback(() => {
        // `router.replace` expects the public route (group segments like `/(app)` are not valid here on web).
        router.replace(MCP_COLLECTION_ROUTE);
    }, [router]);

    const commitDraft = React.useCallback(async (): Promise<boolean> => {
        const submittedFields = { ...dirtyFields.current };
        if (!writableMcpSettings) {
            Modal.alert(t('common.error'), t('settings.mcpServersValidationFailed'));
            return false;
        }
        const parsedServer = McpServerCatalogEntryV1Schema.safeParse(draftServer);
        if (!parsedServer.success) {
            Modal.alert(t('common.error'), t('settings.mcpServersValidationFailed'));
            return false;
        }
        const parsedBindings: McpServerRuleV1[] = [];
        for (const binding of !serverId || submittedFields.rules ? draftBindings : []) {
            const parsed = McpServerRuleV1Schema.safeParse(binding);
            if (!parsed.success) {
                Modal.alert(t('common.error'), t('settings.mcpServersValidationFailed'));
                return false;
            }
            parsedBindings.push(parsed.data);
        }

        try {
            const base = draftBaseRef.current;
            if (!base || !areAccountSettingsScopesEqual(base.scope, liveScopeRef.current)) throw new McpServerCatalogOperationError('scope-retired');
            if (!serverId || submittedFields.server) {
                const receipt = serverId
                    ? await mutateMcpCatalog('mcp.servers.update', { entry: parsedServer.data, expectedRevision: base.revision })
                    : await mutateMcpCatalog('mcp.servers.create', { entry: parsedServer.data, expectedRevision: base.revision,
                        ...(parsedBindings.length > 0 ? { where: { kind: 'replace', rules: reachRulesToDraftsV1(parsedBindings) } } : {}) });
                requireUpdatedMcpServerCatalogMutation(receipt);
                draftBaseRef.current = { scope: base.scope, revision: receipt.revision };
            }
            if (serverId && submittedFields.rules) {
                const result = await reachRules.change({ kind: 'replace', rules: reachRulesToDraftsV1(parsedBindings) });
                if (!result.ok) throw new McpServerCatalogOperationError(result.message);
            }
            if (!areAccountSettingsScopesEqual(base.scope, liveScopeRef.current)) return false;
            if (liveDraftRef.current.server !== draftServer || liveDraftRef.current.bindings !== draftBindings) return false;
            dirtyFields.current = { server: false, rules: false };
            setIsDirty(false);
            return true;
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.unknownError'));
            return false;
        }
    }, [draftBindings, draftServer, navigation, router, mutateMcpCatalog, reachRules.change, serverId, writableMcpSettings]);

    // A saved server's Configuration saves on blur (T5): a committed value asks for a save, which runs
    // once the draft holding that value has rendered. Invalid drafts stay with their inline error.
    const [configurationCommits, setConfigurationCommits] = React.useState(0);
    const [configurationSaveState, setConfigurationSaveState] = React.useState<McpConfigurationSaveState>('idle');
    const requestConfigurationCommit = React.useCallback(() => setConfigurationCommits((count) => count + 1), []);
    React.useEffect(() => {
        if (configurationCommits === 0 || !serverId || !dirtyFields.current.server || saveDisabled) return;
        setConfigurationSaveState('saving');
        // A refused save says why in its alert and keeps the edit; the line only confirms a save.
        void commitDraft().then((saved) => setConfigurationSaveState(saved ? 'saved' : 'idle'));
        // Only a new commit request saves; draft changes alone wait for the next blur.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [configurationCommits]);

    // Saving keeps the server open: a new one becomes the saved item selected in the collection.
    const save = React.useCallback(async () => {
        const didSave = await commitDraft();
        if (!didSave || serverId) return;
        ignoreBeforeRemoveRef.current = true;
        router.replace(mcpServerRoute(draftServer.id) as never);
    }, [commitDraft, draftServer.id, router, serverId]);

    const discardDraft = React.useCallback(() => {
        const next = existingServer ?? createDraftServer(existingNames);
        if (!existingServer) generatedNameRef.current = next.name;
        setDraftServer(next);
        setDraftBindings(existingBindings);
        dirtyFields.current = { server: false, rules: false };
        setIsDirty(false);
    }, [existingBindings, existingNames, existingServer]);

    const handleDeleteOrCancel = React.useCallback(async () => {
        if (!serverId) {
            ignoreBeforeRemoveRef.current = true;
            closeToMcpServersSettings();
            return;
        }
        if (!writableMcpSettings) {
            Modal.alert(t('common.error'), t('settings.mcpServersValidationFailed'));
            return;
        }

        const confirmed = await Modal.confirm(
            t('settings.mcpServersDeleteTitle'),
            // Name the saved server as the collection shows it, never an unsaved edit.
            t('settings.mcpServersDeleteConfirm', { name: existingServer?.title || existingServer?.name || serverId }),
            { destructive: true, cancelText: t('common.cancel'), confirmText: t('common.delete') },
        );
        if (!confirmed) return;

        try {
            const base = draftBaseRef.current;
            if (!base || !areAccountSettingsScopesEqual(base.scope, liveScopeRef.current)) throw new McpServerCatalogOperationError('scope-retired');
            const receipt = await mutateMcpCatalog('mcp.servers.delete', {
                serverId, removeBindings: true, expectedRevision: base.revision },
                { presentUserConfirmation: { actionId: 'mcp.servers.delete' } });
            requireUpdatedMcpServerCatalogMutation(receipt);
            if (!areAccountSettingsScopesEqual(base.scope, liveScopeRef.current)) return;
            ignoreBeforeRemoveRef.current = true;
            closeToMcpServersSettings();
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.unknownError'));
        }
    }, [closeToMcpServersSettings, existingServer, serverId, mutateMcpCatalog, writableMcpSettings]);

    const requestUnsavedChangesDecision = React.useCallback(async () => {
        return await promptUnsavedChangesAlert(
            (title, message, buttons) => Modal.alert(title, message, buttons),
            {
                title: t('common.discardChanges'),
                message: t('common.unsavedChangesWarning'),
                discardText: t('common.discard'),
                saveText: t('common.save'),
                keepEditingText: t('common.keepEditing'),
            },
        );
    }, []);

    const continueNavigation = React.useCallback((action: unknown) => {
        if (action && typeof nav.dispatch === 'function') {
            nav.dispatch(action);
            return;
        }
        closeToMcpServersSettings();
    }, [closeToMcpServersSettings, nav.dispatch]);

    useUnsavedChangesBeforeRemoveGuard({
        ignoreRef: ignoreBeforeRemoveRef,
        isDirty,
        isDirtyRef,
        requestDecision: requestUnsavedChangesDecision,
        onDiscard: discardDraft,
        onSave: commitDraft,
        onContinue: continueNavigation,
        tag: 'McpServerEditorScreen.beforeRemove',
    });


    // The collection's draft row shows the new server's name as it is typed.
    const isNew = !serverId;
    const draftDisplayName = draftServer.title?.trim()
        || (draftServer.name === generatedNameRef.current ? '' : draftServer.name.trim());
    React.useEffect(() => {
        if (isNew) mcpServerDraftTitle.publish(draftDisplayName);
    }, [draftDisplayName, isNew]);
    React.useEffect(() => (isNew ? () => mcpServerDraftTitle.publish('') : undefined), [isNew]);

    const menuActions = React.useMemo((): readonly PageHeaderMenuAction[] => [{
        id: serverId ? 'delete' : 'discard',
        title: serverId ? t('common.delete') : t('mcpSettings.discardDraft'),
        testID: 'mcp.server.editor.secondaryAction',
        onSelect: () => { void handleDeleteOrCancel(); },
    }], [handleDeleteOrCancel, serverId]);

    if (serverId && !existingServer) {
        if (!settingsLoaded) return null;
        return (
            <ItemList>
                <PageHeader
                    testID="mcp.server.editor.header"
                    alwaysShowTitle
                    title={serverId}
                    description={t('settings.mcpServersServerNotFound')}
                />
            </ItemList>
        );
    }

    if (serverId && existingServer) {
        return (
            <McpServerDetailPage
                server={existingServer}
                draftServer={draftServer}
                catalogRevision={draftBaseRef.current?.revision ?? null}
                secrets={secrets}
                secretAvailability={secretAvailability}
                scope={draftBaseRef.current?.scope ?? scope}
                onCommitConfiguration={requestConfigurationCommit}
                configurationSaveState={configurationSaveState}
                onRemove={() => { void handleDeleteOrCancel(); }}
                approvalNotice={approval.approvalId && approvalScope ? (
                    <ItemGroup>
                        <ActionApprovalPendingNotice testID="mcp.server.editor.approval"
                            message={t('secrets.catalog.approvalPending')}
                            onOpenApproval={() => router.pushRetainingCurrent(`/inbox/approvals/${encodeURIComponent(approval.approvalId!)}?serverId=${encodeURIComponent(approvalScope.serverId)}`)} />
                    </ItemGroup>
                ) : null}
                onChangeServer={(updater) => {
                    dirtyFields.current.server = true;
                    setIsDirty(true);
                    setDraftServer((current) => updater(current));
                }}
            />
        );
    }

    const title = draftDisplayName || t('mcpSettings.newServer');
    const meta = existingServer ? [
        { key: 'transport', text: resolveTransportLabel(existingServer.transport) },
        { key: 'bindings', text: summarizeBindings(existingBindings, machines) },
    ] : undefined;

    return (
        <ItemList keyboardShouldPersistTaps="handled">
            <PageHeader
                testID="mcp.server.editor.header"
                alwaysShowTitle
                title={title}
                description={t('mcpSettings.serverPurpose')}
                meta={meta}
                leading={(
                    <PageHeaderMarkSlot>
                        <Icon name={resolveTransportIconName(draftServer.transport)} size={22} color={theme.colors.text.secondary} />
                    </PageHeaderMarkSlot>
                )}
                primaryAction={{
                    testID: 'mcp.server.editor.save',
                    title: t('common.save'),
                    disabled: saveDisabled || (!isDirty && !isNew),
                    onPress: save,
                }}
                actions={(
                    <View style={styles.headerActions}>
                        <MachineAdministrationTargetSelector
                            selection={administrationTargetSelection}
                            presentation="chip"
                            testIDPrefix="settings.mcpServers.administration.target"
                        />
                        <PageHeaderMenu testID="mcp.server.editor.menu" actions={menuActions} />
                    </View>
                )}
            />

            {approval.approvalId && approvalScope ? (
                <ItemGroup>
                    <ActionApprovalPendingNotice testID="mcp.server.editor.approval"
                        message={t('secrets.catalog.approvalPending')}
                        onOpenApproval={() => router.pushRetainingCurrent(`/inbox/approvals/${encodeURIComponent(approval.approvalId!)}?serverId=${encodeURIComponent(approvalScope.serverId)}`)} />
                </ItemGroup>
            ) : null}

            <McpServerConfigureForm
                    draftServer={draftServer}
                    draftBindings={draftBindings}
                    machines={machines}
                    targetSelection={administrationTargetSelection}
                    secrets={secrets}
                    scope={draftBaseRef.current?.scope ?? scope}
                    onChangeServer={(updater) => {
                        dirtyFields.current.server = true;
                        setIsDirty(true);
                        setDraftServer((current) => updater(current));
                    }}
                    onChangeBindings={(updater) => {
                        dirtyFields.current.rules = true;
                        setIsDirty(true);
                        setDraftBindings((current) => updater(current));
                    }}
                />

        </ItemList>
    );
});

const styles = StyleSheet.create(() => ({
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
}));
