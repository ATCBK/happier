import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DETAILS_TAB_STRIP_METRICS as M } from '@/components/appShell/panes/details/header/detailsTabHeaderMetrics';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { DocumentTabStrip, type DocumentTabPresentation } from '@/components/ui/navigation/DocumentTabStrip';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';

import {
    describeSessionTerminalStatus,
    type SessionTerminalDescriptor,
    type SessionTerminalTabDescriptor,
} from '../presentation/describeSessionTerminal';
import { useSessionTerminalDocumentTabs, type SessionTerminalDocumentTab } from '../presentation/useSessionTerminalDocumentTabs';
import { renderSessionTerminalMark, SESSION_TERMINAL_STATUS_TONE } from './sessionTerminalMenus';
import { SessionTerminalLivePill } from './SessionTerminalLivePill';
import { SessionTerminalTrustNotice, type SessionTerminalTrustNoticeContent } from './SessionTerminalTrustNotice';

/** Terminal lab B1: one 38 px strip is the pane's only chrome; its tabs are the workspace tab at 26 px. */
export const SESSION_TERMINAL_STRIP_METRICS = Object.freeze({
    heightPx: 38,
    tabHeightPx: 26,
    paddingStartPx: 8,
    paddingEndPx: 6,
    actionSizePx: 28,
    actionGlyphPx: 15,
    chevronWidthPx: 16,
});
const S = SESSION_TERMINAL_STRIP_METRICS;

export type SessionTerminalStripProps = Readonly<{
    tabs: readonly SessionTerminalTabDescriptor[];
    activeTabId: string | null;
    /** The list view is on: the strip names the active terminal instead of drawing tabs. */
    listShowing: boolean;
    /** The visible tab's focused terminal: its address pill and, when it differs, where it runs. */
    activeTerminal: SessionTerminalDescriptor | null;
    onActivateTab: (tabId: string) => void;
    onCloseTab: (tabId: string) => void;
    /** A tab's menu, from a right click or a long press; the pane owns the menu itself. */
    onTabMenu: (tabId: string, event: unknown) => void;
    onNewShell: () => void;
    newMenuOpen: boolean;
    onNewMenuOpenChange: (open: boolean) => void;
    newMenuItems: readonly DropdownMenuItem[];
    onNewMenuSelect: (itemId: string) => void;
    canSplit: boolean;
    onSplit: () => void;
    paneMenuItems: readonly DropdownMenuItem[];
    onPaneMenuSelect: (itemId: string) => void;
    onHide: () => void;
    onOpenUrl: (url: string) => void;
    /** The pane's one quiet trust line (a shared Machine's terminal runs as its operating-system user). */
    notice?: SessionTerminalTrustNoticeContent;
    testIdPrefix?: string;
}>;

export const SessionTerminalStrip = React.memo(function SessionTerminalStrip(props: SessionTerminalStripProps) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const [paneMenuOpen, setPaneMenuOpen] = React.useState(false);
    const testId = (suffix: string) => `${props.testIdPrefix ?? 'terminal-strip'}-${suffix}`;

    const items = useSessionTerminalDocumentTabs(props.tabs);
    const resolvePresentation = React.useCallback((tab: SessionTerminalDocumentTab): DocumentTabPresentation | null => (
        tab.status ? { status: { tone: SESSION_TERMINAL_STATUS_TONE[tab.status], label: describeSessionTerminalStatus(tab.status) } } : null
    ), []);
    const renderLeadingIcon = React.useCallback((tab: SessionTerminalDocumentTab, emphasized: boolean) => renderSessionTerminalMark(
        tab.mark, M.tabGlyphPx - 1, emphasized ? theme.colors.text.primary : theme.colors.text.secondary,
    ), [theme.colors.text.primary, theme.colors.text.secondary]);

    const glyphColor = theme.colors.text.secondary;
    const active = props.activeTerminal;
    // The list is an overview: retain a running service's address while another shell is focused.
    const url = active?.url ?? (props.listShowing ? props.tabs.flatMap((tab) => tab.members).find((member) => member.status === 'running' && member.url)?.url : null);
    // The strip names a place only when it differs from the session's own folder and machine (lab B1/A1).
    const meta = !props.listShowing && active?.place ? active.place : null;

    return (
        <View testID={testId('root')} style={styles.strip}>
            {props.listShowing ? (
                <View style={styles.current} accessibilityLiveRegion="polite">
                    {active ? renderSessionTerminalMark(active.mark, M.tabGlyphPx - 1, glyphColor) : null}
                    {active ? <Text style={styles.currentTitle} numberOfLines={1}>{active.title}</Text> : null}
                    {active?.detail ? <Text style={styles.currentDetail} numberOfLines={1}>{active.detail}</Text> : null}
                </View>
            ) : (
                <View style={styles.tabs}>
                    <DocumentTabStrip
                        variant="bar"
                        barTabHeightPx={S.tabHeightPx}
                        tabs={items}
                        activeTabKey={props.activeTabId}
                        accessibilityLabel={t('terminalWorkspace.stripA11y')}
                        onActivate={props.onActivateTab}
                        onPin={() => {}}
                        onUnpin={() => {}}
                        onClose={props.onCloseTab}
                        onTabMenu={props.onTabMenu}
                        resolveTabPresentation={resolvePresentation}
                        renderLeadingIcon={renderLeadingIcon}
                        tabNativeId={(key) => `terminal-tab-${toTestIdSafeValue(key)}`}
                        panelNativeId={(key) => `terminal-panel-${toTestIdSafeValue(key)}`}
                        testIds={{
                            tab: (key) => testId(`tab-${key}`),
                            tabClose: (key) => testId(`tab-close-${key}`),
                            tabStatus: (key) => testId(`tab-status-${key}`),
                        }}
                    />
                </View>
            )}
            <View style={styles.grow} />
            {props.notice ? <SessionTerminalTrustNotice notice={props.notice} testID={testId('notice')} /> : null}
            {url ? <SessionTerminalLivePill url={url} onOpen={props.onOpenUrl} testID={testId('live-pill')} /> : null}
            {meta ? <Text style={styles.meta} numberOfLines={1}>{meta}</Text> : null}
            <View style={[styles.splitButton, props.newMenuOpen ? styles.splitButtonOpen : null]}>
                <IconButton
                    testID={testId('new')}
                    variant="plain"
                    size={S.actionSizePx}
                    iconSize={S.actionGlyphPx}
                    iconName="plus"
                    accessibilityLabel={t('terminalWorkspace.actions.newShell')}
                    tooltip={t('terminalWorkspace.actions.newShell')}
                    tooltipPlacement="top"
                    onPress={props.onNewShell}
                />
                <DropdownMenu
                    open={props.newMenuOpen}
                    onOpenChange={props.onNewMenuOpenChange}
                    items={props.newMenuItems}
                    onSelect={(itemId) => { props.onNewMenuOpenChange(false); props.onNewMenuSelect(itemId); }}
                    search={false}
                    showCategoryTitles
                    matchTriggerWidth={false}
                    maxWidthCap={320}
                    maxHeightCap={560}
                    placement="top"
                    popoverAnchorAlign="end"
                    allowEmptySelection
                    trigger={({ toggle }) => (
                        <Pressable
                            testID={testId('new-options')}
                            accessibilityRole="button"
                            accessibilityLabel={t('terminalWorkspace.actions.newOptions')}
                            aria-haspopup="menu"
                            aria-expanded={props.newMenuOpen}
                            onPress={toggle}
                            style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [
                                styles.chevron, (hovered || pressed) ? styles.chevronHover : null,
                            ]}
                        >
                            <Icon name="caret-down" size={11} color={glyphColor} />
                        </Pressable>
                    )}
                />
            </View>
            <IconButton
                testID={testId('split')}
                variant="plain"
                size={S.actionSizePx}
                iconSize={S.actionGlyphPx}
                iconName="square-split-horizontal"
                accessibilityLabel={t('terminalWorkspace.actions.split')}
                tooltip={t('terminalWorkspace.actions.split')}
                tooltipPlacement="top"
                disabled={!props.canSplit}
                onPress={props.onSplit}
            />
            <DropdownMenu
                open={paneMenuOpen}
                onOpenChange={setPaneMenuOpen}
                items={props.paneMenuItems}
                onSelect={(itemId) => { setPaneMenuOpen(false); props.onPaneMenuSelect(itemId); }}
                search={false}
                matchTriggerWidth={false}
                maxWidthCap={280}
                maxHeightCap={560}
                placement="top"
                popoverAnchorAlign="end"
                allowEmptySelection
                trigger={({ toggle }) => (
                    <IconButton
                        testID={testId('more')}
                        variant="plain"
                        size={S.actionSizePx}
                        iconSize={S.actionGlyphPx}
                        iconName="dots-three"
                        accessibilityLabel={t('terminalWorkspace.actions.more')}
                        tooltip={t('terminalWorkspace.actions.more')}
                        tooltipPlacement="top"
                        hasPopup="menu"
                        expanded={paneMenuOpen}
                        onPress={toggle}
                    />
                )}
            />
            <View style={styles.separator} />
            <IconButton
                testID={testId('hide')}
                variant="plain"
                size={S.actionSizePx}
                iconSize={S.actionGlyphPx}
                iconName="caret-down"
                accessibilityLabel={t('terminalWorkspace.actions.hide')}
                tooltip={t('terminalWorkspace.actions.hide')}
                tooltipPlacement="top"
                onPress={props.onHide}
            />
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    strip: {
        height: S.heightPx,
        flexShrink: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
        paddingLeft: S.paddingStartPx,
        paddingRight: S.paddingEndPx,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    tabs: {
        flexShrink: 1,
        minWidth: 0,
        flexDirection: 'row',
    },
    current: {
        flexShrink: 1,
        minWidth: 0,
        height: S.tabHeightPx,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        paddingHorizontal: 6,
    },
    currentTitle: {
        ...M.tabLabel,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
        flexShrink: 0,
    },
    currentDetail: {
        ...M.tabSubtitle,
        color: theme.colors.text.tertiary,
        ...Typography.mono(),
        flexShrink: 1,
    },
    grow: {
        flex: 1,
        minWidth: 8,
    },
    meta: {
        ...M.tabSubtitle,
        color: theme.colors.text.tertiary,
        ...Typography.default(),
        marginRight: 6,
        flexShrink: 1,
        fontVariant: ['tabular-nums'],
    },
    splitButton: {
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: 7,
    },
    splitButtonOpen: {
        backgroundColor: theme.colors.surface.selected,
    },
    chevron: {
        width: S.chevronWidthPx,
        height: S.actionSizePx,
        alignItems: 'center',
        justifyContent: 'center',
        borderTopRightRadius: 7,
        borderBottomRightRadius: 7,
        ...(Platform.OS === 'web' ? { cursor: 'pointer' as const } : null),
    },
    chevronHover: {
        backgroundColor: theme.colors.surface.selected,
    },
    separator: {
        width: StyleSheet.hairlineWidth,
        height: 16,
        marginHorizontal: 4,
        backgroundColor: theme.colors.border.default,
    },
}));
