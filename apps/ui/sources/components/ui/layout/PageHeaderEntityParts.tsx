import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { t } from '@/text';

/** One rare operation in an entity page's `⋯` menu. */
export type PageHeaderMenuAction = Readonly<{
    id: string;
    title: string;
    testID?: string;
    disabled?: boolean;
    /** An irreversible operation (delete, clear history): shown in the danger tone. */
    destructive?: boolean;
    /** The operation is running: the row shows progress and cannot be chosen again. */
    loading?: boolean;
    /** A policy the menu toggles ("Link new sessions automatically"): shows its current state as a check. */
    checked?: boolean;
    onSelect: () => void | Promise<void>;
    /** A chooser one level in ("Move to folder" → its folders): the row opens these instead of selecting itself. */
    children?: readonly PageHeaderMenuAction[];
    /** Why a disabled row can't run now ("MacBook Pro isn't answering"), under its title. */
    subtitle?: string;
    /** Rows of one kind sit together; the menu draws a divider between kinds. */
    category?: string;
}>;

/**
 * An entity page's `⋯` menu of rare operations, placed in `PageHeader` `actions`. `testID` names the
 * menu; its trigger is `<testID>.trigger`.
 */
export const PageHeaderMenu = React.memo(function PageHeaderMenu(props: Readonly<{
    actions: readonly PageHeaderMenuAction[];
    /** Page context controls folded into the same overflow on a phone. */
    content?: React.ReactNode;
    testID?: string;
    /** Overrides the trigger's test id (kept for pages with an established one). */
    triggerTestID?: string;
    /** Names what the menu acts on when one page holds many (a row's "Model 0, More actions"). */
    accessibilityLabel?: string;
    /**
     * Settings search asked the page for one of this menu's entries: the menu opens so the entry is in
     * view. The page wraps the menu in that setting's `SettingAnchor`, which marks the trigger.
     */
    openRequested?: boolean;
}>) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(props.openRequested === true);
    const content = props.content;
    React.useEffect(() => {
        if (props.openRequested) setOpen(true);
    }, [props.openRequested]);
    const toItem = React.useCallback((action: PageHeaderMenuAction): DropdownMenuItem => ({
        id: action.id,
        title: action.title,
        ...(action.testID ? { testID: action.testID } : {}),
        ...(action.disabled || action.loading ? { disabled: true } : {}),
        ...(action.destructive ? { destructive: true } : {}),
        ...(action.subtitle ? { subtitle: action.subtitle } : {}),
        ...(action.category ? { category: action.category } : {}),
        ...(action.checked === undefined ? {} : { checked: action.checked }),
        ...(action.loading
            ? { rightElement: <ActivitySpinner size="small" color={theme.colors.text.secondary} /> }
            : action.checked
                ? { rightElement: <Icon name="check" size={16} color={theme.colors.text.secondary} /> }
                : {}),
        ...(action.children && action.children.length > 0
            ? { submenu: { items: action.children.map((child) => toItem(child)), showCategoryTitles: false } }
            : {}),
    }), [theme.colors.text.secondary]);
    const items = React.useMemo(() => props.actions.map(toItem), [props.actions, toItem]);
    return (
        <DropdownMenu
            testID={props.testID}
            open={open}
            onOpenChange={setOpen}
            items={items}
            // Operations, not a choice: nothing reads as picked when the menu opens (DESIGN-9 N46).
            // Arrow keys still move to the first row.
            allowEmptySelection
            header={content ? <View style={stylesheet.menuContent}>{content}</View> : undefined}
            emptyLabel={content ? null : undefined}
            onSelect={(id) => {
                setOpen(false);
                return props.actions.flatMap((action) => [action, ...(action.children ?? [])])
                    .find((action) => action.id === id)?.onSelect();
            }}
            placement="bottom"
            popoverAnchorAlign="end"
            variant="slim"
            matchTriggerWidth={false}
            maxWidthCap={260}
            showCategoryTitles={false}
            popoverPortalWebTarget="body"
            trigger={({ toggle }) => (
                <IconButton
                    testID={props.triggerTestID ?? (props.testID ? `${props.testID}.trigger` : undefined)}
                    onPress={toggle}
                    accessibilityLabel={props.accessibilityLabel ?? t('common.moreActions')}
                    iconName="dots-three"
                    iconSize={18}
                    size={32}
                    variant="plain"
                    expanded={open}
                    hasPopup="menu"
                />
            )}
        />
    );
});

/**
 * An entity page's one state control ("Enabled"), placed in `PageHeader` `actions` beside the `⋯` menu:
 * a quiet label and the switch it names.
 */
export const PageHeaderStateSwitch = React.memo(function PageHeaderStateSwitch(props: Readonly<{
    label: string;
    value: boolean | undefined;
    onValueChange: (next: boolean) => void;
    disabled?: boolean;
    /**
     * A change is being saved: the switch keeps its place and value, cannot be flipped again, and
     * announces itself busy (no spinner swapped in, so the header does not move).
     */
    busy?: boolean;
    /** Test id of the switch; the label and switch together are `<testID>.control`. */
    testID?: string;
    /** Names the switch; defaults to the label. */
    accessibilityLabel?: string;
    accessibilityHint?: string;
}>) {
    return (
        <View testID={props.testID ? `${props.testID}.control` : undefined} style={stylesheet.stateSwitch}>
            <Text style={stylesheet.stateSwitchLabel}>{props.label}</Text>
            <Switch
                testID={props.testID}
                value={props.value}
                disabled={props.disabled === true || props.busy === true}
                onValueChange={props.onValueChange}
                accessibilityLabel={props.accessibilityLabel ?? props.label}
                accessibilityHint={props.accessibilityHint}
                accessibilityState={props.busy === undefined ? undefined : {
                    disabled: props.disabled === true || props.busy === true,
                    busy: props.busy,
                }}
            />
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    menuContent: {
        padding: theme.space.s12,
        gap: theme.space.s8,
    },
    stateSwitch: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    // The header's meta line type (`PageHeader` `metaText`): quiet, beside the control it names.
    stateSwitchLabel: {

        ...Typography.variant('body'),

        color: theme.colors.text.secondary,
    },
}));
