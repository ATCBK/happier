import * as React from 'react';
import { View } from 'react-native';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { StyleSheet } from 'react-native-unistyles';
import type {
    BrowserPermissionGrantV1,
    BrowserPermissionStateV1,
    BrowserProfileStorageModeV1,
    BrowserProfileV1,
    BrowserStoragePartitionV1,
    BrowserStoragePersistenceV1,
} from '@happier-dev/protocol';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { BROWSER_CHROME_WIDTH } from '../browserChromeDensity';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: theme.space.s6,
        minHeight: 34,
        minWidth: 0,
        maxWidth: BROWSER_CHROME_WIDTH.panel,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        paddingHorizontal: theme.space.s10,
    },
    segment: {
        minWidth: 0,
    },
    label: {
        color: theme.colors.text.secondary,
    },
    value: {
        color: theme.colors.text.primary,
    },
    actionRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: theme.space.s6,
        minWidth: 0,
    },
    separator: {
        color: theme.colors.text.disabled,
    },
}));

export type BrowserProfileManagementModel = Readonly<{
    availableProfiles?: readonly BrowserProfileV1[];
    permissionGrants?: readonly BrowserPermissionGrantV1[];
    storagePartitions?: readonly BrowserStoragePartitionV1[];
    onCreateProfile?: () => void;
    onSelectProfile?: (profileId: string) => void;
    onRevokePermissionGrant?: (grantId: string) => void;
    onClearStoragePartition?: (partitionId: string) => void;
}>;

export type BrowserProfileStatusModel = Readonly<{
    profile: BrowserProfileV1 | null;
    storagePartition?: BrowserStoragePartitionV1 | null;
    activePermissionGrantCount?: number;
    permissionState?: BrowserPermissionStateV1 | null;
    management?: BrowserProfileManagementModel;
}>;

function modeLabel(mode: BrowserProfileStorageModeV1 | null): string {
    if (!mode) return t('browserShell.profile.unavailable');
    switch (mode) {
        case 'ephemeral':
            return t('browserShell.profile.mode.ephemeral');
        case 'session':
            return t('browserShell.profile.mode.session');
        case 'user':
            return t('browserShell.profile.mode.user');
        case 'plugin':
            return t('browserShell.profile.mode.plugin');
    }
}

function storageLabel(persistence: BrowserStoragePersistenceV1 | null): string {
    if (!persistence) return t('browserShell.profile.storage.unavailable');
    switch (persistence) {
        case 'ephemeral':
            return t('browserShell.profile.storage.ephemeral');
        case 'session':
            return t('browserShell.profile.storage.session');
        case 'persistent':
            return t('browserShell.profile.storage.persistent');
        case 'plugin':
            return t('browserShell.profile.storage.plugin');
    }
}

function permissionLabel(input: Readonly<{
    permissionState?: BrowserPermissionStateV1 | null;
    activePermissionGrantCount?: number;
}>): string {
    if (input.permissionState === 'denied') {
        return t('browserShell.profile.permissions.denied');
    }
    if (input.permissionState === 'prompt') {
        return t('browserShell.profile.permissions.prompt');
    }
    const count = input.activePermissionGrantCount ?? 0;
    if (count > 0) {
        return t('browserShell.profile.permissions.active', { count });
    }
    return t('browserShell.profile.permissions.none');
}

function statusIdForPermission(input: BrowserProfileStatusModel): 'active' | 'denied' | 'none' | 'prompt' {
    if (input.permissionState === 'denied') return 'denied';
    if (input.permissionState === 'prompt') return 'prompt';
    return (input.activePermissionGrantCount ?? 0) > 0 ? 'active' : 'none';
}

function Segment(props: Readonly<{
    label: string;
    value: string;
    testID: string;
}>): React.ReactElement {
    return (
        <View testID={props.testID} style={stylesheet.segment}>
            <Text numberOfLines={1} style={stylesheet.label}>{props.label}</Text>
            <Text numberOfLines={1} style={stylesheet.value}>{props.value}</Text>
        </View>
    );
}

/** A profile operation: the canonical small secondary button (pressed, hover, focus and disabled). */
function ActionButton(props: Readonly<{
    label: string;
    testID: string;
    disabled?: boolean;
    onPress?: () => void;
}>): React.ReactElement {
    return (
        <RoundButton
            size="small"
            display="secondary"
            title={props.label}
            disabled={props.disabled === true || !props.onPress}
            onPress={props.onPress}
            testID={props.testID}
        />
    );
}

function unavailableTestId(testID: string, available: boolean): string {
    return available ? testID : `${testID}-unavailable`;
}

function BrowserProfileManagementActions(props: Readonly<{
    management: BrowserProfileManagementModel;
    testID: string;
}>): React.ReactElement {
    const profiles = props.management.availableProfiles ?? [];
    const permissionGrants = props.management.permissionGrants ?? [];
    const storagePartitions = props.management.storagePartitions ?? [];
    const canCreateProfile = Boolean(props.management.onCreateProfile);
    const canSelectProfile = Boolean(props.management.onSelectProfile);
    const canRevokePermission = Boolean(props.management.onRevokePermissionGrant);
    const canClearStorage = Boolean(props.management.onClearStoragePartition);

    return (
        <View testID={`${props.testID}-management`} style={stylesheet.actionRow}>
            <ActionButton
                testID={unavailableTestId(`${props.testID}-profile-create`, canCreateProfile)}
                label={t('browserShell.profile.management.createProfile')}
                disabled={!canCreateProfile}
                onPress={props.management.onCreateProfile}
            />
            {profiles.map((profile) => (
                <ActionButton
                    key={profile.profileId}
                    testID={unavailableTestId(
                        `${props.testID}-profile-select-${profile.profileId}`,
                        canSelectProfile,
                    )}
                    label={profile.displayName ?? t('browserShell.profile.management.selectProfile')}
                    disabled={!canSelectProfile}
                    onPress={props.management.onSelectProfile
                        ? () => props.management.onSelectProfile?.(profile.profileId)
                        : undefined}
                />
            ))}
            {profiles.length === 0 ? (
                <ActionButton
                    testID={`${props.testID}-profile-select-unavailable`}
                    label={t('browserShell.profile.management.selectProfile')}
                    disabled
                />
            ) : null}
            {permissionGrants.map((grant) => (
                <ActionButton
                    key={grant.id}
                    testID={unavailableTestId(
                        `${props.testID}-permission-revoke-${grant.id}`,
                        canRevokePermission,
                    )}
                    label={t('browserShell.profile.management.revokePermission')}
                    disabled={!canRevokePermission}
                    onPress={props.management.onRevokePermissionGrant
                        ? () => props.management.onRevokePermissionGrant?.(grant.id)
                        : undefined}
                />
            ))}
            {storagePartitions.map((partition) => (
                <ActionButton
                    key={partition.partitionId}
                    testID={unavailableTestId(
                        `${props.testID}-storage-clear-${partition.partitionId}`,
                        canClearStorage,
                    )}
                    label={t('browserShell.profile.management.clearStorage')}
                    disabled={!canClearStorage}
                    onPress={props.management.onClearStoragePartition
                        ? () => props.management.onClearStoragePartition?.(partition.partitionId)
                        : undefined}
                />
            ))}
        </View>
    );
}

export function BrowserProfileStatus(props: Readonly<{
    model: BrowserProfileStatusModel;
    testID?: string;
}>): React.ReactElement {
    const testID = props.testID ?? 'browser-profile-status';
    const mode = props.model.profile?.storageMode ?? null;
    const storage = props.model.storagePartition?.persistence ?? null;
    const permissionStatusId = statusIdForPermission(props.model);

    return (
        <View testID={testID} style={stylesheet.root} accessibilityLabel={t('browserShell.profile.title')}>
            <Segment
                testID={`${testID}-mode-${mode ?? 'unavailable'}`}
                label={t('browserShell.profile.modeLabel')}
                value={modeLabel(mode)}
            />
            <Text style={stylesheet.separator}>/</Text>
            <Segment
                testID={`${testID}-storage-${storage ?? 'unavailable'}`}
                label={t('browserShell.profile.storageLabel')}
                value={storageLabel(storage)}
            />
            <Text style={stylesheet.separator}>/</Text>
            <Segment
                testID={`${testID}-permissions-${permissionStatusId}`}
                label={t('browserShell.profile.permissionsLabel')}
                value={permissionLabel(props.model)}
            />
            {props.model.management ? (
                <BrowserProfileManagementActions
                    testID={testID}
                    management={props.model.management}
                />
            ) : null}
        </View>
    );
}
