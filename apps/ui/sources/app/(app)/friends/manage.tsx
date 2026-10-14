import React from 'react';
import { useAcceptedFriends, useFriendRequests, useRequestedFriends } from '@/sync/domains/state/storage';
import { UserCard } from '@/components/ui/cards/UserCard';
import { t } from '@/text';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useRequireFriendsEnabled } from '@/hooks/friends/useRequireFriendsEnabled';
import { RequireFriendsIdentityForFriends } from '@/components/friends/RequireFriendsIdentityForFriends';
import { Item } from '@/components/ui/lists/Item';
import { PageHeader } from '@/components/ui/layout/PageHeader';


export function FriendsManageScreen() {
    const enabled = useRequireFriendsEnabled();
    const router = useRouter();
    const friends = useAcceptedFriends();
    const friendRequests = useFriendRequests();
    const requestedFriends = useRequestedFriends();

    if (!enabled) return null;

    return (
        <RequireFriendsIdentityForFriends>
            <ItemList>
                <PageHeader
                    title={t('navigation.friends')}
                    description={t('detailPages.friendsManage.description')}
                    primaryAction={{
                        title: t('friends.addFriend'),
                        icon: 'plus',
                        onPress: () => router.push('/friends/search'),
                        testID: 'friends-add-friend',
                    }}
                />

                {friendRequests.length > 0 && (
                    <ItemGroup
                        title={t('detailPages.friendsManage.requestsTitle')}
                        description={t('detailPages.friendsManage.requestsDescription')}
                    >
                        {friendRequests.map((friend) => (
                            <UserCard
                                key={friend.id}
                                user={friend}
                                onPress={() => router.push(`/user/${friend.id}`)}
                            />
                        ))}
                    </ItemGroup>
                )}

                {requestedFriends.length > 0 && (
                    <ItemGroup
                        title={t('detailPages.friendsManage.sentTitle')}
                        description={t('detailPages.friendsManage.sentDescription')}
                    >
                        {requestedFriends.map((friend) => (
                            <UserCard
                                key={friend.id}
                                user={friend}
                                onPress={() => router.push(`/user/${friend.id}`)}
                            />
                        ))}
                    </ItemGroup>
                )}

                <ItemGroup
                    title={t('detailPages.friendsManage.friendsTitle')}
                    description={friends.length > 0 ? t('detailPages.friendsManage.friendsDescription') : undefined}
                >
                    {friends.length === 0 ? (
                        <Item title={t('friends.noFriendsYet')} showChevron={false} />
                    ) : (
                        friends.map((friend) => (
                            <UserCard
                                key={friend.id}
                                user={friend}
                                onPress={() => router.push(`/user/${friend.id}`)}
                            />
                        ))
                    )}
                </ItemGroup>
            </ItemList>
        </RequireFriendsIdentityForFriends>
    );
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { FriendsManageScreen as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={FriendsManageScreen} />; }
