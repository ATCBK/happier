import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type { ValueRefV1, SavedSecretCatalogEntryV1 } from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useListPresentation } from '@/components/ui/lists/listPresentation';
import { Modal } from '@/modal';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { t } from '@/text';

import { ValueRefEditorModal, getValueRefEditorModalTitle } from '@/components/ui/forms/valueRefs/ValueRefEditorModal';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { useValueRefRowsEditor } from '@/components/ui/forms/valueRefs/useValueRefRowsEditor';

type ValueRefKind = 'env' | 'header';

function describeValueRef(
    valueRef: ValueRefV1,
    secrets: readonly SavedSecret[],
    catalogEntries: readonly SavedSecretCatalogEntryV1[],
): string {
    if (valueRef.t === 'literal' || valueRef.t === 'template') {
        return t('settings.mcpServersValueSourceLiteral');
    }
    if (valueRef.t === 'sessionAttested') return valueRef.field;
    const secretId = valueRef.secretId;
    const secretName = catalogEntries.find((entry) => entry.ref === secretId)?.name
        ?? secrets.find((s) => s.id === secretId)?.name
        ?? null;
    if (secretName) {
        return t('settings.mcpServersValueSourceSavedSecretNamed', { name: secretName });
    }
    return t('settings.mcpServersValueSourceSavedSecret');
}

export const McpValueRefMapEditor = React.memo(function McpValueRefMapEditor(props: Readonly<{
    kind: ValueRefKind;
    title: string;
    /** Section description on configuration pages (page presentation). */
    description?: string;
    iconName: IconName;
    entries: Record<string, ValueRefV1>;
    secrets: SavedSecret[];
    scope?: AccountSettingsScope | null;
    onChangeEntries: (next: Record<string, ValueRefV1>) => void;
    addRowTitle: string;
    addRowSubtitle?: string;
    emptyTitle: string;
    emptySubtitle: string;
    testIdPrefix: string;
}>) {
    const { theme } = useUnistyles();
    const catalog = useSavedSecretCatalog(props.scope === undefined ? undefined : { scope: props.scope });
    // On a configuration page the rows carry no decorative icon and "add" is the section's action.
    const page = useListPresentation() === 'page';

    const { rows, submitEntry, removeEntry } = useValueRefRowsEditor({
        kind: props.kind, entries: props.entries, onChangeEntries: props.onChangeEntries,
    });

    const saveEntry = React.useCallback((originalKey: string | null, key: string, valueRef: ValueRefV1) => {
        const result = submitEntry(originalKey, key, valueRef);
        if (!result.ok && result.error === 'duplicate_key') {
            Modal.alert(t('common.error'), t('settings.mcpServersKeyAlreadyExists'));
        }
        return result.ok;
    }, [submitEntry]);

    const openEditor = React.useCallback((params: Readonly<{
        mode: 'add' | 'edit';
        initialKey: string;
        initialValueRef: ValueRefV1;
        onDelete?: (() => void) | null;
        onSubmit: (result: Readonly<{ key: string; valueRef: ValueRefV1 }>) => boolean;
    }>) => {
        Modal.show({
            component: ValueRefEditorModal,
            props: {
                kind: props.kind,
                initialKey: params.initialKey,
                initialValueRef: params.initialValueRef,
                secrets: props.secrets,
                ...(props.scope === undefined ? {} : { scope: props.scope }),
                onDelete: params.onDelete ?? null,
                onSubmit: params.onSubmit,
            },
            chrome: {
                kind: 'card',
                title: getValueRefEditorModalTitle(props.kind),
                dimensions: { size: 'lg' },
            },
            closeOnBackdrop: true,
        });
    }, [props.kind, props.secrets, props.scope]);

    const handleAdd = React.useCallback(() => {
        openEditor({
            mode: 'add',
            initialKey: '',
            initialValueRef: { t: 'literal', v: '' },
            onSubmit: ({ key, valueRef }) => {
                return saveEntry(null, key, valueRef);
            },
        });
    }, [openEditor, saveEntry]);

    return (
        <>
            <ItemGroup title={props.title} description={page ? props.description : undefined}>
                {rows.length === 0 && !page ? (
                    <Item
                        testID={`${props.testIdPrefix}.empty`}
                        title={props.emptyTitle}
                        subtitle={props.emptySubtitle}
                        icon={<Icon name={props.iconName} size={29} color={theme.colors.text.secondary} />}
                        showChevron={false}
                    />
                ) : null}

                {rows.map(({ key, valueRef }, idx) => (
                    <Item
                        key={key}
                        testID={`${props.testIdPrefix}.row.${idx}`}
                        title={key}
                        subtitle={describeValueRef(valueRef, props.secrets, catalog.entries)}
                        icon={page ? undefined : <Icon name={props.iconName} size={29} color={theme.colors.accent.purple} />}
                        onPress={() => {
                            openEditor({
                                mode: 'edit',
                                initialKey: key,
                                initialValueRef: valueRef,
                                onDelete: () => {
                                    removeEntry(key);
                                },
                                onSubmit: ({ key: nextKey, valueRef: nextValueRef }) => {
                                    return saveEntry(key, nextKey, nextValueRef);
                                },
                            });
                        }}
                        showDivider={idx < rows.length - 1}
                    />
                ))}
                {page ? (
                    // One entry point, inside its sheet, like "Add applies-to rule"; the section description says what goes here.
                    <Item
                        testID={`${props.testIdPrefix}.add`}
                        title={props.addRowTitle}
                        onPress={handleAdd}
                        showChevron={false}
                    />
                ) : null}
            </ItemGroup>

            {page ? null : (
                <ItemGroup>
                    <Item
                        testID={`${props.testIdPrefix}.add`}
                        title={props.addRowTitle}
                        subtitle={props.addRowSubtitle}
                        onPress={handleAdd}
                    />
                </ItemGroup>
            )}
        </>
    );
});
