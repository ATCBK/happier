import React from 'react';
import type { UserProfile } from '@/sync/domains/social/friendTypes';
import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { t } from '@/text';
import { Item } from '@/components/ui/lists/Item';
import { Avatar } from '@/components/ui/avatar/Avatar';

interface UserCardProps {
    user: UserProfile;
    onPress?: () => void;
    disabled?: boolean;
    subtitle?: string;
    showDivider?: boolean;
    density?: 'comfortable' | 'cozy' | 'compact' | 'tight';
}

export function UserCard({ 
    user, 
    onPress,
    disabled,
    subtitle,
    showDivider,
    density,
}: UserCardProps) {
    const displayName = formatAccountDisplayName(user) ?? t('accountDisplay.unnamed');
    const avatarUrl = user.avatar?.url || user.avatar?.path;

    // Create avatar element using the Avatar component
    const avatarElement = (
        <Avatar
            id={user.id}
            size={40}
            imageUrl={avatarUrl}
            thumbhash={user.avatar?.thumbhash}
        />
    );

    // Create subtitle
    const subtitleText = subtitle ?? `@${user.username}`;

    return (
        <Item
            title={displayName}
            subtitle={subtitleText}
            subtitleLines={1}
            leftElement={avatarElement}
            onPress={onPress}
            showChevron={!!onPress}
            disabled={disabled}
            showDivider={showDivider}
            density={density}
        />
    );
}
