import React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { InlineAddExpander } from '@/components/ui/forms/InlineAddExpander';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Icon } from '@/components/ui/icons/Icon';
import type { SavedSecretCatalogEntryV1 } from '@happier-dev/protocol';
import type { SavedSecretReferenceResolution } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { sharedSecretProvenanceSegments, sharedSecretStatusLabel } from './savedSecretRowCopy';


export interface SecretsListProps {
    secrets: readonly SavedSecret[];
    onCreatePersonal?: (input: Readonly<{ name: string; value: string }>) => Promise<string | null>;
    onRenamePersonal?: (secret: SavedSecret) => Promise<boolean>;
    onRotatePersonal?: (secret: SavedSecret) => Promise<boolean>;
    onDeletePersonal?: (secret: SavedSecret) => Promise<boolean>;

    title?: string;
    footer?: string | null;

    selectedId?: string;
    onSelectId?: (id: string) => void;

    includeNoneRow?: boolean;
    noneSubtitle?: string;

    defaultId?: string | null;
    onSetDefaultId?: (id: string | null) => void;

    allowAdd?: boolean;
    allowEdit?: boolean;
    onAfterAddSelectId?: (id: string) => void;

    /** Shared-resource rows from the canonical Account-scoped catalog; pickers choose among them. */
    sharedEntries?: readonly SavedSecretCatalogEntryV1[];
    resolveSharedReference?: (ref: string) => SavedSecretReferenceResolution;
    sharedCatalogStale?: boolean;
    onRetrySharedCatalog?: () => void;

    wrapInItemList?: boolean;
}

export function SecretsList(props: SecretsListProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const {
        secrets,
        defaultId,
        onAfterAddSelectId,
        selectedId,
        onSelectId,
        onSetDefaultId,
        onCreatePersonal,
        onRenamePersonal,
        onRotatePersonal,
        onDeletePersonal,
    } = props;

    const orderedSecrets = React.useMemo(() => {
        const resolvedDefaultId = defaultId ?? null;
        if (!resolvedDefaultId) return secrets;
        const defaultSecret = secrets.find((k) => k.id === resolvedDefaultId) ?? null;
        if (!defaultSecret) return secrets;
        const rest = secrets.filter((k) => k.id !== resolvedDefaultId);
        return [defaultSecret, ...rest];
    }, [defaultId, secrets]);

    const [isAddExpanded, setIsAddExpanded] = React.useState(false);
    const [draftName, setDraftName] = React.useState('');
    const [draftValue, setDraftValue] = React.useState('');
    const nameInputRef = React.useRef<React.ElementRef<typeof TextInput> | null>(null);

    const resetAddDraft = React.useCallback(() => {
        setDraftName('');
        setDraftValue('');
        setIsAddExpanded(false);
    }, []);

    const submitAddSecret = React.useCallback(async () => {
        const name = draftName.trim();
        const value = draftValue;
        if (!name) return;
        if (value.length === 0) return;
        const createdId = await onCreatePersonal?.({ name, value });
        if (!createdId) return;
        onAfterAddSelectId?.(createdId);
        resetAddDraft();
    }, [draftName, draftValue, onAfterAddSelectId, onCreatePersonal, resetAddDraft]);

    const deleteSecret = React.useCallback(async (secret: SavedSecret) => {
        if (!await onDeletePersonal?.(secret)) return;
        if (selectedId === secret.id) {
            onSelectId?.('');
        }
        if (defaultId === secret.id) {
            onSetDefaultId?.(null);
        }
    }, [defaultId, onDeletePersonal, onSelectId, onSetDefaultId, selectedId]);

    const groupTitle = props.title ?? ((props.sharedEntries?.length ?? 0) > 0
        ? t('secrets.catalog.relationship.owner')
        : t('settings.secrets'));
    const groupFooter = props.footer === undefined ? t('settings.secretsSubtitle') : (props.footer ?? undefined);
    const ownerSharedEntries = (props.sharedEntries ?? []).filter((entry) => entry.relationship === 'owner');
    const recipientSharedEntries = (props.sharedEntries ?? []).filter((entry) => entry.relationship === 'recipient');
    // A configured shared ref the Home no longer authorizes (revoked, deleted,
    // or not yet readable) has no catalog row. The binding itself survives, so
    // the picker keeps showing it — selected, with the canonical resolver's
    // reason, and not choosable — instead of silently dropping the selection.
    const unavailableSelection = (() => {
        const ref = props.selectedId;
        if (!ref || !props.onSelectId || !props.resolveSharedReference) return null;
        if (secrets.some((secret) => secret.id === ref)) return null;
        if ((props.sharedEntries ?? []).some((entry) => entry.ref === ref)) return null;
        const resolution = props.resolveSharedReference(ref);
        return resolution.kind === 'shared_resource' ? resolution : null;
    })();

    const renderSharedEntry = (entry: SavedSecretCatalogEntryV1, idx: number, total: number) => {
        const resolvedStatus = props.resolveSharedReference?.(entry.ref).status ?? entry.materialStatus;
        const provenance = sharedSecretProvenanceSegments(entry);
        const ready = resolvedStatus === 'ready'
            && entry.capabilities.use;
        return (
            <Item
                key={entry.ref}
                testID={`saved-secret:${entry.ref}`}
                title={entry.name ?? t('secrets.catalog.unavailableName')}
                subtitle={[...provenance, sharedSecretStatusLabel(resolvedStatus)].join(' · ')}
                accessibilityLabel={[
                    entry.name ?? t('secrets.catalog.unavailableName'),
                    entry.relationship === 'owner'
                        ? t('secrets.catalog.relationship.owner')
                        : t('secrets.catalog.relationship.recipient'),
                    ...provenance,
                    sharedSecretStatusLabel(resolvedStatus),
                ].join(', ')}
                icon={<Icon name="key" size={29} color={theme.colors.button.secondary.tint} />}
                onPress={props.onSelectId && ready ? () => props.onSelectId?.(entry.ref) : undefined}
                showChevron={false}
                selected={Boolean(props.onSelectId) && props.selectedId === entry.ref}
                showDivider={idx < total - 1}
                disabled={Boolean(props.onSelectId) && !ready}
            />
        );
    };

    const group = (
        <>
            <ItemGroup title={groupTitle}>
                {props.sharedCatalogStale && props.onRetrySharedCatalog ? (
                    <Item
                        testID="saved-secret-catalog-retry"
                        title={t('common.retry')}
                        subtitle={t('secrets.catalog.operationFailed')}
                        onPress={props.onRetrySharedCatalog}
                        showChevron={false}
                    />
                ) : null}
                {props.includeNoneRow && (
                    <Item
                        testID="saved-secret:none"
                        title={t('secrets.noneTitle')}
                        subtitle={props.noneSubtitle ?? t('secrets.noneSubtitle')}
                        icon={<Icon name="x-circle" size={29} color={theme.colors.text.secondary} />}
                        onPress={() => props.onSelectId?.('')}
                        showChevron={false}
                        selected={props.selectedId === ''}
                        showDivider
                    />
                )}

                {unavailableSelection ? (
                    <Item
                        testID={`saved-secret:${unavailableSelection.ref}`}
                        title={unavailableSelection.entry?.name ?? t('secrets.catalog.unavailableName')}
                        subtitle={sharedSecretStatusLabel(unavailableSelection.status)}
                        accessibilityLabel={[
                            unavailableSelection.entry?.name ?? t('secrets.catalog.unavailableName'),
                            sharedSecretStatusLabel(unavailableSelection.status),
                        ].join(', ')}
                        icon={<Icon name="warning-circle" size={29} color={theme.colors.state.warning.foreground} />}
                        showChevron={false}
                        selected
                        disabled
                        showDivider
                    />
                ) : null}

                {!unavailableSelection && props.secrets.length === 0 && (props.sharedEntries?.length ?? 0) === 0 ? (
                    <Item
                        testID="saved-secret:empty"
                        title={t('secrets.emptyTitle')}
                        subtitle={t('secrets.emptySubtitle')}
                        icon={<Icon name="key" size={29} color={theme.colors.text.secondary} />}
                        showChevron={false}
                    />
                ) : (
                    <>
                    {orderedSecrets.map((secret, idx) => {
                        const isSelected = props.selectedId === secret.id;
                        const isDefault = props.defaultId === secret.id;
                        return (
                            <Item
                                key={secret.id}
                                testID={`saved-secret:${secret.id}`}
                                title={secret.name}
                                subtitle={t('secrets.savedHiddenSubtitle')}
                                icon={<Icon name="key" size={29} color={theme.colors.button.secondary.tint} />}
                                onPress={props.onSelectId ? () => props.onSelectId?.(secret.id) : undefined}
                                showChevron={false}
                                selected={Boolean(props.onSelectId) ? isSelected : false}
                                showDivider={idx < orderedSecrets.length - 1 || (props.sharedEntries?.length ?? 0) > 0}
                                // The accessory owns its own buttons (rename/replace/delete,
                                // set-default), so it must sit beside the row's activation
                                // owner rather than inside it. Without this the row stops
                                // being a button on web — `Item` drops the role to keep the
                                // markup valid — losing its accessible name and keyboard
                                // activation on every surface that embeds this list.
                                rightElementOutsidePressable
                                rightElement={(
                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s12 }}>
                                        {props.onSetDefaultId && (
                                            <ItemRowActions
                                                title={t('secrets.defaultLabel')}
                                                overflowTriggerTestID={`saved-secret:${secret.id}:default-more`}
                                                compactActionIds={['default']}
                                                iconSize={18}
                                                actions={[
                                                    {
                                                        id: 'default',
                                                        inlineTestID: `saved-secret:${secret.id}:default`,
                                                        title: isDefault ? t('secrets.actions.unsetDefault') : t('secrets.actions.setDefault'),
                                                        icon: 'star',
                                                        color: isDefault ? theme.colors.button.primary.background : theme.colors.text.secondary,
                                                        onPress: () => props.onSetDefaultId?.(isDefault ? null : secret.id),
                                                    },
                                                ]}
                                            />
                                        )}

                                        {props.allowEdit !== false && (onRenamePersonal || onRotatePersonal || onDeletePersonal) && (
                                            <ItemRowActions
                                                title={secret.name}
                                                overflowTriggerTestID={`saved-secret:${secret.id}:more`}
                                                compactActionIds={['edit']}
                                                actions={[
                                                    ...(onRenamePersonal ? [{ id: 'edit', inlineTestID: `saved-secret:${secret.id}:rename`, title: t('common.rename'), icon: 'pencil' as const, onPress: () => { void onRenamePersonal(secret); } }] : []),
                                                    ...(onRotatePersonal ? [{ id: 'replace', inlineTestID: `saved-secret:${secret.id}:replace`, title: t('secrets.actions.replaceValue'), icon: 'arrow-clockwise' as const, onPress: () => { void onRotatePersonal(secret); } }] : []),
                                                    ...(onDeletePersonal ? [{ id: 'delete', inlineTestID: `saved-secret:${secret.id}:delete`, title: t('common.delete'), icon: 'trash' as const, destructive: true, onPress: () => { void deleteSecret(secret); } }] : []),
                                                ]}
                                            />
                                        )}

                                        {props.onSelectId && (
                                            <View style={{ width: 24, alignItems: 'center', justifyContent: 'center' }}>
                                                <Icon
                                                    name="check-circle"
                                                    size={24}
                                                    color={theme.colors.text.primary}
                                                    style={{ opacity: isSelected ? 1 : 0 }}
                                                />
                                            </View>
                                        )}
                                    </View>
                                )}
                            />
                        );
                    })}
                    {ownerSharedEntries.map((entry, idx) => renderSharedEntry(entry, idx, ownerSharedEntries.length))}
                    </>
                )}
            </ItemGroup>
            {recipientSharedEntries.length > 0 ? (
                <ItemGroup title={t('secrets.catalog.relationship.recipient')}>
                    {recipientSharedEntries.map((entry, idx) => renderSharedEntry(entry, idx, recipientSharedEntries.length))}
                </ItemGroup>
            ) : null}
            <ItemGroup description={groupFooter}>
                {props.allowAdd !== false && onCreatePersonal ? (
                    <InlineAddExpander
                        triggerTestID="saved-secret-add"
                        isOpen={isAddExpanded}
                        onOpenChange={setIsAddExpanded}
                        title={t('common.add')}
                        subtitle={t('secrets.addSubtitle')}
                        icon={<Icon name="plus-circle" size={29} color={theme.colors.button.secondary.tint} />}
                        onCancel={resetAddDraft}
                        onSave={submitAddSecret}
                        saveDisabled={!draftName.trim() || draftValue.length === 0}
                        cancelLabel={t('common.cancel')}
                        saveLabel={t('common.save')}
                        autoFocusRef={nameInputRef}
                    >
                        <Text style={styles.fieldLabel}>{t('secrets.fields.name')}</Text>
                        <TextInput
                            ref={nameInputRef}
                            testID="saved-secret-add-name"
                            style={styles.textInput}
                            placeholder={t('secrets.placeholders.nameExample')}
                            placeholderTextColor={theme.colors.input.placeholder}
                            value={draftName}
                            onChangeText={setDraftName}
                            autoCapitalize="none"
                            autoCorrect={false}
                        />

                        <View style={{ height: 12 }} />

                        <Text style={styles.fieldLabel}>{t('secrets.fields.value')}</Text>
                        <TextInput
                            testID="saved-secret-add-value"
                            style={styles.textInput}
                            placeholder={t('secrets.placeholders.valueExample')}
                            placeholderTextColor={theme.colors.input.placeholder}
                            value={draftValue}
                            onChangeText={setDraftValue}
                            autoCapitalize="none"
                            autoCorrect={false}
                            secureTextEntry
                            textContentType={Platform.OS === 'ios' ? 'password' : undefined}
                        />
                    </InlineAddExpander>
                ) : null}
            </ItemGroup>
        </>
    );

    if (props.wrapInItemList === false) {
        return group;
    }

    return (
        <ItemList presentation="grouped" style={{ paddingTop: 0 }}>
            {group}
        </ItemList>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    fieldLabel: {
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.text.secondary,
        marginBottom: theme.space.s8,
    },
    textInput: {
        ...Typography.default('regular'),
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        paddingHorizontal: theme.space.s12,
        paddingVertical: Platform.select({ ios: 8, default: 10 }),
        fontSize: Platform.select({ ios: 16, default: 16 }),
        lineHeight: Platform.select({ ios: 20, default: 22 }),
        letterSpacing: Platform.select({ ios: -0.24, default: 0.1 }),
        color: theme.colors.input.text,
    },
}));
