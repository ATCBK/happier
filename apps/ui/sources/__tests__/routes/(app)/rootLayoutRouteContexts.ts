import * as React from 'react';

import { MainAppTabStateProvider } from '@/components/navigation/mobile/chrome/MainAppTabStateProvider';
import { InboxSummaryProvider } from '@/hooks/inbox/useInboxSummary';

/** Parents normally supplied by app/_layout and SidebarNavigator to the nested app route. */
export function RootLayoutRouteContexts(props: React.PropsWithChildren): React.ReactElement {
    return React.createElement(MainAppTabStateProvider, null,
        React.createElement(InboxSummaryProvider, null, props.children));
}
