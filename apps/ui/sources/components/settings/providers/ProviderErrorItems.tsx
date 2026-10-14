import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { ProviderErrorV1Schema } from '@happier-dev/protocol/providers/errors';
import { useUnistyles } from 'react-native-unistyles';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SurfaceStateCard, type SurfaceStateSize } from '@/components/ui/surfaces/SurfaceStateCard';
import { presentProviderError, presentProviderRecoveryAction } from '@/providers/connection/errorPresentation';
import { dispatchProviderRecoveryAction } from '@/providers/connection/recovery';
import { t } from '@/text';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Tooltip } from '@/components/ui/overlays/Tooltip';
import { Text } from '@/components/ui/text/Text';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';

export const ProviderErrorItems = React.memo(function ProviderErrorItems(props: Readonly<{
    error: unknown;
    /**
     * `'rows'` (default): one shared surface state with its cause and recovery.
     * `'line'`: one compact line inside a picker — the severity
     * glyph (its tooltip and accessible name carry the description), the title, and the recovery
     * action as an icon-only control.
     */
    presentation?: 'rows' | 'line';
    /** Rails use the shared compact state; page errors keep the enclosing surface's size. */
    size?: SurfaceStateSize;
    retry?: () => void | Promise<void>;
    loadModel?: () => void | Promise<void>;
    reviewAndRestart?: () => void | Promise<void>;
    reviewConnection?: () => void | Promise<void>;
    reviewCurrentState?: () => void | Promise<void>;
    configureSecret?: () => void | Promise<void>;
    enableOnMachine?: () => void | Promise<void>;
}>) {
    const router = useRouter();
    const { theme } = useUnistyles();
    const recoveryInFlightRef = React.useRef(false);
    const [recoveryPending, setRecoveryPending] = React.useState(false);
    const presentation = presentProviderError(props.error);
    const typedError = ProviderErrorV1Schema.safeParse(props.error);
    const actionPresentation = presentProviderRecoveryAction(props.error, {
        retry: props.retry !== undefined,
        loadModel: props.loadModel !== undefined,
        reviewAndRestart: props.reviewAndRestart !== undefined,
        reviewConnection: props.reviewConnection !== undefined,
        reviewCurrentState: props.reviewCurrentState !== undefined,
        configureSecret: props.configureSecret !== undefined,
        enableOnMachine: props.enableOnMachine !== undefined,
    });
    const iconName = presentation.severity === 'danger'
        ? 'warning-circle'
        : presentation.severity === 'warning'
            ? 'warning'
            : 'info';
    const iconColor = presentation.severity === 'danger'
        ? theme.colors.state.danger.foreground
        : presentation.severity === 'warning'
            ? theme.colors.state.warning.foreground
            : theme.colors.text.secondary;
    const runRecovery = async () => {
        if (!typedError.success || recoveryInFlightRef.current) return;
        recoveryInFlightRef.current = true;
        setRecoveryPending(true);
        try {
            await dispatchProviderRecoveryAction({
                error: typedError.data,
                router,
                retry: props.retry,
                loadModel: props.loadModel,
                reviewAndRestart: props.reviewAndRestart,
                reviewConnection: props.reviewConnection,
                reviewCurrentState: props.reviewCurrentState,
                configureSecret: props.configureSecret,
                enableOnMachine: props.enableOnMachine,
            });
        } catch {
            // Recovery callbacks own their user-facing failure state.
        } finally {
            recoveryInFlightRef.current = false;
            setRecoveryPending(false);
        }
    };

    if (props.presentation === 'line') {
        const code = typedError.success ? typedError.data.code : 'unknown';
        const actionTitle = actionPresentation && typedError.success ? t(actionPresentation.titleKey) : null;
        return (
            <ProviderPickerLine
                testID={`provider-error:${code}`}
                tooltipTestID={`provider-error-detail:${code}`}
                iconName={iconName}
                iconColor={iconColor}
                tooltip={t(presentation.descriptionKey)}
                title={t(presentation.titleKey)}
                action={actionTitle ? {
                    testID: `provider-error-action:${code}`,
                    label: actionTitle,
                    iconName: actionPresentation?.titleKey === 'settingsProviders.errors.actions.retry' ? 'arrow-clockwise' : 'caret-right',
                    disabled: recoveryPending,
                    onPress: () => void runRecovery(),
                } : undefined}
            />
        );
    }

    const code = typedError.success ? typedError.data.code : 'unknown';
    return <SurfaceStateCard
        testID={`provider-error:${code}`}
        size={props.size}
        kind={presentation.severity === 'danger' ? 'error' : presentation.severity === 'warning' ? 'warning' : 'unavailable'}
        title={t(presentation.titleKey)}
        reason={t(presentation.descriptionKey)}
        diagnosticCode={code}
        accessibilitySemantics="status"
        action={actionPresentation && typedError.success ? {
            testID: `provider-error-action:${code}`,
            label: t(actionPresentation.titleKey),
            busy: recoveryPending,
            disabled: recoveryPending,
            onPress: runRecovery,
        } : undefined}
    />;
});

/**
 * One compact status line inside a picker: a glyph (its tooltip carries the detail), the title, and
 * at most one next step as an icon-only control. Provider errors and a request waiting for its
 * approval share it, so a picker's summary reads as one list of lines.
 */
export function ProviderPickerLine(props: Readonly<{
    testID: string;
    tooltipTestID?: string;
    iconName: IconName;
    iconColor: string;
    tooltip?: string;
    /** What the line is about (a model); it truncates first, so the title always stays readable. */
    subject?: string;
    title: string;
    action?: Readonly<{
        testID: string;
        label: string;
        iconName: IconName;
        disabled?: boolean;
        onPress: () => void;
    }>;
}>) {
    const icon = <Icon name={props.iconName} size={ICON_SIZE.sm} color={props.iconColor} />;
    return (
        <View testID={props.testID} accessibilityLiveRegion="polite" style={lineStyles.line}>
            {props.tooltip ? <Tooltip testID={props.tooltipTestID} label={props.tooltip}>{icon}</Tooltip> : icon}
            {props.subject ? (
                <View style={lineStyles.subjectAndTitle}>
                    <Text testID={`${props.testID}.subject`} numberOfLines={1} style={[lineStyles.title, lineStyles.subject]}>
                        {props.subject}
                    </Text>
                    <Text numberOfLines={1} style={[lineStyles.title, lineStyles.titleAfterSubject]}>{`· ${props.title}`}</Text>
                </View>
            ) : (
                <Text numberOfLines={1} style={lineStyles.title}>{props.title}</Text>
            )}
            {props.action ? (
                <IconButton
                    testID={props.action.testID}
                    iconName={props.action.iconName}
                    accessibilityLabel={props.action.label}
                    tooltip={props.action.label}
                    variant="plain"
                    size={24}
                    iconSize={ICON_SIZE.sm}
                    minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
                    disabled={props.action.disabled}
                    onPress={props.action.onPress}
                />
            ) : null}
        </View>
    );
}

const lineStyles = StyleSheet.create((theme) => ({
    line: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        minHeight: 24,
    },
    title: {
        flex: 1,
        minWidth: 0,
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.secondary,
    },
    subjectAndTitle: { flex: 1, minWidth: 0, flexDirection: 'row', gap: theme.space.s4 },
    /** The subject gives way to the status that follows it. */
    subject: { flexGrow: 0, flexShrink: 1, flexBasis: 'auto' },
    titleAfterSubject: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto' },
}));
