import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HAPPIER_COLLECTION_LIST_METRICS } from '@happier-dev/plugin-ui/presentation';

import { t } from '@/text';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';

import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { Icon } from '@/components/ui/icons/Icon';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RowActionRevealSlot } from '@/components/ui/lists/RowActionRevealSlot';
import { readCoarsePrimaryPointer } from '@/components/sessions/transcript/messageActions/rowActionRevealHost';
import { useItemRowHovered } from '@/components/ui/lists/ItemRowHover';
import { useEventCallback } from '@/hooks/ui/useEventCallback';

type ProjectsListItemMenuProps = Readonly<{
    testID?: string;
    /** The checkout the row opens; `null` on a Project row with several checkouts (Hide only). */
    workspaceRef: WorkspaceRefV1 | null;
    pinAction?: 'pin' | 'unpin' | null;
    onTogglePinned: (workspaceRefId: string) => void;
    onRename: (workspaceRef: WorkspaceRefV1) => void | Promise<void>;
    onReset: (workspaceRef: WorkspaceRefV1) => void;
    onRemove: (workspaceRef: WorkspaceRefV1) => void;
    /** U2 renders these intents; their placement/creation authority stays in the shared model. */
    onNewSession?: (workspaceRef: WorkspaceRefV1) => unknown;
    onSaveAsSource?: (workspaceRef: WorkspaceRefV1) => unknown;
    /** Hide the Project this row belongs to (lab p-projects HIDE); its sessions and files stay. */
    onHideProject?: (() => void) | null;
}>;

const ROW_MENU_BUTTON_PX = 24;
/**
 * The free space around the button inside the shortest row (the button is centred in it). Stacked rows
 * touch, so the finger reach stops at the row's own edge and a neighbour's trigger never shares it.
 */
const ROW_MENU_VERTICAL_GAP_PX = HAPPIER_COLLECTION_LIST_METRICS.rowMinHeight - ROW_MENU_BUTTON_PX;

function stopPressEventPropagation(event: unknown): void {
    const maybeEvent = event as {
        stopPropagation?: () => void;
        nativeEvent?: { stopPropagation?: () => void };
    };
    try {
        maybeEvent.stopPropagation?.();
    } catch {}
    try {
        maybeEvent.nativeEvent?.stopPropagation?.();
    } catch {}
}

export const ProjectsListItemMenu = React.memo((props: ProjectsListItemMenuProps) => {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const rowHovered = useItemRowHovered();
    const pinTitle = props.pinAction === 'unpin'
        ? t('projects.actions.unpin')
        : props.pinAction === 'pin'
            ? t('projects.actions.pin')
            : null;
    const renameTitle = t('sessionsList.renameWorkspace');
    const resetTitle = t('sessionsList.resetWorkspaceName');
    const removeTitle = t('projects.actions.remove');
    const canHide = Boolean(props.onHideProject);
    const hasWorkspaceRef = props.workspaceRef != null;
    const canStartSession = Boolean(props.onNewSession);
    const canSaveAsSource = Boolean(props.onSaveAsSource);
    const items = React.useMemo((): ReadonlyArray<DropdownMenuItem> => {
        const nextItems: DropdownMenuItem[] = [];
        const hideItem: DropdownMenuItem | null = canHide ? {
            id: 'hide',
            title: t('projects.identity.hide'),
            subtitle: t('projects.identity.hideConsequence'),
            icon: <Icon name="eye-slash" size={16} color={theme.colors.text.secondary} />,
        } : null;
        if (!hasWorkspaceRef) return hideItem ? [hideItem] : [];
        // Lab p-projects HIDE: start work here and keep the repository first, then the row's own edits.
        if (canStartSession) {
            nextItems.push({
                id: 'new-session',
                title: t('projects.identity.newSessionHere'),
                icon: <Icon name="plus" size={16} color={theme.colors.text.secondary} />,
            });
        }
        if (canSaveAsSource) {
            nextItems.push({
                id: 'save-source',
                title: t('projects.identity.saveAsSource'),
                icon: <Icon name="books" size={16} color={theme.colors.text.secondary} />,
            });
        }
        if ((props.pinAction === 'pin' || props.pinAction === 'unpin') && pinTitle) {
            nextItems.push({
                id: props.pinAction,
                title: pinTitle,
                icon: <Icon name="push-pin" size={16} color={theme.colors.text.secondary} />,
            });
        }
        nextItems.push(
            {
                id: 'rename',
                title: renameTitle,
                icon: <Icon name="pencil" size={16} color={theme.colors.text.secondary} />,
            },
            {
                id: 'reset',
                title: resetTitle,
                icon: <Icon name="arrow-clockwise" size={16} color={theme.colors.text.secondary} />,
            },
            {
                id: 'remove',
                title: removeTitle,
                icon: <Icon name="trash" size={16} color={theme.colors.state.danger.foreground} />,
            },
        );
        // Hide sits before Remove: it keeps everything, Remove forgets the checkout.
        if (hideItem) nextItems.splice(nextItems.length - 1, 0, hideItem);
        return nextItems;
    }, [canHide, canSaveAsSource, canStartSession, hasWorkspaceRef, pinTitle, props.pinAction, theme.colors.state.danger.foreground, theme.colors.text.secondary, removeTitle, renameTitle, resetTitle]);

    const handleSelect = useEventCallback((itemId: string) => {
        if (itemId === 'hide') {
            props.onHideProject?.();
            return;
        }
        if (!props.workspaceRef) return;
        if (itemId === 'new-session') {
            void props.onNewSession?.(props.workspaceRef);
            return;
        }
        if (itemId === 'save-source') {
            void props.onSaveAsSource?.(props.workspaceRef);
            return;
        }
        if ((itemId === 'pin' || itemId === 'unpin') && props.pinAction) {
            props.onTogglePinned(props.workspaceRef.id);
            return;
        }
        if (itemId === 'rename') {
            void props.onRename(props.workspaceRef);
            return;
        }
        if (itemId === 'reset') {
            props.onReset(props.workspaceRef);
            return;
        }
        if (itemId === 'remove') {
            props.onRemove(props.workspaceRef);
        }
    });

    return (
        <DropdownMenu
            open={open}
            onOpenChange={setOpen}
            items={items}
            onSelect={handleSelect}
            placement="bottom"
            popoverAnchorAlign="end"
            variant="slim"
            matchTriggerWidth={false}
            maxWidthCap={240}
            showCategoryTitles={false}
            popoverPortalWebTarget="body"
            trigger={({ toggle }) => (
                // Quiet until the row is engaged (lab TREE shows no menu at rest): the shared reveal slot keeps
                // its place and stays focusable, and touch screens always show it.
                <RowActionRevealSlot revealed={Platform.OS !== 'web' || readCoarsePrimaryPointer() || rowHovered || open}>
                {/* The shared icon-only button and the row menu's glyph (the Sessions rows' "⋯"). */}
                <IconButton
                    testID={props.testID}
                    iconName="dots-three"
                    variant="plain"
                    size={ROW_MENU_BUTTON_PX}
                    interactiveTargetVerticalGapPx={ROW_MENU_VERTICAL_GAP_PX}
                    accessibilityLabel={t('common.moreActions')}
                    tooltipHidden={open}
                    onPress={(event) => {
                        stopPressEventPropagation(event);
                        toggle();
                    }}
                />
                </RowActionRevealSlot>
            )}
        />
    );
});
