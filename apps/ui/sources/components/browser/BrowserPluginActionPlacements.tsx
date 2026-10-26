import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/forms/dropdown/ContextMenu';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { resolvePluginUiIconName } from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import type { PluginBrowserActionProjection } from '@/sync/domains/plugins/browser/actions';
import {
    resolvePluginBrowserPolicyDecision,
} from '@/sync/domains/plugins/browser/policy';
import type { PluginUiPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy';
import {
    resolvePluginLocalizedText,
    usePluginLocalizedTextResolver,
    type PluginLocalizedTextResolver,
} from '@/sync/domains/plugins/ui/i18n';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

const stylesheet = StyleSheet.create((theme) => ({
    detailsPanel: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: theme.space.s8,
        paddingHorizontal: theme.space.s10,
        paddingVertical: theme.space.s8,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    contextTriggerSlot: {
        position: 'absolute',
        right: 12,
        bottom: 44,
        zIndex: 5,
    },
}));

function decisionFor(
    action: PluginBrowserActionProjection,
    policyContext: PluginUiPolicyEvaluationContext,
    localize?: PluginLocalizedTextResolver,
) {
    return resolvePluginBrowserPolicyDecision(action, policyContext, localize);
}

function actionTitle(
    action: PluginBrowserActionProjection,
    localize?: PluginLocalizedTextResolver,
): string {
    return localize?.(action.pluginId, action.display.title) ?? resolvePluginLocalizedText({
        projection: null,
        pluginId: action.pluginId,
        value: action.display.title,
    });
}

export function BrowserPluginActionPlacements(props: Readonly<{
    detailsPanelActions: readonly PluginBrowserActionProjection[];
    contextMenuActions: readonly PluginBrowserActionProjection[];
    policyContext: PluginUiPolicyEvaluationContext;
    localizePluginText?: PluginLocalizedTextResolver;
    pluginUiProjection?: PluginUiProjectionModel | null;
    onAction: (action: PluginBrowserActionProjection) => void;
    testID: string;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const contextAnchorRef = React.useRef<View>(null);
    const [contextMenuOpen, setContextMenuOpen] = React.useState(false);
    const localized = usePluginLocalizedTextResolver({ projection: props.pluginUiProjection });
    const localize = props.localizePluginText ?? localized;
    const contextMenuItems = React.useMemo<readonly ContextMenuItem[]>(
        () => !contextMenuOpen ? [] : props.contextMenuActions.map((action) => {
            const title = actionTitle(action, localize);
            const decision = decisionFor(action, props.policyContext, localize);
            return {
                id: action.id,
                testID: `${props.testID}-contextMenu-${action.id}`,
                title,
                subtitle: decision.enabled ? undefined : decision.unavailableReason ?? undefined,
                accessibilityLabel: title,
                icon: (
                    <Icon
                        name={resolvePluginUiIconName(action.display.iconToken)}
                        size={16}
                        color={theme.colors.text.secondary}
                    />
                ),
                disabled: !decision.enabled,
            };
        }),
        [contextMenuOpen, props.contextMenuActions, localize, props.policyContext, props.testID, theme.colors.text.secondary],
    );

    if (props.detailsPanelActions.length === 0 && props.contextMenuActions.length === 0) {
        return null;
    }

    return (
        <>
            {props.detailsPanelActions.length > 0 ? (
                <View testID={`${props.testID}-detailsPanel`} style={stylesheet.detailsPanel}>
                    {props.detailsPanelActions.map((action) => {
                        const title = actionTitle(action, localize);
                        const decision = decisionFor(action, props.policyContext, localize);
                        return (
                            <RoundButton
                                key={action.id}
                                testID={`${props.testID}-detailsPanel-${action.id}`}
                                size="small"
                                display="secondary"
                                title={title}
                                accessibilityLabel={title}
                                accessibilityHint={!decision.enabled && decision.unavailableReason
                                    ? decision.unavailableReason
                                    : undefined}
                                disabled={!decision.enabled}
                                onPress={() => props.onAction(action)}
                                leading={(
                                    <Icon
                                        name={resolvePluginUiIconName(action.display.iconToken)}
                                        size={ICON_SIZE.xs}
                                        color={theme.colors.text.secondary}
                                    />
                                )}
                            />
                        );
                    })}
                </View>
            ) : null}
            {props.contextMenuActions.length > 0 ? (
                <View style={stylesheet.contextTriggerSlot}>
                    <View ref={contextAnchorRef} collapsable={false}>
                        <IconButton
                            testID={`${props.testID}-contextMenu-trigger`}
                            iconName="dots-three"
                            variant="outlined"
                            accessibilityLabel={t('browserShell.overflow.open')}
                            tooltip={t('browserShell.overflow.open')}
                            tooltipHidden={contextMenuOpen}
                            expanded={contextMenuOpen}
                            hasPopup="menu"
                            onPress={() => setContextMenuOpen((open) => !open)}
                        />
                    </View>
                    <ContextMenu
                        anchorRef={contextAnchorRef}
                        open={contextMenuOpen}
                        onOpenChange={setContextMenuOpen}
                        items={contextMenuItems}
                        onSelect={(actionId) => {
                            const action = props.contextMenuActions.find((candidate) => candidate.id === actionId);
                            if (action && decisionFor(action, props.policyContext, localize).enabled) {
                                props.onAction(action);
                            }
                        }}
                        closeOnSelect={true}
                        placement="auto"
                        variant="slim"
                        showCategoryTitles={false}
                        maxWidthCap={320}
                    />
                </View>
            ) : null}
        </>
    );
}
