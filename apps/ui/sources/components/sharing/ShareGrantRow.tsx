import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { HappierShareGrantRow, HappierShareLevelControl, HappierShareRowAction,
    type HappierShareGrantRemoval, type HappierShareRowActionProps } from '@happier-dev/plugin-ui/presentation';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { ITEM_CHEVRON_SIZE } from '@/components/ui/lists/itemDensityMetrics';
import { useResolvedItemDensity } from '@/components/ui/lists/useResolvedItemDensity';
import { t } from '@/text';
import { useSharePresentationHost } from './sharePresentationHost';
import { SHARE_ACCESS_LEVEL_ORDER, type ShareAccessLevel, type ShareGrantRowModel, type ShareSheetActions,
    type ShareSheetAdapter, type ShareSheetSectionContext } from './shareSheetTypes';

/** Domain level order stays with the sharing adapter, not the neutral presenter. */
export function orderShareAccessLevels(levels: readonly ShareAccessLevel[]): readonly ShareAccessLevel[] {
    return SHARE_ACCESS_LEVEL_ORDER.filter(level => levels.includes(level));
}

export function ShareRowAction(props: Omit<HappierShareRowActionProps, 'host'>): React.ReactElement {
    return <HappierShareRowAction {...props} host={useSharePresentationHost()} />;
}

function isBusy(row: ShareGrantRowModel): boolean {
    return row.operation.kind === 'saving' || row.operation.kind === 'removing';
}

export function ShareLevelControl<TRow extends ShareGrantRowModel>(props: Readonly<{
    row: TRow; adapter: ShareSheetAdapter<TRow>; actions: ShareSheetActions; onExpand(): void; testID: string; editable: boolean;
}>): React.ReactElement {
    const { row, actions } = props;
    const { theme } = useUnistyles();
    const host = useSharePresentationHost();
    const density = useResolvedItemDensity();
    const label = props.adapter.levels[row.level.value]?.label ?? t('shareSheet.accessLevel');
    return <HappierShareLevelControl host={host} label={label} testID={props.testID}
        // A quiet mark at the row's trailing-glyph step, in the one icon family, beside the level it locks.
        // In a sheet the viewer manages, a level they cannot change here is marked too, so it reads as a held
        // level rather than as fixed role text like Owner; pressing it says why.
        lock={props.adapter.showsLevelLock?.(row) || (props.editable && row.level.kind === 'locked')
            ? <Icon name="lock" size={ICON_SIZE.sm} color={theme.colors.text.secondary} testID={`${props.testID}:lock`} /> : undefined}
        accessibilityLabel={t('shareSheet.accessibleControl', { name: row.principal.accessibilityLabel, control: t('shareSheet.accessLevel'), value: label })}
        disabled={isBusy(row)}
        // The same caret, at the same size, as every other select trigger (the dropdown trigger's own glyph).
        trailing={props.editable && row.level.kind === 'editable' ? <Icon name="caret-down" size={ITEM_CHEVRON_SIZE[density]} color={theme.colors.text.secondary} /> : undefined}
        onPress={() => row.level.kind === 'locked' ? actions.explain(row.level.reason) : props.onExpand()} />;
}

/** Qualify capabilities and bind exact grant callbacks; shared presentation draws every control. */
export function ShareGrantRow<TRow extends ShareGrantRowModel>(props: Readonly<{
    row: TRow; adapter: ShareSheetAdapter<TRow>; actions: ShareSheetActions; context: ShareSheetSectionContext;
}>): React.ReactElement {
    const { row, actions, adapter, context } = props;
    const host = useSharePresentationHost();
    const { editable } = context;
    const removalLabels = adapter.removalLabels?.(row);
    const id = (kind: string) => `${context.idPrefix}${adapter.namespace}-${kind}:${row.principal.key}`;
    const levels = editable && row.level.kind === 'editable' ? orderShareAccessLevels(row.level.options).flatMap(level => {
        const presentation = adapter.levels[level];
        return presentation ? [{ id: level, label: presentation.label, testID: `${id('level')}:${level}`,
            selected: row.level.value === level, accessibilityLabel: `${row.principal.accessibilityLabel}, ${presentation.label}`,
            onPress: () => actions.setAccessLevel(row.grant, level) }] : [];
    }) : undefined;
    let removal: HappierShareGrantRemoval | undefined;
    if (editable && row.removal.kind === 'allowed') removal = { kind: 'allowed', request: {
        testID: id('remove'), label: removalLabels?.request ?? t('shareSheet.remove'), onPress: () => actions.requestRemove(row.grant),
    } };
    if (editable && row.removal.kind === 'confirming') removal = { kind: 'confirming', consequences: row.removal.consequences,
        consequenceTestID: id('remove-consequence'), confirm: { testID: id('remove-confirm'),
            label: removalLabels?.confirm ?? t('shareSheet.confirmRemove'), onPress: () => actions.confirmRemove(row.grant) },
        cancel: { testID: id('remove-cancel'), label: t('common.cancel'), onPress: () => actions.cancelRemove(row.grant) } };
    if (row.removal.kind === 'blocked') { const reason = row.removal.reason; removal = { kind: 'blocked', explain: {
        testID: id('remove-reason'), label: reason.message, onPress: () => actions.explain(reason),
    } }; }
    return <HappierShareGrantRow host={host} busy={isBusy(row)} levels={levels} removal={removal}
        levelsAccessibilityLabel={`${row.principal.accessibilityLabel}, ${t('shareSheet.accessLevel')}`}
        lockedReason={row.level.kind === 'locked' ? row.level.reason.message : undefined}
        details={adapter.renderGrantDetails?.(row, context)}
        error={row.operation.kind === 'error' ? row.operation.error.message : undefined}
        retry={editable && row.operation.kind === 'error' && row.operation.error.retryable ? {
            testID: id('retry'), label: t('common.retry'), accessibilityLabel: `${row.principal.accessibilityLabel}, ${t('common.retry')}`,
            onPress: () => actions.retryMutation(row.grant),
        } : undefined} />;
}
