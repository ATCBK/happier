import * as React from 'react';
import { TabBadge } from './TabBadge';
import { resolveGitTabBadge, type TabBarGitBadgeMode } from './tabBadgeModel';
import type { ScmStatus } from '@/sync/domains/state/storageTypes';
import type { RailBadgeSignalRenderer } from '@/components/navigation/shell/appRail/AppRailBadge';

export function GitActionRailBadge(props: Readonly<{
    scmStatus: ScmStatus | null | undefined;
    mode: TabBarGitBadgeMode;
    testID?: string;
    renderSignal?: RailBadgeSignalRenderer;
}>) {
    const badge = resolveGitTabBadge(props.mode, props.scmStatus);
    if (props.renderSignal) return <>{props.renderSignal(badge ? { kind: 'count', tone: 'neutral',
        value: badge.kind === 'count' ? badge.value : badge.changedFileCount } : null)}</>;
    if (!badge) return null;
    return badge.kind === 'count'
        ? <TabBadge size="compact" variant="count" value={badge.value} tone="neutral" testID={props.testID} />
        : <TabBadge size="compact" variant="diff" added={badge.added} removed={badge.removed} changedFileCount={badge.changedFileCount} testID={props.testID} style={{ flexDirection: 'column', top: -4, left: -9, right: -9, height: 'auto' }} />;
}
