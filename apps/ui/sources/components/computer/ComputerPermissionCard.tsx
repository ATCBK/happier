import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ComputerGrantStatusV1 } from '@happier-dev/protocol';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { resolveComputerRecovery } from '@/sync/domains/computer/targets';

export { needsComputerPermission } from '@/sync/domains/computer/targets';

/** The daemon-side "open the privacy pane" request (W7 `computer.permissions.openSettings`). */
export type ComputerOpenSettingsState = 'idle' | 'opening' | 'opened' | 'failed';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        alignItems: 'center',
        gap: theme.space.s12,
        paddingHorizontal: theme.space.s16,
    },
    liveLine: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        maxWidth: 420,
    },
    grants: {
        alignSelf: 'stretch',
        width: '100%',
        maxWidth: 380,
        marginHorizontal: 'auto',
    },
    grantState: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    grantStateText: {
        ...Typography.variant('meta'),
    },
    liveText: {
        ...Typography.variant('meta'),
        flexShrink: 1,
        color: theme.colors.text.secondary,
        textAlign: 'center',
    },
}));

function ComputerGrantRow(props: Readonly<{ title: string; purpose: string; state: ComputerGrantStatusV1['capture']; testID: string }>) {
    const { theme } = useUnistyles();
    const granted = props.state === 'granted';
    const unknown = props.state === 'unknown';
    const color = granted ? theme.colors.state.success.foreground
        : unknown ? theme.colors.text.secondary : theme.colors.state.warning.foreground;
    return (
        <Item
            testID={props.testID}
            title={props.title}
            subtitle={props.purpose}
            showChevron={false}
            rightElement={(
                <View style={stylesheet.grantState} testID={`${props.testID}-${props.state}`}>
                    <Icon name={granted ? 'check' : unknown ? 'question' : 'warning'} size={ICON_SIZE.xs} color={color} />
                    <Text style={[stylesheet.grantStateText, { color }]}>
                        {granted ? t('computerUse.permission.granted')
                            : unknown ? t('computerUse.permission.unknown') : t('computerUse.permission.denied')}
                    </Text>
                </View>
            )}
        />
    );
}

/**
 * The OS permission the machine needs first (lab `b-mac` P): which one is missing, said as what it
 * unlocks, that it is granted on that machine and not on this device, and **Open privacy settings on
 * {machine}**, which asks that machine's daemon to open the pane there (so it works from a phone
 * too). Happier never changes the permission itself; Check again re-reads the machine. The picker
 * and the viewer's picture draw this one card.
 */
export function ComputerPermissionCard(props: Readonly<{
    machineName: string;
    grants: ComputerGrantStatusV1;
    openSettings: ComputerOpenSettingsState;
    onOpenSettings: (permission: 'capture' | 'input') => void;
    onCheckAgain: () => void;
    testID?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const permission = resolveComputerRecovery({ kind: 'ready', targets: [], grants: props.grants }, 'use')?.permission ?? 'capture';
    const machine = props.machineName;
    const unknown = props.grants[permission] === 'unknown';
    const testID = props.testID ?? 'computer-permission';
    const live = props.openSettings === 'opening' || props.openSettings === 'opened';
    return (
        <View style={stylesheet.root} testID={testID} accessibilityLiveRegion="polite">
            <SurfaceStateCard
                kind="denied"
                iconName="shield"
                title={unknown
                    ? t('computerUse.permission.unknownTitle', { machine })
                    : t(permission === 'capture' ? 'computerUse.permission.captureTitle' : 'computerUse.permission.inputTitle', { machine })}
                reason={t(permission === 'capture' ? 'computerUse.permission.separateBody' : 'computerUse.permission.onMachineBody', { machine })}
                action={{
                    label: t('computerUse.permission.openPrivacy', { machine }),
                    onPress: () => props.onOpenSettings(permission),
                    busy: props.openSettings === 'opening',
                    testID: `${testID}-open-settings`,
                }}
                secondaryAction={{
                    label: t('computerUse.permission.checkAgain'),
                    onPress: props.onCheckAgain,
                    testID: `${testID}-check-again`,
                }}
                // The two permissions with their real state on the machine, so the person sees which
                // one is missing and what each unlocks (lab `computer` OG).
                body={(
                    <View style={stylesheet.grants}>
                        <ItemGroup testID={`${testID}-grants`}>
                            <ComputerGrantRow testID={`${testID}-grant-capture`} title={t('computerUse.permission.capture')}
                                purpose={t('computerUse.permission.captureFor')} state={props.grants.capture} />
                            <ComputerGrantRow testID={`${testID}-grant-input`} title={t('computerUse.permission.input')}
                                purpose={t('computerUse.permission.inputFor')} state={props.grants.input} />
                        </ItemGroup>
                    </View>
                )}
            />
            {live || props.openSettings === 'failed' ? (
                <View style={stylesheet.liveLine}>
                    {live ? <ActivitySpinner size="small" color={theme.colors.text.secondary} /> : null}
                    <Text style={stylesheet.liveText} testID={`${testID}-${live ? 'opened' : 'open-failed'}`}>
                        {live
                            ? t('computerUse.permission.opened', { machine })
                            : t('computerUse.permission.openFailed')}
                    </Text>
                </View>
            ) : null}
        </View>
    );
}
