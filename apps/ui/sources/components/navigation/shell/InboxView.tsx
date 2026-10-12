import * as React from 'react';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';
import { View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierListDetailLayout, useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { InboxContent, type InboxView as InboxContentView } from '@/components/inbox/InboxContent';
import { createInboxItemRoute, type InboxItemFocus } from '@/components/inbox/inboxItemFocus';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { countInboxNeedsYou, countInboxUpdates } from '@/components/inbox/inboxCounts';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Header } from '@/components/navigation/Header';
import { NavigationTitleChromeProvider, PageHeader } from '@/components/ui/layout/PageHeader';
import { ItemList } from '@/components/ui/lists/ItemList';
import {
    InboxModelBoundary,
    useInboxModel,
} from '@/hooks/inbox/useInboxModel';
import { t } from '@/text';
import { useIsTablet } from '@/utils/platform/responsive';

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface.base,
    },
    phoneTabs: {
        paddingHorizontal: theme.space.s16,
        paddingBottom: theme.space.s4,
    },
}));

// The detail draws a session, a run page or an approval page: loaded when something is selected, so
// the Inbox list (and a phone, which never shows the pane) does not carry those screens.
const InboxItemDetail = retryableLazy(() => import('@/components/inbox/detail/InboxItemDetail')
    .then((module) => ({ default: module.InboxItemDetail })));

/**
 * Beside the detail the list keeps room for a row's title, its line and its inline answer; the
 * detail keeps room for an approval page's decision row and a transcript's messages. Below their
 * sum the Inbox is the list alone and rows open their item's own page.
 */
const INBOX_LIST_MIN_WIDTH_PX = 400;
const INBOX_DETAIL_MIN_WIDTH_PX = 440;
const INBOX_LIST_SHARE = 0.6;

const InboxViewContent = React.memo(function InboxViewContent(props: Readonly<{ focusedItem?: InboxItemFocus | null }>) {
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    const model = useInboxModel();
    // Lab `phone-P4`: on a phone the page carries the Inbox's large title itself (the Home hub's hero
    // step), with the view control under it and no purpose line; the tabs and groups say what it holds.
    // Wide layouts have no navigation title either: the page header carries it beside the control.
    const phone = !useIsTablet();
    // `/inbox?item=` (a Boards card): open on Needs you with that item's row selected.
    const focusedItem = props.focusedItem ?? null;
    const [view, setView] = React.useState<InboxContentView>('needs_you');
    React.useEffect(() => {
        if (focusedItem) setView('needs_you');
    }, [focusedItem]);
    const needsYouCount = countInboxNeedsYou(model);
    const updatesCount = countInboxUpdates(model);
    // Lab `inbox-I1`/`phone-P4`: what needs you, and what finished, as two views of one Inbox.
    const tabs = (
        <SegmentedTabBar
            testIDPrefix="inbox.view"
            accessibilityLabel={t('inbox.work.tabs.a11y')}
            // A phone's control spans the width as a thumb target (lab `phone-P4`); the header's hugs its
            // labels beside the title at the control step (lab `inbox-I1`), not the compact one.
            segmentSizing={phone ? undefined : 'content'}
            tabs={[
                { id: 'needs_you' as const, label: t('inbox.work.tabs.needsYou'), ...(needsYouCount > 0 ? { count: String(needsYouCount) } : {}) },
                { id: 'updates' as const, label: t('inbox.work.tabs.updates'), ...(updatesCount > 0 ? { count: String(updatesCount) } : {}) },
            ]}
            activeTabId={view}
            onSelectTab={setView}
        />
    );

    const renderList = (onSelectItem: ((focus: InboxItemFocus) => void) | undefined) => (
        <NavigationTitleChromeProvider showsTitle={false}>
            {/* A page of work rows with their inline answers (lab `inbox-I1`): the wide column. */}
            <ItemList testID="inbox.screen" pageColumn="wide">
                <PageHeader
                    title={t('tabs.inbox')}
                    titleProminence={phone ? 'hero' : 'page'}
                    description={phone ? undefined : t('inbox.work.pageDescription')}
                    actions={phone ? undefined : tabs}
                />
                {phone ? <View style={styles.phoneTabs}>{tabs}</View> : null}
                <InboxContent model={model} presentation="screen" view={view} focusedItem={focusedItem} onSelectItem={onSelectItem} />
            </ItemList>
        </NavigationTitleChromeProvider>
    );

    return (
        <View style={[styles.container, { backgroundColor: materialColor(theme.colors.surface.base, 'transparent') }]}>
            {/* A phone's bar belongs to the tab shell (`MainView`); a second empty band would push the title down. */}
            {phone ? null : (
                <Header
                    title={null}
                    headerLeft={() => null}
                    headerRight={() => null}
                    headerShadowVisible={false}
                    headerTransparent
                />
            )}
            {phone ? renderList(undefined) : <InboxListDetail focusedItem={focusedItem} renderList={renderList} />}
        </View>
    );
});

/**
 * Lab `inbox-I1`: the list beside the selected item, selection held by the route's `item` parameter
 * so a link, Back and a reload all land on the same item. Where both panes do not fit, the list is
 * the page and a row opens its item's own page, as on a phone (DESIGN.md, Collections).
 *
 * With nothing selected the list is the whole page: no empty pane beside it. The Inbox does not land
 * on a first item, because opening an item is reading it (a session marks itself seen), and the Inbox
 * must not settle what the person has not looked at.
 */
const InboxListDetail = React.memo(function InboxListDetail(props: Readonly<{
    focusedItem: InboxItemFocus | null;
    renderList: (onSelectItem: ((focus: InboxItemFocus) => void) | undefined) => React.ReactNode;
}>) {
    const router = useRouter();
    const { theme } = useUnistyles();
    const { fontScale } = useWindowDimensions();
    const scale = Math.max(1, fontScale);
    const select = React.useCallback((focus: InboxItemFocus) => {
        router.replace(createInboxItemRoute(focus) as never);
    }, [router]);
    const close = React.useCallback(() => {
        router.replace('/inbox' as never);
    }, [router]);
    return (
        <HappierListDetailLayout
            testID="inbox.layout"
            listTestID="inbox.list-pane"
            detailTestID="inbox.detail-pane"
            minListWidth={INBOX_LIST_MIN_WIDTH_PX * scale}
            minDetailWidth={INBOX_DETAIL_MIN_WIDTH_PX * scale}
            preferredListRatio={INBOX_LIST_SHARE}
            stackedPane="list"
            // The hairline separates the list from an open item; a list alone has nothing to separate from.
            listStyle={props.focusedItem ? { borderRightWidth: 1, borderRightColor: theme.colors.border.default } : undefined}
            list={(layout) => props.renderList(layout?.mode === 'split' ? select : undefined)}
            detail={props.focusedItem ? (
                <React.Suspense fallback={<PaneLoadingFallback />}>
                    <InboxItemDetail focus={props.focusedItem} onClose={close} />
                </React.Suspense>
            ) : null}
        />
    );
});

/**
 * The app shell owns the model in production. The boundary keeps isolated
 * stories/tests functional without mounting a second owner beneath the shell.
 */
export const InboxView = React.memo(function InboxView(props: Readonly<{
    /** The item the person came to see, from the route's `item` parameter. */
    focusedItem?: InboxItemFocus | null;
}>) {
    return (
        <InboxModelBoundary>
            <InboxViewContent focusedItem={props.focusedItem ?? null} />
        </InboxModelBoundary>
    );
});
