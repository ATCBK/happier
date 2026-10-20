import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_ICON_BUTTON_SIZE, useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { PaneHeader, type PaneHeaderLineSegment } from '@/components/appShell/panes/PaneHeader';
import { useClaimedStackHeaderActions } from '@/components/navigation/stackHeaderActions';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import type { IconName } from '@/components/ui/icons/Icon';
import { PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { useSurfaceStateSize } from '@/components/ui/surfaces/surfaceStateSize';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { DETAILS_TAB_HEADER_METRICS } from './detailsTabHeaderMetrics';

/**
 * One fact on the header's live line, in reading order. `strong` is the one noun the line is about
 * (a branch, an author); a `diffStat` reads as one fact (`+4 −2`).
 */
export type DetailsTabHeaderMetaFact =
    | Readonly<{ key: string; kind?: 'text'; text: string; tone?: 'default' | 'muted' | 'strong' | 'mono'; shrink?: boolean; testID?: string;
        /** A glyph leading the fact (the task a conversation hangs off, a lock before who can read it). */
        icon?: IconName;
        /** A glyph-led fact that leads back to its thing (the Session, Doc or task a conversation hangs off). */
        onPress?: () => void;
        accessibilityLabel?: string }>
    | Readonly<{ key: string; kind: 'diffStat'; added: number; removed: number; testID?: string }>;

export type DetailsTabHeaderAction = Readonly<{
    label: string;
    onPress: () => void;
    disabled?: boolean;
    busy?: boolean;
    /** `primary` is the surface's one filled action (Save, Restore); `default` a quiet bordered one (Stage). */
    tone?: 'primary' | 'default' | 'danger';
    accessibilityLabel?: string;
    testID?: string;
}>;

export type DetailsTabHeaderProps = Readonly<{
    /** The thing this tab shows, in its own words: the file name, the commit subject, the stash as a place. */
    title: string;
    leading?: React.ReactNode;
    titleControl?: React.ReactNode;
    titleTextStyle?: React.ComponentProps<typeof PaneHeader>['titleTextStyle'];
    meta?: readonly DetailsTabHeaderMetaFact[];
    /** A live status or presence leaf; its own subscription keeps ticking out of the header owner. */
    metaLeading?: React.ReactNode;
    /**
     * `mark`: the leading leaf is a mark (a stack of faces) that the facts follow directly, as a glyph
     * does; `text` (default) is words, joined to the facts by the line's " · ".
     */
    metaLeadingKind?: 'text' | 'mark';
    metaTrailing?: React.ReactNode;
    /** A short paragraph under the header (a commit body, what Restore will do). */
    body?: React.ReactNode;
    /** Quiet controls in the header band (icon toggles), before the buttons. */
    actions?: React.ReactNode;
    /** The surface's actions, in order; at most one is `primary`. */
    buttons?: readonly DetailsTabHeaderAction[];
    /** Rare operations behind `⋯`. */
    menuActions?: readonly PageHeaderMenuAction[];
    /** A domain menu with richer facts (Run details), still placed by this header's phone policy. */
    menu?: React.ReactNode;
    /** Controls that shape the view (Diff | File, Unstaged ▾, a stash switcher), on one thin row under the band. */
    controls?: React.ReactNode;
    /** One line under the header (freshness, the file changed under an edit). */
    notice?: React.ReactNode;
    testID?: string;
}>;

function toLineSegments(meta: readonly DetailsTabHeaderMetaFact[] | undefined): PaneHeaderLineSegment[] {
    const segments: PaneHeaderLineSegment[] = [];
    for (const fact of meta ?? []) {
        if (fact.kind === 'diffStat') {
            if (fact.added > 0 || fact.removed === 0) segments.push({ text: `+${fact.added}`, tone: 'added' });
            if (fact.removed > 0) segments.push({ text: `−${fact.removed}`, tone: 'removed' });
            continue;
        }
        segments.push(fact.icon ? { text: fact.text, icon: fact.icon,
            ...(fact.onPress ? { onPress: fact.onPress, testID: fact.testID, ...(fact.accessibilityLabel ? { accessibilityLabel: fact.accessibilityLabel } : {}) } : {}) }
            : fact.tone === 'strong' ? { text: fact.text, emphasis: true } : fact.text);
    }
    return segments;
}

/**
 * The header of a Details tab: a Details adapter over the one pane header (`PaneHeader`). The band
 * names the thing (title), places it (the live line: path, who, when, how much) and carries what it
 * is for (quiet toggles, the buttons, `⋯`). Only what is Details' own sits beneath it — one thin row of
 * view controls, an optional body, one notice line — so a header never eats the code's height.
 *
 * On a phone the band takes the pane header's large step and the controls stay on their own row; quiet
 * toggles join `⋯` in the band when the header has no controls or buttons for that row.
 */
export const DetailsTabHeader = React.memo(function DetailsTabHeader(props: DetailsTabHeaderProps) {
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    const phone = useSurfaceStateSize() === 'phone';
    const metrics = DETAILS_TAB_HEADER_METRICS[phone ? 'phone' : 'pane'];
    const styles = stylesheet;
    const testID = props.testID ?? 'details-tab-header';
    const segments = React.useMemo(() => toLineSegments(props.meta), [props.meta]);

    // The pane's own controls (⤢, close), when the pane showing this tab has no bar of its own.
    const paneControls = useClaimedStackHeaderActions({ scopeOnly: true });
    // The view controls sit on the facts line while they leave the facts at least as much room as they
    // take; a narrower band would push them over its actions, so they take their own row beneath it.
    const [band, setBand] = React.useState({ root: 0, actions: 0, controls: 0, trailing: 0, trailingMenu: false });
    const measure = (key: 'root' | 'actions' | 'controls') => (event: LayoutChangeEvent) => {
        const width = Math.round(event.nativeEvent.layout.width);
        setBand((current) => current[key] === width ? current : { ...current, [key]: width });
    };
    // Each button's natural width, kept while it sits in `⋯`, so folding never feeds back into the fit.
    const [buttonWidths, setButtonWidths] = React.useState<Readonly<Record<string, number>>>({});
    const measureButton = (key: string) => (event: LayoutChangeEvent) => {
        const width = Math.round(event.nativeEvent.layout.width);
        setButtonWidths((current) => current[key] === width ? current : { ...current, [key]: width });
    };
    const buttonList = props.buttons ?? [];
    const keyOf = (button: DetailsTabHeaderAction) => button.testID ?? button.label;
    const buttonsMeasured = buttonList.every((button) => (buttonWidths[keyOf(button)] ?? 0) > 0);
    const sum = (widths: readonly number[], gap: number) => widths.length === 0 ? 0
        : widths.reduce((total, width) => total + width, 0) + gap * (widths.length - 1);
    // The actions at their natural one-row width: the quiet toggles, then every button.
    const actionsWidth = (visible: readonly DetailsTabHeaderAction[], withIcons = true) => sum([
        ...(props.actions && withIcons ? [band.actions] : []),
        ...visible.map((button) => buttonWidths[keyOf(button)] ?? 0),
    ], theme.space.s4);
    const naturalActions = buttonsMeasured ? actionsWidth(buttonList) : 0;
    const rowRoom = band.root - metrics.paddingStartPx - metrics.paddingEndPx;
    // `⋯` and the pane's own controls stay in the band beside the title, so the title never has their room.
    // The trailing group is measured with or without a `⋯`; the fit below counts it explicitly either way.
    const menuSlot = HAPPIER_ICON_BUTTON_SIZE + theme.space.s4;
    const menuForced = props.menu !== undefined || (props.menuActions?.length ?? 0) > 0;
    const roomBesideTitle = rowRoom - (band.trailing - (band.trailingMenu ? menuSlot : 0));
    const bandRoom = roomBesideTitle - (menuForced ? menuSlot : 0);
    // The actions keep their place beside the title while they leave it at least as much room as they
    // take; in a narrower pane they would cut the name to a few letters, so they move to the row beneath.
    const besideFits = (width: number, room: number) => width > 0 && room - width >= width;
    // The quieter buttons (first to last; never the last, never a primary) move into `⋯` until the rest `fits`.
    const foldQuietButtons = (fits: (visible: readonly DetailsTabHeaderAction[]) => boolean): ReadonlySet<string> => {
        const folded = new Set<string>();
        const visible = () => buttonList.filter((button) => !folded.has(keyOf(button)));
        for (const button of buttonList.slice(0, -1)) {
            if (fits(visible())) break;
            if (button.tone !== 'primary') folded.add(keyOf(button));
        }
        return folded;
    };
    // Beneath the band the view controls and the actions share one row, and the quieter buttons fold into `⋯`
    // until it fits. When even the buttons that stay (the last, and a primary) would still break that row in two,
    // a button alone on a row of its own reads as an afterthought: the staying buttons keep their place beside
    // the title instead, and the quiet toggles and the other buttons wait in `⋯`.
    const foldedRoom = roomBesideTitle - menuSlot;
    const controlsWidth = props.controls ? band.controls + theme.space.s6 : 0;
    const foldedAll = foldQuietButtons(() => false);
    const rowBelowHoldsStaying = controlsWidth + actionsWidth(buttonList.filter((button) => !foldedAll.has(keyOf(button))), false) <= rowRoom;
    const besideFolded = !phone && band.root > 0 && props.menu === undefined && Boolean(props.actions) && band.actions > 0
        && buttonsMeasured && !besideFits(naturalActions, bandRoom) && !rowBelowHoldsStaying
        ? foldQuietButtons((visible) => besideFits(actionsWidth(visible, false), foldedRoom)) : null;
    const besideWidth = besideFolded ? actionsWidth(buttonList.filter((button) => !besideFolded.has(keyOf(button))), false) : 0;
    const togglesFoldBesideTitle = besideFolded !== null && besideFits(besideWidth, foldedRoom);
    const lineRoom = togglesFoldBesideTitle ? foldedRoom - besideWidth : bandRoom - naturalActions;
    const actionsBelow = !phone && band.root > 0 && naturalActions > 0 && !besideFits(naturalActions, bandRoom) && !togglesFoldBesideTitle;
    const controlsBelow = !phone && Boolean(props.controls) && band.root > 0 && (actionsBelow || lineRoom < band.controls * 2);
    // Beneath the band the one row folds the same way, and when it still runs out the quiet toggles follow into `⋯`,
    // so the row never breaks in two.
    const actionsInRow = phone || actionsBelow;
    let folded: ReadonlySet<string> = togglesFoldBesideTitle ? besideFolded! : new Set<string>();
    let iconsFolded = togglesFoldBesideTitle;
    if (actionsInRow && buttonsMeasured && band.root > 0 && props.menu === undefined) {
        const rowFits = (visible: readonly DetailsTabHeaderAction[]) => controlsWidth + actionsWidth(visible) <= rowRoom;
        folded = foldQuietButtons(rowFits);
        iconsFolded = Boolean(props.actions) && band.actions > 0
            && !rowFits(buttonList.filter((button) => !folded.has(keyOf(button))));
    }
    const buttons = buttonList.length > 0 ? buttonList.map((button) => {
        const key = keyOf(button);
        return folded.has(key) ? null : (
            <View key={key} style={styles.measured} onLayout={measureButton(key)}>
                <ToolbarButton
                    testID={button.testID}
                    label={button.label}
                    accessibilityLabel={button.accessibilityLabel}
                    onPress={button.disabled || button.busy ? undefined : button.onPress}
                    disabled={button.disabled || button.busy}
                    busy={button.busy}
                    tone={button.tone ?? 'default'}
                    size={phone ? 'md' : 'sm'}
                />
            </View>
        );
    }) : null;
    const foldedActions: PageHeaderMenuAction[] = buttonList.filter((button) => folded.has(keyOf(button))).map((button) => ({
        id: `button:${keyOf(button)}`,
        title: button.label,
        ...(button.testID ? { testID: button.testID } : {}),
        ...(button.disabled ? { disabled: true } : {}),
        ...(button.busy ? { loading: true } : {}),
        onSelect: button.onPress,
    }));
    const menuActions = [...foldedActions, ...(props.menuActions ?? [])];
    const menu = props.menu ?? (menuActions.length > 0 || iconsFolded ? (
        <PageHeaderMenu testID={`${testID}.menu`} actions={menuActions}
            content={iconsFolded ? <View testID={`${testID}.foldedIcons`} style={styles.foldedIcons}>{props.actions}</View> : undefined} />
    ) : null);
    // Whether the measured group held a `⋯` is read from the render that drew it, so the fit never double counts it.
    const measureTrailing = (event: LayoutChangeEvent) => {
        const width = Math.round(event.nativeEvent.layout.width);
        const trailingMenu = menu !== null && menu !== undefined;
        setBand((current) => current.trailing === width && current.trailingMenu === trailingMenu ? current : { ...current, trailing: width, trailingMenu });
    };
    const controls = props.controls ? (
        <View testID={`${testID}.controls`} style={styles.controlsMeasure} onLayout={measure('controls')}>{props.controls}</View>
    ) : null;
    // The quiet toggles, measured at their natural width wherever they sit.
    const iconActions = props.actions && !iconsFolded ? (
        <View testID={`${testID}.icons`} style={styles.measured} onLayout={measure('actions')}>{props.actions}</View>
    ) : null;
    // A phone recomposes: only `⋯` stays beside the title; the toggles and buttons move beneath it.
    const wideActions = iconActions || buttons ? (
        <View testID={`${testID}.actions`} style={actionsBelow ? [styles.bandActions, styles.actionsWrap] : styles.bandActions}>
            {iconActions}
            {buttons}
        </View>
    ) : null;
    // A phone keeps quiet toggles beside `⋯` when they are all the header carries: a row beneath the
    // band holding only a toggle or two reads as an afterthought and costs the content a band of height.
    const phoneIconsInBand = phone && Boolean(iconActions) && !props.controls && buttonList.length === 0;
    const bandActions = phone
        ? (phoneIconsInBand ? <View style={styles.bandActions}>{iconActions}{menu}</View> : (menu ?? undefined))
        : wideActions || menu || paneControls ? (
            <View style={styles.bandActions}>
                {actionsBelow ? null : wideActions}
                {menu || paneControls ? (
                    <View testID={`${testID}.trailing`} style={styles.bandActions} onLayout={measureTrailing}>
                        {menu}
                        {paneControls}
                    </View>
                ) : null}
            </View>
        ) : undefined;
    const phoneToolbar = phone && (props.controls || (props.actions && !phoneIconsInBand) || buttons || paneControls) ? (
        <View style={styles.controls}>
            {controls}
            <View style={styles.grow} />
            {phoneIconsInBand ? null : iconActions}
            {buttons}
            {paneControls}
        </View>
    ) : controlsBelow || actionsBelow ? (
        <View style={styles.controls}>
            {controlsBelow ? controls : null}
            <View style={styles.grow} />
            {actionsBelow ? wideActions : null}
        </View>
    ) : null;

    return (
        <View testID={`${testID}.root`} onLayout={measure('root')} style={[styles.root, { backgroundColor: materialColor(theme.colors.surface.base, 'transparent') }]}>
            <PaneHeader
                testID={testID}
                title={props.title}
                leading={props.leading}
                titleControl={props.titleControl}
                titleTextStyle={props.titleTextStyle}
                titleNumberOfLines={phone ? null : 1}
                lineTrailing={!phone && !controlsBelow ? controls : undefined}
                lineEnd={props.metaTrailing}
                line={segments.length > 0 || props.metaLeading ? {
                    segments,
                    leading: props.metaLeading ? <View style={styles.liveFacts}>
                        {props.metaLeading}
                        {segments.length > 0 && props.metaLeadingKind !== 'mark' ? <Text style={[styles.metaSeparator, metrics.meta]}>·</Text> : null}
                    </View> : undefined,
                } : null}
                actions={bandActions}
                size={phone ? 'large' : 'band'}
            />
            {props.body || phoneToolbar ? (
                <View style={[styles.below, { paddingLeft: metrics.paddingStartPx, paddingRight: metrics.paddingEndPx }]}>
                    {phoneToolbar}
                    {props.body ? (
                        typeof props.body === 'string'
                            ? <Text testID={`${testID}.body`} style={[styles.body, metrics.body]}>{props.body}</Text>
                            : props.body
                    ) : null}
                </View>
            ) : null}
            {props.notice ?? null}
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.subtle,
        backgroundColor: theme.colors.surface.base,
    },
    bandActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    liveFacts: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 1,
        minWidth: 0,
        gap: theme.space.s4,
    },
    metaSeparator: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
    },
    below: {
        gap: theme.space.s4,
        paddingBottom: theme.space.s6,
    },
    controls: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: theme.space.s6,
    },
    grow: {
        flex: 1,
    },
    actionsWrap: {
        flexWrap: 'wrap',
        flexShrink: 1,
        justifyContent: 'flex-end',
    },
    controlsMeasure: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 0,
    },
    measured: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 0,
        gap: theme.space.s4,
    },
    foldedIcons: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    body: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        maxWidth: 560,
    },
}));
