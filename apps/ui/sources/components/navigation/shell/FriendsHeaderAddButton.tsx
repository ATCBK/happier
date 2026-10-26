import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { useFriendsIdentityReadiness } from '@/hooks/server/useFriendsIdentityReadiness';
import { trackFriendsSearch } from '@/track';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';

type FriendsHeaderAddButtonProps = Readonly<{
    testID?: string;
    /** Keep the header width stable while the friends identity gate is resolving. */
    hideWhenDisabled?: boolean;
}>;

/**
 * Shared add-friend affordance for every Friends surface.
 *
 * The search route owns the identity/feature gate, while this button mirrors its
 * readiness state so a header can never open an unusable flow.
 */
export const FriendsHeaderAddButton = React.memo(function FriendsHeaderAddButton(
    props: FriendsHeaderAddButtonProps,
) {
    const router = useRouter();
    const { theme } = useUnistyles();
    const friendsIdentityReadiness = useFriendsIdentityReadiness();
    const friendsIdentityReady = friendsIdentityReadiness.isReady;

    if (!friendsIdentityReady && props.hideWhenDisabled) {
        return <View testID={props.testID} style={{ width: 32, height: 32 }} />;
    }

    return (
        <Pressable
            testID={props.testID}
            onPress={() => {
                trackFriendsSearch();
                router.push('/friends/search');
            }}
            hitSlop={15}
            style={({ pressed }) => ({
                width: 32,
                height: 32,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: friendsIdentityReady ? (pressed ? 0.7 : 1) : 0.5,
            })}
            disabled={!friendsIdentityReady}
            accessibilityRole="button"
            accessibilityLabel={t('friends.addFriend')}
            accessibilityState={{ disabled: !friendsIdentityReady }}
        >
            <Icon name="user-plus" size={24} color={theme.colors.chrome.header.foreground} />
        </Pressable>
    );
});
