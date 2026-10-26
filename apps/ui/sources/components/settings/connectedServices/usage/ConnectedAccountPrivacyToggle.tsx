import * as React from 'react';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { t } from '@/text';

/**
 * The eye that turns "Hide account emails and IDs" on and off (lab `csvc` PV): a switch, so it
 * announces its state; the crossed eye while identities are hidden. The one toggle for the device
 * setting wherever identities render beside it (the Usage popover, the Connected services rail).
 */
export const ConnectedAccountPrivacyToggle = React.memo(function ConnectedAccountPrivacyToggle(props: Readonly<{
    hidden: boolean;
    onChange: (hidden: boolean) => void;
    testID?: string;
    /** The visible square; the default suits a popover or rail head. */
    size?: number;
}>) {
    const label = t('sidebarFooter.hideAccountIdentities');
    return (
        <IconButton
            testID={props.testID}
            iconName={props.hidden ? 'eye-slash' : 'eye'}
            variant="plain"
            size={props.size ?? 26}
            accessibilityLabel={label}
            accessibilityRole="switch"
            checked={props.hidden}
            tooltip={props.hidden ? t('sidebarFooter.accountIdentitiesHidden') : label}
            selectedBackground={false}
            onPress={() => props.onChange(!props.hidden)}
        />
    );
});
