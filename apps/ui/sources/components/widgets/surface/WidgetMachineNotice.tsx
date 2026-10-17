import * as React from 'react';
import { View } from 'react-native';
import { useStore } from 'zustand';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { WidgetFrameBodyNoticeContext, type WidgetFrameBodyNoticeSource } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { storage } from '@/sync/domains/state/storageStore';
import { t } from '@/text';

/**
 * Says, in place of a widget body, that the Machine the widget runs on cannot be reached — naming it and
 * the way out, with one action — once the mounted body has been refused a Machine-owned call. The mount
 * that refused lends how to word it (`useBoundPluginSurfaceController`); the wording is read again
 * whenever the stores change, so the Machine's name fills in and the notice leaves when the Machine
 * answers. The body stays mounted but hidden while the notice shows (it is what asks the Machine and
 * withdraws the notice), so the cause is stated once whichever plugin the widget is; a plugin's own
 * error never appears for this cause. Retry asks the body afresh.
 */
export function WidgetMachineNoticeBoundary(props: Readonly<{ testID: string; children: React.ReactNode }>): React.ReactElement {
    const [source, setSource] = React.useState<WidgetFrameBodyNoticeSource | null>(null);
    const [attempt, setAttempt] = React.useState(0);
    const lend = React.useCallback((next: WidgetFrameBodyNoticeSource | null) => setSource(() => next), []);
    const retry = React.useCallback(() => {
        setSource(null);
        setAttempt((current) => current + 1);
    }, []);
    const notice = useStore(storage, () => source?.() ?? null);
    return (
        <WidgetFrameBodyNoticeContext.Provider value={lend}>
            {notice === null ? null : (
                <SurfaceStateCard
                    testID={`${props.testID}-machine-notice`}
                    kind="warning"
                    replacesContent
                    title={notice}
                    action={{ label: t('common.retry'), onPress: retry }}
                    accessibilitySemantics="status"
                />
            )}
            <View testID={`${props.testID}-body`} style={notice === null ? bodyShown : bodyHidden}>
                <React.Fragment key={attempt}>{props.children}</React.Fragment>
            </View>
        </WidgetFrameBodyNoticeContext.Provider>
    );
}

const bodyShown = { flexGrow: 1, minWidth: 0 } as const;
const bodyHidden = { display: 'none' } as const;
