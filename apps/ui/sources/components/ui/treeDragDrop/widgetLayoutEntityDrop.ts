import { AnchoredListPositionV1Schema, resolveAnchoredListMoveV1, type AnchoredListPositionV1 } from '@happier-dev/protocol/actions/anchoredListOrderV1';
import { z } from 'zod/mini';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { entityDragScopesEqualV1, type EntityDragItemV1, type EntityDropAdmissionV1, type EntityDropPreviewV1 } from '@happier-dev/protocol/plugins/ui';
import {
    WidgetInstanceActionInputSchemasV1, findWidgetLayoutItemV1, findWidgetLayoutParentV1, getWidgetLayoutItemIdV1, resolveWidgetGroupWidthFitV1, supportsWidgetGroupsV1,
    type WidgetInstanceRefV1, type WidgetLayoutGroupV1, type WidgetLayoutItemV1, type WidgetSurfaceRefV1, type WidgetProjectAreaV1,
} from '@happier-dev/protocol/widgets';
import { t } from '@/text';
import { WIDGET_MOVE_UNCHANGED_CODE } from './entityDropNoChange';

export const WidgetLayoutDropDestinationSchema = z.strictObject({
    ...AnchoredListPositionV1Schema.shape,
    groupId: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
});
export type WidgetLayoutDropDestination = z.infer<typeof WidgetLayoutDropDestinationSchema>;

/** Its source placement is still being read: the place is neither admitted nor refused yet (`describeEntityDropOutcome` words it). */
export const WIDGET_MOVE_PENDING_CODE = 'widget_admission_pending';
/** Over its own place there is nothing to say, so the carried card shows only what it carries. */
export const WIDGET_MOVE_SILENT_CODES: ReadonlySet<string> = new Set([WIDGET_MOVE_UNCHANGED_CODE]);

/** Identity adapters do not select transport, credentials or layout authority. */
export function widgetEntitySourceRef(item: EntityDragItemV1): WidgetInstanceRefV1 | null {
    if (item.kind === 'widget-area-instance' || item.kind === 'widget-layout-group') return item.ref;
    if (item.kind === 'home-section') return { surface: { ...item.scope, owner: { kind: 'home' } }, instanceId: item.sectionId };
    if (item.kind === 'work-board-widget') return { surface: { ...item.scope, owner: { kind: 'workBoard', boardId: item.boardId } }, instanceId: item.instanceId };
    if (item.kind === 'session-board-item') return { surface: { ...item.scope, owner: { kind: 'sessionBoard', sessionId: item.address.sessionId } }, instanceId: item.itemId };
    if (item.kind === 'companion-item' && item.item.kind === 'instance') return { surface: { ...item.scope, owner: { kind: 'companion', sessionId: item.address.sessionId } }, instanceId: item.item.instance.id };
    return null;
}

/** Local feedback identity comes from the admitted owner-native position, never an anchor or preview. */
export function widgetLayoutEntityDropDestinationKey(admission: Extract<EntityDropAdmissionV1, { status: 'allowed' }>): string | null {
    if (admission.effect.actionId !== 'widgets.item.move') return null;
    const move = WidgetInstanceActionInputSchemasV1['widgets.item.move'].parse(admission.effect.input);
    // The legacy same-surface shape uses a widget ordinal; `to.index` is native content placement.
    if (!('to' in move)) return JSON.stringify(['widget-order-position', move.ref.surface,
        move.area ?? null, move.groupId ?? null, move.toIndex]);
    const { to } = move;
    return JSON.stringify(['widget-position', to.surface, to.tabId ?? null, to.area ?? null, to.groupId ?? null, to.index]);
}

/** An anchored insertion uses the destination's order after an empty source group dissolves. */
export function resolveWidgetLayoutInsertionIndex(input: Readonly<{
    ids: readonly string[];
    position: AnchoredListPositionV1;
    dissolvedGroupId?: string;
}>): number | null {
    const { ids, position } = input;
    const anchor = position.anchorId === null ? null : ids.indexOf(position.anchorId);
    if (anchor === -1) return null;
    let index = anchor === null ? position.placement === 'before' ? 0 : ids.length
        : anchor + (position.placement === 'after' ? 1 : 0);
    if (input.dissolvedGroupId) {
        const parentIndex = ids.indexOf(input.dissolvedGroupId);
        if (parentIndex >= 0) {
            if (position.anchorId === input.dissolvedGroupId) index = parentIndex;
            else if (parentIndex < index) index -= 1;
        }
    }
    return index;
}

/** Geometry supplies semantic anchors; the canonical Action remains the only writer. */
export function resolveWidgetLayoutEntityDrop(input: Readonly<{
    item: EntityDragItemV1;
    surface: WidgetSurfaceRefV1;
    items: readonly WidgetLayoutItemV1[];
    /** Native surface order, including non-widget sections on mixed surfaces such as Home. */
    topLevelIds?: readonly string[];
    /** Current source-owner read supplies size for transfers; carried identity stays identity-only. */
    sourceItem?: WidgetLayoutItemV1;
    canEdit: boolean;
    area?: WidgetProjectAreaV1;
    destination: unknown;
    preview: EntityDropPreviewV1;
    /** What the host calls a group (an untitled one is named by its widgets). */
    describeGroup?: (group: WidgetLayoutGroupV1) => string;
}>): EntityDropAdmissionV1 {
    let preview = input.preview;
    const groupName = (entry: WidgetLayoutGroupV1) => input.describeGroup?.(entry) ?? entry.title ?? t('widgetFrame.groupUntitled');
    const refused = (code: string): EntityDropAdmissionV1 => ({ status: 'refused', reason: { code, message: code }, preview });
    const ref = widgetEntitySourceRef(input.item);
    if (!ref) return refused('unsupported_widget_surface');
    if (!entityDragScopesEqualV1(input.item.scope, input.surface)) return refused('scope-mismatch');
    if (!input.canEdit) return refused('widget_edit_denied');
    const parsed = WidgetLayoutDropDestinationSchema.safeParse(input.destination ?? { anchorId: null, placement: 'after' });
    if (!parsed.success) return refused('anchor-gone');
    const position = parsed.data;
    // The parsed destination owns both the movement and its preview; a child anchor still means
    // above/below that child, even when the write keeps it inside a group.
    preview = position.anchorId === null ? { ...input.preview, glyph: 'move' } : {
        ...input.preview,
        glyph: position.placement === 'before' ? 'above' : 'below',
        verb: t(position.placement === 'before' ? 'entityDragDrop.preview.moveAbove' : 'entityDragDrop.preview.moveBelow', { target: input.preview.target }),
    };
    if ((position.groupId || input.item.kind === 'widget-layout-group') && !supportsWidgetGroupsV1(input.surface.owner.kind)) return refused('widget_placement_unsupported');
    const area = input.surface.owner.kind === 'project' ? input.area ?? 'main' : undefined;
    if (input.surface.owner.kind !== 'project' && input.area) return refused('widget_placement_unsupported');
    const sameSurface = sameStrictJsonValue(ref.surface, input.surface);
    const sourcePlacement = sameSurface ? findWidgetLayoutItemV1(input.items, ref.instanceId) ?? input.sourceItem : input.sourceItem;
    const sourceParent = sameSurface ? findWidgetLayoutParentV1(input.items, ref.instanceId) : undefined;
    const group = position.groupId ? input.items.find(item => item.kind === 'group' && item.id === position.groupId) : undefined;
    if (position.groupId && (!group || group.kind !== 'group')) return refused('widget_group_not_found');
    // A group's own refusals name the group that cannot take it (lab wgdnd 5, 6).
    const cannotEnter = (code: string, wayForward?: string) => {
        if (group?.kind === 'group') preview = { ...preview, glyph: 'refused', verb: t('widgetFrame.cantPutInGroup', { group: groupName(group) }) };
        return wayForward ? { status: 'refused' as const, reason: { code, message: wayForward }, preview } : refused(code);
    };
    // A group carried over a group: the way forward names both ("Drop This week above or below happier").
    const nestingWayForward = () => sourcePlacement?.kind === 'group' && group?.kind === 'group'
        ? t('widgetFrame.groupRefusedNestingNamed', { group: groupName(sourcePlacement), target: groupName(group) }) : undefined;
    if (sourcePlacement?.kind === 'group' || input.item.kind === 'widget-layout-group') {
        if (sameSurface && position.groupId === ref.instanceId) return refused('same-position');
        if (position.groupId) return cannotEnter('widget_group_nesting_forbidden', nestingWayForward());
        if (!sameSurface) return refused('unsupported_widget_transfer');
    }
    if (group?.kind === 'group') {
        if (area && (group.area ?? 'main') !== area) return refused('widget_group_not_found');
        if (!sourcePlacement) return refused(WIDGET_MOVE_PENDING_CODE);
        if (sourcePlacement.kind === 'group') return cannotEnter('widget_group_nesting_forbidden');
        const children = [...group.children.filter(child => child.instance.id !== ref.instanceId), sourcePlacement];
        if (!resolveWidgetGroupWidthFitV1(children).availableWidths.includes(group.width)) return cannotEnter('widget_group_width_no_fit');
    }
    const destinationPlacements = group?.kind === 'group' ? group.children
        : area === undefined ? input.items : input.items.filter(entry => (entry.area ?? 'main') === area);
    const ids = !group && area === undefined && input.topLevelIds
        ? input.topLevelIds : destinationPlacements.map(getWidgetLayoutItemIdV1);
    if (position.anchorId !== null && !ids.includes(position.anchorId)) return refused('anchor-gone');
    const sameArea = sameSurface && (sourceParent?.id ?? null) === (position.groupId ?? null)
        && (area === undefined || !!sourcePlacement && ((sourceParent ?? sourcePlacement).area ?? 'main') === area);
    // What the release does to membership (lab wgdnd 1-4): into a group, inside it, out of it, or a whole group.
    if (group?.kind === 'group' && sourceParent?.id !== group.id) {
        const place = position.anchorId === null ? t('widgetFrame.intoGroupEnd')
            : t(position.placement === 'before' ? 'widgetFrame.intoGroupAbove' : 'widgetFrame.intoGroupBelow', { target: input.preview.target });
        // A widget keeps its size inside the group (lab wgdnd 1 "· stays Small").
        const keeps = sourcePlacement?.kind === 'widget'
            ? t('widgetFrame.intoGroupKeepsSize', { size: t(`widgetAdd.sizes.${sourcePlacement.size ?? 'medium'}`) }) : null;
        preview = { ...preview, verb: t('widgetFrame.moveIntoGroupNamed', { group: groupName(group) }),
            consequence: keeps ? `${place} · ${keeps}` : place };
    } else if (group?.kind === 'group') preview = { ...preview, consequence: t('widgetFrame.reorderInGroupDetail') };
    else if (sourceParent) preview = { ...preview, consequence: t('widgetFrame.outOfGroupDetail', { group: groupName(sourceParent) }) };
    else if (sourcePlacement?.kind === 'group') preview = { ...preview, consequence: t('widgetFrame.wholeGroupDetail', { count: sourcePlacement.children.length }) };
    let index: number;
    if (sameArea) {
        const order = resolveAnchoredListMoveV1(ids, ref.instanceId, position);
        if (!order) return refused('widget_instance_not_found');
        index = order.indexOf(ref.instanceId);
        if (index === ids.indexOf(ref.instanceId)) return refused('same-position');
    } else {
        if (ids.includes(ref.instanceId)) return refused('widget_instance_already_exists');
        index = resolveWidgetLayoutInsertionIndex({ ids, position,
            ...(!position.groupId && sourceParent?.children.length === 1 ? { dissolvedGroupId: sourceParent.id } : {}),
        })!;
    }
    return { status: 'allowed', effect: { actionId: 'widgets.item.move', input: { ref, to: { surface: input.surface, index,
        ...(area ? { area } : {}), groupId: position.groupId ?? null } }, preview } };
}
