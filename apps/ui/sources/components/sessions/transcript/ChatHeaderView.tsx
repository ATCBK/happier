import * as React from 'react';
import { PaneMainBody } from '@/components/ui/panels/paneMainComposerAnchor';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';
import { View, Platform, Pressable, type LayoutChangeEvent } from 'react-native';
import { useNavigation } from '@/components/appShell/workspace/destinationRoute';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { useSetting } from '@/sync/domains/state/storage';
import { Typography } from '@/constants/Typography';
import { useHeaderHeight } from '@/utils/platform/responsive';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { ChatHeaderCompactContext, ChatHeaderTitleAccessoryCompactContext } from './chatHeaderCompact';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { t } from '@/text';
import { resolveOptionalSessionScreenTestId, useSessionScreenTestIdsEnabled } from '../shell/sessionScreenTestIds';
import { Icon } from '@/components/ui/icons/Icon';
import { SessionHeaderPullHost, SessionHeaderPullTarget } from '@/components/sessions/shell/SessionHeaderPull';
import {
    HEADER_BAND_HORIZONTAL_PADDING_PX,
    HEADER_BAND_SUBTITLE_TEXT,
    HEADER_BAND_TITLE_TEXT,
} from '@/components/ui/layout/headerBand';

interface ChatHeaderViewProps {
    title: string;
    /** A summary-only control beside the title; detailed readers mount only after it opens. */
    titleAccessory?: React.ReactNode;
    subtitle?: string;
    subtitleEllipsizeMode?: 'head' | 'tail';
    badges?: ReadonlyArray<string>;
    onBackPress?: () => void;
    avatarId?: string;
    /** Canonical machine-scoped Agent identity mark, shown in place of the avatar on request. */
    agentIdentity?: React.ReactNode;
    /** The leads above a reporting Session, over the title (a leaf that draws nothing for a root). */
    lineage?: React.ReactNode;
    rightElement?: React.ReactNode;
    backgroundColor?: string;
    tintColor?: string;
    isConnected?: boolean;
    flavor?: string | null;
    /** Centre the header content at the transcript's width (the header sits in the transcript column). */
    constrainWidth?: boolean;
    includeTopInset?: boolean;
    /**
     * Defaults to shown. Suppressed where a permanent sidebar is on screen: there is no stack to
     * pop back to, so the chevron is a control that does nothing but take the first slot in the
     * header. The share viewer has no sidebar and keeps it.
     */
    showBackButton?: boolean;
    /**
     * Phone: pulling the identity or title down opens All tabs (`SessionHeaderPull`). Absent where
     * there is nothing to switch to (the share viewer).
     */
    onPullAllTabs?: () => void;
}

export const ChatHeaderView = React.memo(function ChatHeaderView({
    title,
    titleAccessory,
    subtitle,
    subtitleEllipsizeMode = 'tail',
    badges,
    onBackPress,
    avatarId,
    agentIdentity,
    lineage,
    rightElement,
    isConnected = true,
    flavor,
    constrainWidth = true,
    includeTopInset = true,
    showBackButton = true,
    onPullAllTabs,
}: ChatHeaderViewProps): React.ReactElement {
    const materialColor = useHappierMaterialColorResolver();
    const { theme } = useUnistyles();
    const navigation = useNavigation();
    const insets = useChromeSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const maxWidth = useLayoutMaxWidth();
    const sessionScreenTestIdsEnabled = useSessionScreenTestIdsEnabled();
    const backButtonTestId = resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-header-back');
    const avatarButtonTestId = resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-header-avatar');
    const shouldUseWebSubtitleStartEllipsis = subtitleEllipsizeMode === 'head' && Platform.OS === 'web';
    const identityMode = useSetting('sessionHeaderIdentityDisplay');
    // The band's width and its actions' full width (measured while not compact, so taking the compact
    // form never flips the decision back).
    const [bandWidth, setBandWidth] = React.useState(0);
    const [fullActionsWidth, setFullActionsWidth] = React.useState(0);
    const [compactActions, setCompactActions] = React.useState(false);
    React.useEffect(() => {
        if (bandWidth <= 0 || fullActionsWidth <= 0) return;
        const next = bandWidth - fullActionsWidth < fullActionsWidth;
        setCompactActions((current) => current === next ? current : next);
    }, [bandWidth, fullActionsWidth]);

    // The title line: the title keeps its natural width when it can; the accessory is whole or compact.
    // Its full width is measured only in the full form, so taking the compact form never flips back.
    const [titleRowWidth, setTitleRowWidth] = React.useState(0);
    const [titleNaturalWidth, setTitleNaturalWidth] = React.useState(0);
    const [fullAccessoryWidth, setFullAccessoryWidth] = React.useState(0);
    const compactAccessory = titleAccessory != null && titleRowWidth > 0 && titleNaturalWidth > 0 && fullAccessoryWidth > 0
        && titleNaturalWidth + TITLE_ROW_GAP_PX + fullAccessoryWidth > titleRowWidth;
    const measureWidth = (set: React.Dispatch<React.SetStateAction<number>>) => (event: LayoutChangeEvent) => {
        const width = Math.round(event.nativeEvent.layout.width);
        if (width > 0) set((current) => current === width ? current : width);
    };

    // Which identity leads the header is the user's call. `agentLogo` with no resolvable agent
    // renders nothing rather than silently falling back to the avatar — that would answer a question
    // the user already answered.
    const leadingIdentity = React.useMemo(() => {
        if (identityMode === 'none') return null;
        if (identityMode === 'agentLogo') {
            return agentIdentity ?? null;
        }
        return avatarId
            ? <Avatar id={avatarId} size={32} monochrome={!isConnected} flavor={flavor} />
            : null;
    }, [agentIdentity, avatarId, flavor, identityMode, isConnected]);

    const handleBackPress = () => {
        if (onBackPress) {
            onBackPress();
        } else {
            navigation.goBack();
        }
    };

    return (
        <PaneMainBody style={[styles.container, { paddingTop: includeTopInset ? insets.top : 0, backgroundColor: materialColor(theme.colors.surface.base, 'transparent') }]}>
            <View style={[styles.contentWrapper, constrainWidth ? null : { alignItems: 'stretch' }]}
                onLayout={(event: LayoutChangeEvent) => {
                    const width = Math.round(event.nativeEvent.layout.width);
                    // The band is the wrapper's width, capped by the layout's max width when constrained.
                    setBandWidth(constrainWidth && typeof maxWidth === 'number' ? Math.min(width, maxWidth) : width);
                }}>
                <HeaderBand
                    onPullAllTabs={onPullAllTabs}
                    hintTop={0}
                    testID="session-header-band"
                    style={[
                        styles.content,
                        { height: headerHeight, maxWidth },
                        constrainWidth ? null : { maxWidth: '100%' },
                    ]}
                >
                {showBackButton ? (
                    <Pressable
                        onPress={handleBackPress}
                        testID={backButtonTestId}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.back')}
                        style={styles.backButton}
                        hitSlop={15}
                    >
                        <Icon
                            name={Platform.OS === 'ios' ? 'caret-left' : 'arrow-left'}
                            size={Platform.select({ ios: 28, default: 24 })}
                            color={theme.colors.chrome.header.foreground}
                        />
                    </Pressable>
                ) : null}

                <HeaderPullTarget pullable={onPullAllTabs !== undefined} style={styles.identityAndTitle}>
                {leadingIdentity ? (
                    <View style={styles.avatarLeading} testID={avatarButtonTestId}>
                        {leadingIdentity}
                    </View>
                ) : null}

                <View style={styles.titleContainer}>
                    {lineage}
                    <View style={styles.titleRow} testID="session-header-title-row" onLayout={titleAccessory ? measureWidth(setTitleRowWidth) : undefined}>
                        {titleAccessory ? (
                            <Text
                                testID="session-header-title-measure"
                                numberOfLines={1}
                                aria-hidden
                                accessibilityElementsHidden
                                importantForAccessibility="no-hide-descendants"
                                onLayout={measureWidth(setTitleNaturalWidth)}
                                style={[styles.title, styles.titleMeasure, Typography.default('semiBold')]}
                            >
                                {title}
                            </Text>
                        ) : null}
                        <Text
                            numberOfLines={1}
                            ellipsizeMode="tail"
                            style={[
                                styles.title,
                                {
                                    color: theme.colors.chrome.header.foreground,
                                    ...Typography.default('semiBold')
                                }
                            ]}
                        >
                            {title}
                        </Text>
                        {titleAccessory ? (
                            <View
                                testID="session-header-title-accessory"
                                style={styles.titleAccessory}
                                onLayout={compactAccessory ? undefined : measureWidth(setFullAccessoryWidth)}
                            >
                                <ChatHeaderTitleAccessoryCompactContext.Provider value={compactAccessory}>
                                    {titleAccessory}
                                </ChatHeaderTitleAccessoryCompactContext.Provider>
                            </View>
                        ) : null}
                        {badges && badges.length > 0 ? (
                            badges.map((badge, index) => (
                                <View
                                    key={`${badge}:${index}`}
                                    style={[
                                        styles.badge,
                                        {
                                            backgroundColor: theme.colors.state.neutral.background,
                                        },
                                    ]}
                                    testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, `session-header-badge:${index}`)}
                                >
                                    <Text
                                        numberOfLines={1}
                                        style={[
                                            styles.badgeText,
                                            { color: theme.colors.state.neutral.foreground },
                                        ]}
                                    >
                                        {badge}
                                    </Text>
                                </View>
                            ))
                        ) : null}
                    </View>
                    {subtitle && (
                        <Text
                            numberOfLines={1}
                            ellipsizeMode={shouldUseWebSubtitleStartEllipsis ? undefined : subtitleEllipsizeMode}
                            style={[
                                styles.subtitle,
                                shouldUseWebSubtitleStartEllipsis ? styles.subtitleHeadWeb : null,
                                {
                                    color: theme.colors.chrome.header.foreground,
                                    opacity: 0.7,
                                    ...Typography.default()
                                }
                            ]}
                        >
                            {shouldUseWebSubtitleStartEllipsis ? (
                                <Text style={styles.subtitleHeadTextWeb}>{subtitle}</Text>
                            ) : subtitle}
                        </Text>
                    )}
                </View>
                </HeaderPullTarget>

                {rightElement ? (
                    <View style={styles.rightElementContainer} onLayout={compactActions ? undefined
                        : (event: LayoutChangeEvent) => setFullActionsWidth(Math.round(event.nativeEvent.layout.width))}>
                        <ChatHeaderCompactContext.Provider value={compactActions}>
                            {rightElement}
                        </ChatHeaderCompactContext.Provider>
                    </View>
                ) : null}

                </HeaderBand>
            </View>
        </PaneMainBody>
    );
});

/**
 * The band, and the part of it a pull can start from. Without `onPullAllTabs` these are the plain
 * views they always were; the choice is fixed per screen (it comes from the screen's own props), so
 * the subtree never swaps types while mounted.
 */
function HeaderBand(props: Readonly<{
    onPullAllTabs?: () => void;
    hintTop: number;
    testID: string;
    style: React.ComponentProps<typeof View>['style'];
    children: React.ReactNode;
}>) {
    if (!props.onPullAllTabs) {
        return <View testID={props.testID} style={props.style}>{props.children}</View>;
    }
    return (
        <SessionHeaderPullHost onOpen={props.onPullAllTabs} hintTop={props.hintTop} testID={props.testID} style={props.style}>
            {props.children}
        </SessionHeaderPullHost>
    );
}

function HeaderPullTarget(props: Readonly<{
    pullable: boolean;
    style: React.ComponentProps<typeof View>['style'];
    children: React.ReactNode;
}>) {
    if (!props.pullable) return <View style={props.style}>{props.children}</View>;
    return <SessionHeaderPullTarget style={props.style}>{props.children}</SessionHeaderPullTarget>;
}

const TITLE_ROW_GAP_PX = 6;

const styles = StyleSheet.create(() => ({
    container: {
        position: 'relative',
        zIndex: 100,
        elevation: 10,
    },
    contentWrapper: {
        width: '100%',
        alignItems: 'center',
    },
    content: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: HEADER_BAND_HORIZONTAL_PADDING_PX,
        width: '100%',
    },
    backButton: {
        marginRight: 8,
    },
    identityAndTitle: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        minWidth: 0,
        alignSelf: 'stretch',
    },
    titleContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'flex-start',
        minWidth: 0,
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: TITLE_ROW_GAP_PX,
        width: '100%',
    },
    // Measures the title's natural width off-flow; never drawn, never read aloud.
    titleMeasure: {
        position: 'absolute',
        left: 0,
        top: 0,
        opacity: 0,
        pointerEvents: 'none',
        flexShrink: 0,
    },
    title: {
        ...HEADER_BAND_TITLE_TEXT,
        flexShrink: 1,
    },
    // The title owns the row. Its accessory (role chip) takes its compact form when it no longer fits
    // whole, and badges give up their space first, so a narrow pane never cuts the name to "Pa…".
    titleAccessory: {
        flexShrink: 100,
        minWidth: 0,
        overflow: 'hidden',
    },
    subtitle: HEADER_BAND_SUBTITLE_TEXT,
    subtitleHeadWeb: {
        writingDirection: 'rtl' as const,
        textAlign: 'left' as const,
    },
    subtitleHeadTextWeb: {
        writingDirection: 'ltr' as const,
        unicodeBidi: 'isolate' as const,
    },
    // Matches the canonical badge (components/ui/status/StatusPill): background-only, no border
    // chrome, 8px radius. A bordered capsule in the header read as a different species from every
    // other badge in the product.
    badge: {
        flexShrink: 100,
        minWidth: 0,
        overflow: 'hidden',
        borderWidth: 0,
        borderRadius: 8,
    },
    // The inset lives on the label so a collapsed badge leaves no empty capsule behind.
    badgeText: {
        ...Typography.variant('micro', 'semiBold'),
        paddingHorizontal: 8,
        paddingVertical: 2,
    },
    avatarLeading: {
        marginRight: 10,
    },
    rightElementContainer: {
        flexDirection: 'row',
        alignItems: 'center',
    },
}));
