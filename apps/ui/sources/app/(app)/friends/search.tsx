import { Typography } from '@/constants/Typography';
import React, { useState, useCallback } from 'react';
import type { ScrollView, ScrollViewProps } from 'react-native';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { UserSearchResult } from '@/components/friends/UserSearchResult';
import { searchUsersByUsername } from '@/sync/api/social/apiFriends';
import { readFriendMutationProfile } from '@/sync/ops/friends';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useAuth } from '@/auth/context/AuthContext';
import { UserProfile } from '@/sync/domains/social/friendTypes';
import { Modal } from '@/modal';
import { t } from '@/text';
import { trackFriendsConnect } from '@/track';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { KeyboardAwareScrollView } from '@/components/ui/keyboardAvoidance';
import { useSearch } from '@/hooks/search/useSearch';
import { useRequireFriendsEnabled } from '@/hooks/friends/useRequireFriendsEnabled';
import { HappyError } from '@/utils/errors/errors';
import { RequireFriendsIdentityForFriends } from '@/components/friends/RequireFriendsIdentityForFriends';
import { Text, TextInput } from '@/components/ui/text/Text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { useDestinationPageTitle } from '@/components/appShell/workspace/DestinationInstanceHost';

type KeyboardAwareItemListProps = ScrollViewProps & Readonly<{
    children?: React.ReactNode;
}>;

const FriendsSearchKeyboardAwareItemList = React.forwardRef<ScrollView, KeyboardAwareItemListProps>(
    function FriendsSearchKeyboardAwareItemList({ children, ...props }, ref) {
        return (
            <ItemList ref={ref} {...props}>
                {children}
            </ItemList>
        );
    },
);

export function SearchFriendsScreen() {
    useDestinationPageTitle(t('friends.addFriend'));
    const { theme } = useUnistyles();
    const enabled = useRequireFriendsEnabled();
    const { credentials } = useAuth();
    const { serverId } = useActiveServerSnapshot();
    const { execute } = useMountedActionExecution(serverId);
    const [searchQuery, setSearchQuery] = useState('');
    const [processingUserId, setProcessingUserId] = useState<string | null>(null);
    const [profileOverrides, setProfileOverrides] = useState<Record<string, UserProfile>>({});
    
    if (!enabled) return null;

    // Use the new search hook
    const { results: searchResults, isSearching, error: searchError } = useSearch(
        searchQuery,
        useCallback((query: string) => {
            if (!credentials) {
                return Promise.resolve([]);
            }
            return searchUsersByUsername(credentials, query.trim());
        }, [credentials])
    );
    
    const handleAddFriend = useCallback(async (user: UserProfile) => {
        if (!credentials) return;

        setProcessingUserId(user.id);
        try {
            const updatedProfile = readFriendMutationProfile(
                await execute('friends.add', { uid: user.id }),
            );

            if (updatedProfile) {
                setProfileOverrides((prev) => ({ ...prev, [updatedProfile.id]: updatedProfile }));
                trackFriendsConnect();
                await Modal.alert(t('common.success'), t('friends.requestSent'));
            } else {
                await Modal.alert(t('friends.userNotFound'));
            }
        } catch (error: unknown) {
            if (error instanceof HappyError && error.message === 'provider-required') {
                await Modal.alert(t('friends.bothMustHaveGithub'));
                return;
            }
            if (error instanceof HappyError && error.message === 'username-required') {
                await Modal.alert(t('friends.username.required'));
                return;
            }
            if (error instanceof HappyError && error.message === 'friends-disabled') {
                await Modal.alert(t('friends.disabled'));
                return;
            }
            if (error instanceof Error && error.message.includes('yourself')) {
                await Modal.alert(t('friends.cannotAddYourself'));
            } else {
                await Modal.alert(t('errors.failedToSendRequest'));
            }
        } finally {
            setProcessingUserId(null);
        }
    }, [credentials, execute]);

    const renderUserItem = ({ item }: { item: UserProfile }) => (
        <UserSearchResult
            user={profileOverrides[item.id] ?? item}
            onAddFriend={() => handleAddFriend(item)}
            isProcessing={processingUserId === item.id}
        />
    );

    const renderSeparator = () => (
        <View style={styles.separator} />
    );
    
    const hasSearched = searchQuery.trim().length > 0;
    const searchErrorText =
        searchError === 'searchFailed' ? t('errors.searchFailed') : null;

    return (
        <RequireFriendsIdentityForFriends>
            <KeyboardAwareScrollView
                style={styles.container}
                ScrollViewComponent={FriendsSearchKeyboardAwareItemList}
                keyboardShouldPersistTaps="handled"
            >
                <View style={{ paddingTop: 0 }}>
                    <ItemGroup
                        title={t('friends.searchInstructions')}
                        style={styles.searchSection}
                    >
                        <View style={styles.searchContainer}>
                            <TextInput
                                style={styles.searchInput}
                                placeholder={t('friends.searchPlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                value={searchQuery}
                                onChangeText={setSearchQuery}
                                autoCapitalize="none"
                                autoCorrect={false}
                                returnKeyType="search"
                                editable={!processingUserId}
                            />
                            
                            {isSearching && (
                                <View style={styles.searchingIndicator}>
                                    <ActivitySpinner size="small" color={theme.colors.text.link} />
                                </View>
                            )}
                        </View>
                        {searchErrorText ? (
                            <Text style={styles.errorText}>{searchErrorText}</Text>
                        ) : null}
                    </ItemGroup>

                    <ItemGroup
                        style={styles.resultsGroup}
                    >
                        <View style={styles.resultsSection}>
                            {isSearching && searchResults.length === 0 ? (
                                <View style={styles.loadingContainer}>
                                    <ActivitySpinner size="large" color={theme.colors.text.link} />
                                    <Text style={styles.loadingText}>{t('friends.searching')}</Text>
                                </View>
                            ) : searchResults.length > 0 ? (
                                <View style={styles.resultsList}>
                                    {searchResults.map((item, index) => (
                                        <React.Fragment key={item.id}>
                                            {index > 0 ? renderSeparator() : null}
                                            {renderUserItem({ item })}
                                        </React.Fragment>
                                    ))}
                                </View>
                            ) : hasSearched ? (
                                <View style={styles.noResultsContainer}>
                                    <Text style={styles.noResultsText}>
                                        {t('friends.noUserFound')}
                                    </Text>
                                    <Text style={styles.noResultsHint}>
                                        {t('friends.checkUsername')}
                                    </Text>
                                </View>
                            ) : (
                                <View style={styles.helpContainer}>
                                    <Text style={styles.helpTitle}>
                                        {t('friends.howToFind')}
                                    </Text>
                                    <Text style={styles.helpText}>
                                        {t('friends.findInstructions')}
                                    </Text>
                                </View>
                            )}
                        </View>
                    </ItemGroup>
                </View>
            </KeyboardAwareScrollView>
        </RequireFriendsIdentityForFriends>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background.canvas,
    },
    searchSection: {
        marginBottom: theme.space.s16,
    },
    searchContainer: {
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s8,
        position: 'relative',
    },
    searchInput: {
        backgroundColor: theme.colors.surface.base,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 12,
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s16,
        fontSize: 16,
        color: theme.colors.text.primary,
    },
    searchingIndicator: {
        position: 'absolute',
        right: 32,
        top: 0,
        bottom: 0,
        justifyContent: 'center',
    },
    errorText: {
        paddingHorizontal: theme.space.s16,
        paddingTop: theme.space.s6,
        fontSize: 13,
        color: theme.colors.status.error,
    },
    resultsGroup: {
        marginBottom: theme.space.s16,
    },
    resultsSection: {
        minHeight: 200,
    },
    resultsList: {
        paddingVertical: theme.space.s8,
    },
    separator: {
        height: 1,
        backgroundColor: theme.colors.border.default,
        marginHorizontal: theme.space.s16,
        marginVertical: theme.space.s8,
    },
    loadingContainer: {
        alignItems: 'center',
        padding: theme.space.s32,
    },
    loadingText: {
        marginTop: theme.space.s16,
        fontSize: 16,
        color: theme.colors.text.secondary,
    },
    noResultsContainer: {
        alignItems: 'center',
        padding: theme.space.s32,
    },
    noResultsText: {
        fontSize: 16,
        color: theme.colors.text.secondary,
        marginBottom: theme.space.s8,
    },
    noResultsHint: {
        fontSize: 14,
        color: theme.colors.text.secondary,
        textAlign: 'center',
    },
    helpContainer: {
        padding: theme.space.s32,
        alignItems: 'center',
    },
    helpTitle: {
        ...Typography.variant('heading'),
        color: theme.colors.text.primary,
        marginBottom: theme.space.s16,
    },
    helpText: {
        fontSize: 15,
        color: theme.colors.text.secondary,
        textAlign: 'center',
        lineHeight: 22,
    },
}));
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { SearchFriendsScreen as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={SearchFriendsScreen} />; }
