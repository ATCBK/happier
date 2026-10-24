import React from 'react';
import { View, Platform, useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';

import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { ProfileCompatibilityIcon } from '@/components/sessions/new/components/ProfileCompatibilityIcon';
import { ProfileRequirementsBadge } from '@/components/profiles/ProfileRequirementsBadge';
import { ignoreNextRowPress } from '@/utils/ui/ignoreNextRowPress';
import { toggleFavoriteProfileId } from '@/sync/domains/profiles/profileGrouping';
import { buildProfileActions } from '@/components/profiles/profileActions';
import { getProfileSubtitle } from '@/components/profiles/profileListModel';
import { useProfilesListModel } from '@/components/profiles/useProfilesListModel';
import { getProfileDisplayName } from '@/components/profiles/profileDisplay';
import { t } from '@/text';
import { Modal } from '@/modal';
import { Typography } from '@/constants/Typography';
import { hasRequiredSecret } from '@/sync/domains/profiles/profileSecrets';
import type { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { Text } from '@/components/ui/text/Text';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import type { ProfileEnabledById } from '@/sync/domains/profiles/profileEnablement';
import { Icon } from '@/components/ui/icons/Icon';
import { CollectionStatusGlyph, type CollectionRowStatus } from '@/components/ui/lists/collection/CollectionStatusGlyph';


export interface ProfilesListProps {
    customProfiles: AIBackendProfile[];
    favoriteProfileIds: string[];
    onFavoriteProfileIdsChange: (next: string[]) => void | Promise<void>;

    selectedProfileId: string | null;
    onPressProfile?: (profile: AIBackendProfile) => void | Promise<void>;
    onPressDefaultEnvironment?: () => void;

    machineId: string | null;
    /** Optional server context for an exact machine-scoped preview. */
    serverId?: string | null;
    /** Optional content rendered before profile groups inside the canonical list scroll surface. */
    header?: React.ReactNode;

    includeDefaultEnvironmentRow?: boolean;
    includeAddProfileRow?: boolean;
    onAddProfilePress?: () => void;

    getProfileDisabled?: (profile: AIBackendProfile) => boolean;
    getProfileSubtitleExtra?: (profile: AIBackendProfile) => string | null;
    /** A page row's status (a pending migration, turned off): the shared glyph at the row's end, its word in the tooltip. */
    getProfileStatus?: (profile: AIBackendProfile) => Readonly<{ status: CollectionRowStatus; label: string }> | null;
    profileEnabledById?: ProfileEnabledById | null;
    includeDisabledProfiles?: boolean;

    onEditProfile?: (profile: AIBackendProfile) => void;
    onDuplicateProfile?: (profile: AIBackendProfile) => void;
    onDeleteProfile?: (profile: AIBackendProfile) => void;
    getHasEnvironmentVariables?: (profile: AIBackendProfile) => boolean;
    onViewEnvironmentVariables?: (profile: AIBackendProfile) => void;
    extraActions?: (profile: AIBackendProfile) => ItemAction[];

    onSecretBadgePress?: (profile: AIBackendProfile) => void;

    groupTitles?: {
        favorites?: string;
        custom?: string;
        builtIn?: string;
    };
    /**
     * `page` renders the list as a configuration page (Settings › Profiles): sections carry
     * descriptions and adding a profile is the last row of your own profiles, which always shows.
     * Pickers keep the default grouped look. `embedded` is a picker that is itself one section of a page
     * (the New Session wizard's Profile section): one sheet of flat rows under `section`'s heading, with
     * no list chrome and no sub-headings, on the page's own edge.
     */
    presentation?: 'page' | 'grouped' | 'embedded';
    /** Embedded presentation: the page section this list is (its heading and purpose line). */
    section?: { title: string; description?: string };
    /** Page presentation: what each section holds, above its rows. */
    groupDescriptions?: {
        favorites?: string;
        custom?: string;
        builtIn?: string;
    };
    /**
     * Optional explicit boundary ref for row action popovers. Useful when this list is rendered
     * inside a scroll viewport (e.g. NewSessionWizard) and the popover should be clamped to the
     * visible portion of that scroll container.
     */
    popoverBoundaryRef?: React.RefObject<any> | null;
    /**
     * When provided, allows callers to mark API key requirements as satisfied via a saved/session key,
     * not only machine environment.
     */
    getSecretOverrideReady?: (profile: AIBackendProfile) => boolean;
    /**
     * When provided, supplies machine-env preflight readiness/loading for the profile's required secret env var.
     * This allows callers to batch/cache daemon env checks instead of doing one request per row.
     */
    getSecretMachineEnvOverride?: (profile: AIBackendProfile) => { isReady: boolean; isLoading: boolean } | null;
}

type ProfileRowProps = {
    testID: string;
    profile: AIBackendProfile;
    backendEntries: ReturnType<typeof getResolvedBackendCatalogEntries>;
    displayName: string;
    isSelected: boolean;
    isFavorite: boolean;
    isDisabled: boolean;
    showDivider: boolean;
    isMobile: boolean;
    machineId: string | null;
    serverId?: string | null;
    subtitleText: string;
    showMobileBadge: boolean;
    onPressProfile?: (profile: AIBackendProfile) => void | Promise<void>;
    onSecretBadgePress?: (profile: AIBackendProfile) => void;
    rightElement: React.ReactNode;
    /** A page row opens its profile; a picker row chooses it. */
    showChevron: boolean;
    ignoreRowPressRef: React.MutableRefObject<boolean>;
    getSecretOverrideReady?: (profile: AIBackendProfile) => boolean;
    getSecretMachineEnvOverride?: (profile: AIBackendProfile) => { isReady: boolean; isLoading: boolean } | null;
};

/**
 * An embedded list marks its chosen profile with the check, as the page's other choices do (permissions,
 * machines, folders): the sheet shows no row fill, which a section of more than one selectable row would draw.
 */
const EMBEDDED_SELECTABLE_COUNT = 1;

/** The size every leading mark in this list takes: a profile's compatibility mark (its default size). */
const PROFILE_ROW_MARK_PX = 32;

/**
 * A glyph in the list's mark column (the no-profile house, the add row's plus): centered in the box a
 * profile's mark takes, so every title in a section starts on the same edge whatever its mark.
 */
function ProfileRowGlyph(props: Readonly<{ name: React.ComponentProps<typeof Icon>['name']; size: number; color: string }>) {
    return (
        <View style={{ width: PROFILE_ROW_MARK_PX, height: PROFILE_ROW_MARK_PX, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={props.name} size={props.size} color={props.color} />
        </View>
    );
}

const ProfileRow = React.memo(function ProfileRow(props: ProfileRowProps) {
    const theme = useUnistyles().theme;

    const subtitle = React.useMemo(() => {
        if (!props.showMobileBadge) return props.subtitleText;
        return (
            <View style={{ gap: theme.space.s6 }}>
                <Text
                    style={{
                        ...Typography.default('regular'),
                        color: theme.colors.text.secondary,
                        fontSize: Platform.select({ ios: 15, default: 14 }),
                        lineHeight: 20,
                        letterSpacing: Platform.select({ ios: -0.24, default: 0.1 }),
                    }}
                >
                    {props.subtitleText}
                </Text>
                <View style={{ alignSelf: 'flex-start' }}>
                    <ProfileRequirementsBadge
                        profile={props.profile}
                        machineId={props.machineId}
                        serverId={props.serverId}
                        overrideReady={props.getSecretOverrideReady?.(props.profile) ?? false}
                        machineEnvOverride={props.getSecretMachineEnvOverride?.(props.profile) ?? null}
                        onPressIn={() => ignoreNextRowPress(props.ignoreRowPressRef)}
                        onPress={() => {
                            props.onSecretBadgePress?.(props.profile);
                        }}
                    />
                </View>
            </View>
        );
    }, [props.ignoreRowPressRef, props.machineId, props.onSecretBadgePress, props.profile, props.serverId, props.showMobileBadge, props.subtitleText, theme.colors.text.secondary]);

    const onPress = React.useCallback(() => {
        if (props.isDisabled) return;
        if (props.ignoreRowPressRef.current) {
            props.ignoreRowPressRef.current = false;
            return;
        }
        void props.onPressProfile?.(props.profile);
    }, [props.ignoreRowPressRef, props.isDisabled, props.onPressProfile, props.profile]);

    return (
        <Item
            testID={props.testID}
            key={props.profile.id}
            title={props.displayName}
            subtitle={subtitle}
            leftElement={<ProfileCompatibilityIcon profile={props.profile} backendEntries={props.backendEntries} size={PROFILE_ROW_MARK_PX} />}
            showChevron={props.showChevron}
            selected={props.isSelected}
            disabled={props.isDisabled}
            onPress={onPress}
            rightElement={props.rightElement}
            showDivider={props.showDivider}
        />
    );
});

export function ProfilesList(props: ProfilesListProps) {
    const { theme, rt } = useUnistyles();
    const {
        groups,
        enabledAgentIds,
        resolvedBackendEntries,
        strings,
    } = useProfilesListModel({
        customProfiles: props.customProfiles,
        favoriteProfileIds: props.favoriteProfileIds,
        profileEnabledById: props.profileEnabledById,
        includeDisabledProfiles: props.includeDisabledProfiles,
        machineId: props.machineId,
        serverId: props.serverId,
    });
    const {
        extraActions,
        getHasEnvironmentVariables,
        onDeleteProfile,
        onDuplicateProfile,
        onEditProfile,
        onViewEnvironmentVariables,
    } = props;

    const ignoreRowPressRef = React.useRef(false);
    const selectedIndicatorColor = rt.themeName === 'dark' ? theme.colors.text.primary : theme.colors.button.primary.background;
    const isMobile = useWindowDimensions().width < 580;

    const isDefaultEnvironmentFavorite = groups.favoriteIds.has('');
    // A picker selects one choice; a page lists them, so it draws no selection.
    const isPage = props.presentation === 'page';
    const embedded = props.presentation === 'embedded';
    const showsSelection = !isPage;
    const defaultEnvironmentSelected = showsSelection && !props.selectedProfileId;
    // On a page, adding happens in the collection it adds to: the last row of your own profiles.
    const addsInCustomGroup = props.presentation === 'page' && Boolean(props.includeAddProfileRow && props.onAddProfilePress);
    const showFavoritesGroup = groups.favoriteProfiles.length > 0 || (props.includeDefaultEnvironmentRow && isDefaultEnvironmentFavorite);

    const toggleFavorite = React.useCallback((profileId: string) => {
        void Promise.resolve().then(() => props.onFavoriteProfileIdsChange(toggleFavoriteProfileId(props.favoriteProfileIds, profileId)))
            .catch(error => Modal.alert(t('common.error'), error instanceof Error ? error.message : t('common.error')));
    }, [props.favoriteProfileIds, props.onFavoriteProfileIdsChange]);

    // Precompute action arrays so selection changes don't rebuild them for every row.
    const actionsByProfileId = React.useMemo(() => {
        const map = new Map<string, { actions: ItemAction[]; compactActionIds: string[] }>();

        const build = (profile: AIBackendProfile) => {
            const isFavorite = groups.favoriteIds.has(profile.id);
            const hasEnvVars = getHasEnvironmentVariables ? getHasEnvironmentVariables(profile) : false;
            const canViewEnvVars = hasEnvVars && Boolean(onViewEnvironmentVariables);
            const actions: ItemAction[] = [
                ...(extraActions ? extraActions(profile) : []),
                ...buildProfileActions({
                    profile,
                    isFavorite,
                    favoriteActionColor: selectedIndicatorColor,
                    nonFavoriteActionColor: theme.colors.text.secondary,
                    onToggleFavorite: () => toggleFavorite(profile.id),
                    onEdit: () => onEditProfile?.(profile),
                    onDuplicate: () => onDuplicateProfile?.(profile),
                    onDelete: onDeleteProfile ? () => onDeleteProfile?.(profile) : undefined,
                    onViewEnvironmentVariables: canViewEnvVars ? () => onViewEnvironmentVariables?.(profile) : undefined,
                }),
            ];
            const compactActionIds = ['favorite', ...(canViewEnvVars ? ['envVars'] : [])];
            map.set(profile.id, { actions, compactActionIds });
        };

        for (const p of groups.favoriteProfiles) build(p);
        for (const p of groups.customProfiles) build(p);
        for (const p of groups.sharedProfiles) build(p);
        for (const p of groups.builtInProfiles) build(p);

        return map;
    }, [
        groups.builtInProfiles,
        groups.customProfiles,
        groups.sharedProfiles,
        groups.favoriteIds,
        groups.favoriteProfiles,
        extraActions,
        getHasEnvironmentVariables,
        onDeleteProfile,
        onDuplicateProfile,
        onEditProfile,
        onViewEnvironmentVariables,
        selectedIndicatorColor,
        theme.colors.text.secondary,
        toggleFavorite,
    ]);

    // A page row is a destination: favorite, duplicate and delete live on the profile's own page.
    const renderDefaultEnvironmentRightElement = React.useCallback((isSelected: boolean) => {
        if (isPage) return null;
        const isFavorite = isDefaultEnvironmentFavorite;
        const actions: ItemAction[] = [
            {
                id: 'favorite',
                title: isFavorite ? t('profiles.actions.removeFromFavorites') : t('profiles.actions.addToFavorites'),
                icon: 'star',
                onPress: () => toggleFavorite(''),
                color: isFavorite ? selectedIndicatorColor : theme.colors.text.secondary,
            },
        ];

        return (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s16 }}>
                <View style={{ width: 24, alignItems: 'center', justifyContent: 'center' }}>
                    {normalizeNodeForView(
                        <Icon name="check-circle" size={24} color={selectedIndicatorColor} style={{ opacity: isSelected ? 1 : 0 }} />,
                    )}
                </View>
                <ItemRowActions
                    title={t('profiles.noProfile')}
                    actions={actions}
                    compactActionIds={['favorite']}
                    pinnedActionIds={['favorite']}
                    overflowPosition="beforePinned"
                    iconSize={20}
                    onActionPressIn={() => ignoreNextRowPress(ignoreRowPressRef)}
                    popoverBoundaryRef={props.popoverBoundaryRef}
                />
            </View>
        );
    }, [isDefaultEnvironmentFavorite, isPage, selectedIndicatorColor, theme.colors.text.secondary, toggleFavorite]);

    const getProfileStatus = props.getProfileStatus;
    const renderProfileRightElement = React.useCallback((profile: AIBackendProfile, displayName: string, isSelected: boolean, isFavorite: boolean) => {
        if (isPage) {
            const state = getProfileStatus?.(profile);
            return state ? <CollectionStatusGlyph status={state.status} label={state.label} /> : null;
        }
        const entry = actionsByProfileId.get(profile.id);
        const actions = entry?.actions ?? [];
        const compactActionIds = entry?.compactActionIds ?? ['favorite'];

        return (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s16 }}>
                {!isMobile && (
                    <ProfileRequirementsBadge
                        profile={profile}
                        machineId={props.machineId}
                        serverId={props.serverId}
                        overrideReady={props.getSecretOverrideReady?.(profile) ?? false}
                        machineEnvOverride={props.getSecretMachineEnvOverride?.(profile) ?? null}
                        onPressIn={() => ignoreNextRowPress(ignoreRowPressRef)}
                        onPress={props.onSecretBadgePress ? () => {
                            props.onSecretBadgePress?.(profile);
                        } : undefined}
                    />
                )}
                <View style={{ width: 24, alignItems: 'center', justifyContent: 'center' }}>
                    {normalizeNodeForView(
                        <Icon name="check-circle" size={24} color={selectedIndicatorColor} style={{ opacity: isSelected ? 1 : 0 }} />,
                    )}
                </View>
                <ItemRowActions
                    title={displayName}
                    actions={actions}
                    compactActionIds={compactActionIds}
                    pinnedActionIds={['favorite']}
                    overflowPosition="beforePinned"
                    iconSize={20}
                    onActionPressIn={() => ignoreNextRowPress(ignoreRowPressRef)}
                    popoverBoundaryRef={props.popoverBoundaryRef}
                />
            </View>
        );
    }, [
        actionsByProfileId,
        getProfileStatus,
        isMobile,
        isPage,
        props,
        selectedIndicatorColor,
    ]);

    /** A saved profile row: your own, or one shared with you (same anatomy, same actions). */
    const renderSavedProfileRow = (profile: AIBackendProfile, isLast: boolean) => {
        const displayName = getProfileDisplayName(profile);
        const isFavorite = groups.favoriteIds.has(profile.id);
        const isSelected = showsSelection && props.selectedProfileId === profile.id;
        const isDisabled = props.getProfileDisabled ? props.getProfileDisabled(profile) : false;
        const baseSubtitle = getProfileSubtitle({
            profile,
            enabledAgentIds,
            backendEntries: resolvedBackendEntries,
            strings,
        });
        const extra = props.getProfileSubtitleExtra?.(profile);
        const subtitleText = extra ? `${baseSubtitle} · ${extra}` : baseSubtitle;
        const showMobileBadge = isMobile && hasRequiredSecret(profile) && Boolean(props.onSecretBadgePress);
        return (
            <ProfileRow
                key={profile.id}
                testID={`profiles-list-row:${profile.id}`}
                profile={profile}
                backendEntries={resolvedBackendEntries}
                displayName={displayName}
                isSelected={isSelected}
                isFavorite={isFavorite}
                isDisabled={isDisabled}
                showDivider={embedded || !isLast}
                isMobile={isMobile}
                machineId={props.machineId}
                serverId={props.serverId}
                subtitleText={subtitleText}
                showMobileBadge={showMobileBadge}
                onPressProfile={props.onPressProfile}
                onSecretBadgePress={props.onSecretBadgePress}
                showChevron={isPage}
                rightElement={renderProfileRightElement(profile, displayName, isSelected, isFavorite)}
                ignoreRowPressRef={ignoreRowPressRef}
                getSecretOverrideReady={props.getSecretOverrideReady}
                getSecretMachineEnvOverride={props.getSecretMachineEnvOverride}
            />
        );
    };

    // Embedded in a page section, the groups' rows run flat in one sheet: no sub-headings, one
    // edge, and the hairlines fall between every pair of rows (the sheet drops the last).
    const group = (key: string, groupProps: Omit<React.ComponentProps<typeof ItemGroup>, 'children'>, rows: React.ReactNode) => (embedded
        ? <React.Fragment key={key}>{rows}</React.Fragment>
        : <ItemGroup key={key} {...groupProps}>{rows}</ItemGroup>);

    const content = (
        <>
            {props.header}
            {showFavoritesGroup && group('favorites', {
                title: props.groupTitles?.favorites ?? t('profiles.groups.favorites'),
                description: props.groupDescriptions?.favorites,
                selectableItemCountOverride: Math.max(
                    1,
                    (props.includeDefaultEnvironmentRow && isDefaultEnvironmentFavorite ? 1 : 0) + groups.favoriteProfiles.length,
                ),
            }, (
                <>
                    {props.includeDefaultEnvironmentRow && isDefaultEnvironmentFavorite && (
                        <Item
                            testID="profiles-list-row:default-environment"
                            title={t('profiles.noProfile')}
                            subtitle={t('profiles.noProfileDescription')}
                            leftElement={<ProfileRowGlyph name="house" size={24} color={theme.colors.text.secondary} />}
                            showChevron={isPage}
                            selected={defaultEnvironmentSelected}
                            onPress={() => {
                                if (ignoreRowPressRef.current) {
                                    ignoreRowPressRef.current = false;
                                    return;
                                }
                                props.onPressDefaultEnvironment?.();
                            }}
                            rightElement={renderDefaultEnvironmentRightElement(defaultEnvironmentSelected)}
                            showDivider={embedded || groups.favoriteProfiles.length > 0}
                        />
                    )}
                    {groups.favoriteProfiles.map((profile, index) => {
                        const displayName = getProfileDisplayName(profile);
                        const isLast = index === groups.favoriteProfiles.length - 1;
                        const isSelected = showsSelection && props.selectedProfileId === profile.id;
                        const isDisabled = props.getProfileDisabled ? props.getProfileDisabled(profile) : false;
                        const baseSubtitle = getProfileSubtitle({
                            profile,
                            enabledAgentIds,
                            backendEntries: resolvedBackendEntries,
                            strings,
                        });
                        const extra = props.getProfileSubtitleExtra?.(profile);
                        const subtitleText = extra ? `${baseSubtitle} · ${extra}` : baseSubtitle;
                        const showMobileBadge = isMobile && hasRequiredSecret(profile) && Boolean(props.onSecretBadgePress);
                        return (
                            <ProfileRow
                                key={profile.id}
                                testID={`profiles-list-row:${profile.id}`}
                                profile={profile}
                                backendEntries={resolvedBackendEntries}
                                displayName={displayName}
                                isSelected={isSelected}
                                isFavorite={true}
                                isDisabled={isDisabled}
                                showDivider={embedded || !isLast}
                                isMobile={isMobile}
                                machineId={props.machineId}
                                serverId={props.serverId}
                                subtitleText={subtitleText}
                                showMobileBadge={showMobileBadge}
                                onPressProfile={props.onPressProfile}
                                onSecretBadgePress={props.onSecretBadgePress}
                                showChevron={isPage}
                rightElement={renderProfileRightElement(profile, displayName, isSelected, true)}
                                ignoreRowPressRef={ignoreRowPressRef}
                                getSecretOverrideReady={props.getSecretOverrideReady}
                                getSecretMachineEnvOverride={props.getSecretMachineEnvOverride}
                            />
                        );
                    })}
                </>
            ))}

            {(groups.customProfiles.length > 0 || addsInCustomGroup) && group('custom', {
                title: props.groupTitles?.custom ?? t('profiles.groups.custom'),
                description: props.groupDescriptions?.custom,
                selectableItemCountOverride: Math.max(2, groups.customProfiles.length + (addsInCustomGroup ? 1 : 0)),
            }, (
                <>
                    {groups.customProfiles.map((profile, index) => renderSavedProfileRow(
                        profile,
                        index === groups.customProfiles.length - 1 && !addsInCustomGroup,
                    ))}
                    {addsInCustomGroup ? (
                        <Item
                            testID="profiles-list-add-profile"
                            title={t('profiles.addProfile')}
                            leftElement={<ProfileRowGlyph name="plus" size={20} color={theme.colors.text.secondary} />}
                            onPress={props.onAddProfilePress}
                            showDivider={embedded}
                        />
                    ) : null}
                </>
            ))}

            {groups.sharedProfiles.length > 0 ? group('shared', {
                title: t('roles.profiles.sharedWithYouTitle'),
                description: props.presentation === 'page' ? t('roles.profiles.sharedWithYouDescription') : undefined,
                selectableItemCountOverride: Math.max(2, groups.sharedProfiles.length),
            }, groups.sharedProfiles.map((profile, index) => renderSavedProfileRow(profile, index === groups.sharedProfiles.length - 1))) : null}

            {group('builtIn', {
                title: props.groupTitles?.builtIn ?? t('profiles.groups.builtIn'),
                description: props.groupDescriptions?.builtIn,
                selectableItemCountOverride: Math.max(
                    1,
                    (props.includeDefaultEnvironmentRow && !isDefaultEnvironmentFavorite ? 1 : 0) + groups.builtInProfiles.length,
                ),
            }, (
                <>
                {props.includeDefaultEnvironmentRow && !isDefaultEnvironmentFavorite && (
                    <Item
                        testID="profiles-list-row:default-environment"
                        title={t('profiles.noProfile')}
                        subtitle={t('profiles.noProfileDescription')}
                        leftElement={<ProfileRowGlyph name="house" size={24} color={theme.colors.text.secondary} />}
                        showChevron={isPage}
                        selected={defaultEnvironmentSelected}
                        onPress={() => {
                            if (ignoreRowPressRef.current) {
                                ignoreRowPressRef.current = false;
                                return;
                            }
                            props.onPressDefaultEnvironment?.();
                        }}
                        rightElement={renderDefaultEnvironmentRightElement(defaultEnvironmentSelected)}
                        showDivider={embedded || groups.builtInProfiles.length > 0}
                    />
                )}
                {groups.builtInProfiles.map((profile, index) => {
                    const displayName = getProfileDisplayName(profile);
                    const isLast = index === groups.builtInProfiles.length - 1;
                    const isFavorite = groups.favoriteIds.has(profile.id);
                    const isSelected = showsSelection && props.selectedProfileId === profile.id;
                    const isDisabled = props.getProfileDisabled ? props.getProfileDisabled(profile) : false;
                    const baseSubtitle = getProfileSubtitle({
                        profile,
                        enabledAgentIds,
                        backendEntries: resolvedBackendEntries,
                        strings,
                    });
                    const extra = props.getProfileSubtitleExtra?.(profile);
                    const subtitleText = extra ? `${baseSubtitle} · ${extra}` : baseSubtitle;
                    const showMobileBadge = isMobile && hasRequiredSecret(profile) && Boolean(props.onSecretBadgePress);
                    return (
                        <ProfileRow
                            key={profile.id}
                            testID={`profiles-list-row:${profile.id}`}
                            profile={profile}
                            backendEntries={resolvedBackendEntries}
                            displayName={displayName}
                            isSelected={isSelected}
                            isFavorite={isFavorite}
                            isDisabled={isDisabled}
                            showDivider={embedded || !isLast}
                            isMobile={isMobile}
                            machineId={props.machineId}
                            serverId={props.serverId}
                            subtitleText={subtitleText}
                            showMobileBadge={showMobileBadge}
                            onPressProfile={props.onPressProfile}
                            onSecretBadgePress={props.onSecretBadgePress}
                            showChevron={isPage}
                rightElement={renderProfileRightElement(profile, displayName, isSelected, isFavorite)}
                            ignoreRowPressRef={ignoreRowPressRef}
                            getSecretOverrideReady={props.getSecretOverrideReady}
                            getSecretMachineEnvOverride={props.getSecretMachineEnvOverride}
                        />
                    );
                })}
                </>
            ))}

            {props.includeAddProfileRow && props.onAddProfilePress && !addsInCustomGroup && group('add', {
                title: '',
                selectableItemCountOverride: 1,
            }, (
                <Item
                    testID="profiles-list-add-profile"
                    title={t('profiles.addProfile')}
                    subtitle={t('profiles.subtitle')}
                    leftElement={<ProfileRowGlyph name="plus-circle" size={24} color={theme.colors.button.secondary.tint} />}
                    onPress={props.onAddProfilePress}
                    showChevron={false}
                    showDivider={false}
                />
            ))}
        </>
    );

    if (embedded) {
        return (
            <ItemGroup title={props.section?.title} description={props.section?.description} selectableItemCountOverride={EMBEDDED_SELECTABLE_COUNT}>
                {content}
            </ItemGroup>
        );
    }
    return (
        <ItemList style={{ paddingTop: 0 }} presentation={props.presentation === 'page' ? 'page' : 'grouped'}>
            {content}
        </ItemList>
    );
}
