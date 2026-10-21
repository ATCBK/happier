import * as React from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { PopoverAnchor } from '@/components/ui/popover';
import { resolveWorkspaceOpenModeFromPointer, useWorkspaceOpenActions } from './useWorkspaceOpenActions';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { useEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropHooks';
import { isSecondaryEntityRowControl, useEntityDragDomBinding } from '@/components/ui/treeDragDrop/useEntityDragDomBinding';
import { useOptionalWorkspaceNavigation } from './WorkspaceNavigationContext';
import { readDestinationInstanceTitle, resolveDestinationRefFromHref } from '../destinations/compactAppDestinationCatalog';
import type { EntityDragItemV1 } from '@happier-dev/protocol/plugins/ui';
import { resolveWorkspaceDestinationEntityItem } from './workspaceEntitySource';
import { useEntityComposerMention } from '@/components/ui/treeDragDrop/useEntityComposerMention';
import { t } from '@/text';

type WorkspaceDestinationRowProps = Readonly<{
    href: string | null;
    /** Handoff, not a copy: release this source only once the destination has opened. */
    onOpened?: () => void;
    /** Document tabs handle middle click through their own close callback. Other rows open a tab. */
    middleClickBehavior?: 'open' | 'passthrough';
    /** Host-built qualified identity for destinations that also supply context. */
    entityItem?: EntityDragItemV1 | null;
    entityTitle?: string;
    children: React.ReactNode | ((actions: ReturnType<typeof useWorkspaceOpenActions> & Readonly<{ openMenu(): void }>) => React.ReactNode);
    style?: StyleProp<ViewStyle>;
    /** Rows with an existing menu already include useWorkspaceOpenActions.items there. */
    existingMenu?: boolean;
    /**
     * `false` when the row already is a drag source of its own (a Session row carries itself through
     * the Session list's drag), so one row never offers two competing drags. Click, modifier-click
     * and the open menu stay.
     */
    dragSource?: boolean;
}>;

/** Destination gestures share one owner, without replacing the row's normal activation or anatomy. */
export function WorkspaceDestinationRow(props: WorkspaceDestinationRowProps) {
    if (!props.href && !props.entityItem && typeof props.children !== 'function') return props.style ? <View style={props.style}>{props.children}</View> : <>{props.children}</>;
    return <WorkspaceDestinationRowDestination {...props} />;
}

function WorkspaceDestinationRowDestination(props: WorkspaceDestinationRowProps) {
    const actions = useWorkspaceOpenActions(props.href, props.onOpened);
    const workspace = useOptionalWorkspaceNavigation();
    const scope = useActiveServerAccountScope();
    const runtime = useEntityDragDropRuntime();
    const mention = useEntityComposerMention();
    const sourceId = React.useId();
    const [anchor, setAnchor] = React.useState<PopoverAnchor | null>(null);
    const latest = React.useRef({ actions, props, workspace, scope });
    latest.current = { actions, props, workspace, scope };
    const detach = React.useRef<(() => void) | null>(null);
    const host = React.useRef<HTMLElement | null>(null);
    const anchorRef = React.useRef<View | HTMLElement | null>(null);
    const getItem = (): EntityDragItemV1 | null => {
        const current = latest.current;
        const href = current.props.href;
        if (!current.scope || (!current.props.entityItem && (!href || current.actions.items.length === 0))) return null;
        return resolveWorkspaceDestinationEntityItem({ href, scope: current.scope,
            catalog: current.workspace?.catalog, entityItem: current.props.entityItem });
    };
    const currentGetItem = React.useRef(getItem);
    currentGetItem.current = getItem;
    // The carried card names the destination the way its tab will (DnD lab E1/C2).
    const describe = (): string | null => {
        const { props: current, workspace: navigation } = latest.current;
        const ref = current.href && navigation?.catalog ? resolveDestinationRefFromHref(navigation.catalog, current.href) : null;
        return current.entityTitle ?? (ref && navigation?.catalog ? readDestinationInstanceTitle(navigation.catalog, ref) : null);
    };
    const currentDescribe = React.useRef(describe);
    currentDescribe.current = describe;
    const openMenu = React.useCallback(() => {
        if (latest.current.props.existingMenu || (!latest.current.actions.items.length && !currentGetItem.current())) return;
        setAnchor({ kind: 'view', ref: anchorRef });
    }, []);
    const dragSource = props.dragSource !== false;
    React.useEffect(() => {
        if (!scope || !dragSource) return;
        return runtime.registerSource({ id: sourceId, scope,
            getItem: () => currentGetItem.current(),
            describe: () => {
                const title = currentDescribe.current();
                return title ? { title } : null;
            },
            isCurrent: () => latest.current.scope?.serverId === scope.serverId
                && latest.current.scope.accountId === scope.accountId && currentGetItem.current() !== null,
        });
    }, [runtime, sourceId, scope?.serverId, scope?.accountId, dragSource]);
    const sourceRef = useEntityDragDomBinding({ runtime, sourceId, enabled: dragSource && getItem() !== null,
        describe: () => currentDescribe.current() ?? '',
        canStart: (event, element) => !isSecondaryEntityRowControl(event, element) });
    React.useEffect(() => () => detach.current?.(), []);
    const attach = React.useCallback((node: unknown) => {
        anchorRef.current = node as View | HTMLElement | null;
        detach.current?.();
        detach.current = null;
        host.current = null;
        sourceRef(node);
        if (Platform.OS !== 'web') return;
        const element = node as HTMLElement | null;
        if (!element?.addEventListener) return;
        host.current = element;
        // A row's secondary controls keep their own actions (disclosure, selection, pin, overflow).
        const secondaryControl = (event: Event) => isSecondaryEntityRowControl(event, element);
        const pointer = (event: MouseEvent) => {
            if (event.defaultPrevented || secondaryControl(event)) return;
            if (event.button === 1 && latest.current.props.middleClickBehavior === 'passthrough') return;
            const mode = resolveWorkspaceOpenModeFromPointer(event);
            if (mode && latest.current.actions.open(mode)) {
                event.preventDefault();
                event.stopPropagation();
            }
        };
        const context = (event: MouseEvent) => {
            if (latest.current.props.existingMenu || (!latest.current.actions.items.length && !currentGetItem.current()) || secondaryControl(event)) return;
            event.preventDefault();
            event.stopPropagation();
            setAnchor({ kind: 'rect', rect: { left: event.clientX, top: event.clientY, height: 1 }, coordinateSpace: 'window' });
        };
        element.addEventListener('click', pointer, true);
        element.addEventListener('auxclick', pointer, true);
        element.addEventListener('contextmenu', context);
        detach.current = () => {
            element.removeEventListener('click', pointer, true);
            element.removeEventListener('auxclick', pointer, true);
            element.removeEventListener('contextmenu', context);
        };
    }, [sourceRef]);
    return <View ref={attach} style={props.style}>
        {typeof props.children === 'function' ? props.children({ ...actions, openMenu }) : props.children}
        {!props.existingMenu && anchor !== null ? <DropdownMenu
            open={anchor !== null}
            onOpenChange={(open) => { if (!open) setAnchor(null); }}
            popoverAnchor={anchor ?? undefined}
            items={[...actions.items, ...(getItem() ? [{ id: 'entity.mentionInComposer', title: t('entityDragDrop.composer.mentionInComposer') }] : [])]}
            onSelect={(id) => {
                if (id === 'entity.mentionInComposer') {
                    const item = currentGetItem.current();
                    if (item) void mention(item, currentDescribe.current() ?? '');
                } else actions.select(id);
                setAnchor(null);
            }}
            placement="bottom"
            variant="slim"
            matchTriggerWidth={false}
            popoverPortalWebTarget="body"
            trigger={() => null}
        /> : null}
    </View>;
}
