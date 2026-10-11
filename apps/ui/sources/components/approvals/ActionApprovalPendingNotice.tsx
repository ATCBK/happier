import * as React from 'react';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';

/**
 * A row for an Action that is waiting on an approval, with one button to open it. It is a row, so it
 * takes the sheet's own padding and edge wherever it sits; the originating Action continuation owns
 * settlement.
 */
export const ActionApprovalPendingNotice = React.memo(function ActionApprovalPendingNotice(props: Readonly<{
    message: string;
    onOpenApproval: () => void;
    testID?: string;
}>) {
    return (
        <Item
            testID={props.testID}
            mode="info"
            title={props.message}
            subtitleLines={0}
            showChevron={false}
            rightElement={<RoundButton size="small" display="secondary" title={t('approvals.title')} onPress={props.onOpenApproval} />}
        />
    );
});
