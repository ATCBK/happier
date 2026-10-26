import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { HAPPIER_PAGE_METRICS, HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

const COMPACT_ACTIONS_MAX_WIDTH = 560;

/** The actions draw at the page control height; a finger reaches them through the hit area. */
export const NEW_SESSION_DRAFT_COMPOSER_ACTION_SIZE = HAPPIER_PAGE_METRICS.controlHeightPx;
/** Half the row's 4 px gap: neighbouring actions' hit areas meet, never overlap. */
const ACTION_HIT_REACH = { left: 2, right: 2 } as const;

export const NewSessionDraftComposerActions = React.memo(function NewSessionDraftComposerActions(props: Readonly<{
    deleteDisabled: boolean;
    onStartAnother: () => void;
    onDelete: () => Promise<void>;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const { width } = useWindowDimensions();
    const compact = width < COMPACT_ACTIONS_MAX_WIDTH;
    const [menuOpen, setMenuOpen] = React.useState(false);
    const deleteItems = React.useMemo<ReadonlyArray<DropdownMenuItem>>(() => [{
        id: 'delete',
        testID: 'new-session-draft-delete',
        title: t('sessionDrafts.delete.action'),
        disabled: props.deleteDisabled,
        icon: <Icon name="trash" size={16} color={theme.colors.state.danger.foreground} />,
    }], [props.deleteDisabled, theme.colors.state.danger.foreground]);

    const runDelete = React.useCallback(() => {
        fireAndForget(props.onDelete(), { tag: 'NewSessionDraftComposerActions.delete' });
    }, [props.onDelete]);

    return (
        <View style={styles.root}>
            <HappierPressable
                hitReach={ACTION_HIT_REACH}
                testID="new-session-draft-start-another"
                accessibilityRole="button"
                accessibilityLabel={t('sessionDrafts.startAnother')}
                onPress={props.onStartAnother}
                style={styles.labeledAction}
            >
                <Icon name="plus" size={15} color={theme.colors.text.secondary} />
                <Text variant="body" style={styles.secondaryLabel} numberOfLines={1}>
                    {t('sessionDrafts.startAnother')}
                </Text>
            </HappierPressable>
            {compact ? (
                <DropdownMenu
                    open={menuOpen}
                    onOpenChange={setMenuOpen}
                    items={deleteItems}
                    onSelect={(itemId) => {
                        if (itemId === 'delete') runDelete();
                    }}
                    placement="left"
                    variant="slim"
                    matchTriggerWidth={false}
                    maxWidthCap={220}
                    popoverPortalWebTarget="body"
                    trigger={({ toggle }) => (
                        <HappierPressable
                hitReach={ACTION_HIT_REACH}
                            testID="new-session-draft-actions-menu"
                            accessibilityRole="button"
                            accessibilityLabel={t('common.moreActions')}
                            onPress={toggle}
                            style={styles.iconAction}
                        >
                            <Icon name="dots-three" size={17} color={theme.colors.text.secondary} />
                        </HappierPressable>
                    )}
                />
            ) : (
                <HappierPressable
                hitReach={ACTION_HIT_REACH}
                    testID="new-session-draft-delete"
                    accessibilityRole="button"
                    accessibilityLabel={t('sessionDrafts.delete.action')}
                    disabled={props.deleteDisabled}
                    onPress={runDelete}
                    style={[styles.labeledAction, props.deleteDisabled && styles.disabled]}
                >
                    <Icon name="trash" size={15} color={theme.colors.text.tertiary} />
                    <Text variant="body" style={styles.deleteLabel} numberOfLines={1}>
                        {t('sessionDrafts.delete.action')}
                    </Text>
                </HappierPressable>
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    root: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: theme.space.s4,
    },
    labeledAction: {
        alignItems: 'center',
        borderRadius: 8,
        flexDirection: 'row',
        gap: theme.space.s4,
        minHeight: NEW_SESSION_DRAFT_COMPOSER_ACTION_SIZE,
        paddingHorizontal: theme.space.s8,
    },
    iconAction: {
        alignItems: 'center',
        borderRadius: 8,
        justifyContent: 'center',
        minHeight: NEW_SESSION_DRAFT_COMPOSER_ACTION_SIZE,
        minWidth: NEW_SESSION_DRAFT_COMPOSER_ACTION_SIZE,
    },
    secondaryLabel: {
        color: theme.colors.text.secondary,
    },
    deleteLabel: {
        color: theme.colors.text.tertiary,
    },
    disabled: {
        opacity: 0.4,
    },
}));
