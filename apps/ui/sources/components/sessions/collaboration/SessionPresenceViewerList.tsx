import * as React from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Avatar } from '@/components/ui/avatar/Avatar';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ITEM_SUBTITLE_TEXT_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { useScrollViewWheelScrollTo } from '@/components/ui/scroll/useScrollViewWheelScrollTo';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { CustomModalInjectedProps } from '@/modal';
import { t } from '@/text';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { useSessionHumanPresence } from '@/sync/domains/session/humanPresence/useSessionHumanPresence';
import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';

/**
 * The complete `Viewing now` roster.
 *
 * It answers who is here, and nothing in it is selectable: a viewer is a fact,
 * not a destination. The rows are therefore the canonical non-interactive `Item`
 * presentation — no press handler, no button role, no keyboard tab stop — rather
 * than list options whose activation silently does nothing. They are equally not
 * `disabled`: dimming a person who is present right now would say the opposite of
 * what is true.
 *
 * The modal follows the live qualified projection; it never captures an
 * out-of-date list in modal props. Escape, backdrop, and hardware Back stay owned
 * by the modal host.
 */
export function SessionPresenceViewerList({ target }: Readonly<{ target: SessionAddress }> & CustomModalInjectedProps) {
    const presence = useSessionHumanPresence(target);
    const { theme } = useUnistyles();
    const scrollRef = React.useRef<ScrollView>(null);
    const wheelScrollHandlers = useScrollViewWheelScrollTo(scrollRef);
    const emptyStatus = presence.status === 'live' ? t('session.collaboration.justYou')
        : presence.status === 'connecting' ? t('session.collaboration.connecting')
            : t('session.collaboration.unavailable');
    const statusStyle = { ...Typography.default(), ...ITEM_SUBTITLE_TEXT_METRICS.comfortable, color: theme.colors.text.secondary, padding: theme.space.s16 };
    return <View testID="session-presence-viewers" style={{ flex: 1, minHeight: 0 }}
        {...(Platform.OS === 'web' ? ({ onWheel: wheelScrollHandlers.onWheel } as any) : {})}>
        {presence.status === 'stale' ? <Text style={statusStyle}>{t('session.collaboration.stale')}</Text> : null}
        <ScrollView ref={scrollRef} style={{ flex: 1 }} onScroll={wheelScrollHandlers.onScroll} scrollEventThrottle={16}>
            {presence.viewers.length === 0 ? <Text style={statusStyle}>{emptyStatus}</Text> : (
                // A Session's authorized human audience is small enough to render
                // whole; if a Home ever renders hundreds of simultaneous viewers,
                // this group is the place that needs the canonical virtualizer.
                <View accessibilityRole="list" accessibilityLabel={t('session.collaboration.viewingNow')}>
                    <ItemGroup>
                        {presence.viewers.map((viewer) => (
                            <Item
                                key={viewer.account.accountId}
                                testID={`session-presence-viewer:${viewer.account.accountId}`}
                                title={formatAccountDisplayName(viewer.account) ?? t('session.collaboration.unnamed')}
                                subtitle={presence.status === 'live' && viewer.typing ? t('session.collaboration.typing') : undefined}
                                icon={<Avatar id={viewer.account.accountId} imageUrl={viewer.account.avatarUrl} size={28} />}
                                webRole="listitem"
                                showChevron={false}
                            />
                        ))}
                    </ItemGroup>
                </View>
            )}
        </ScrollView>
    </View>;
}
