import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/**
 * The bar that says Home is being customized (lab `widget-groups` wgmenu E): what state the page is
 * in and what dragging does, then the three things that are not on a card — the section list, Add
 * widget and the one primary action, Done. On a phone the hint leaves and the actions wrap beneath.
 */
export const HomeCustomizeBanner = React.memo(function HomeCustomizeBanner(
  props: Readonly<{
    phone: boolean;
    sectionsOpen: boolean;
    addOpen: boolean;
    onToggleSections: () => void;
    onToggleAdd: () => void;
    onDone: () => void;
    sectionsAnchorRef?: React.RefObject<View | null>;
    addAnchorRef?: React.RefObject<View | null>;
    /** The whole bar, which spans the content column: Add centres on it. */
    barRef?: React.RefObject<View | null>;
    /** Look (the atmosphere behind Home) opens the same panel as Home's Look chip; it is not a mode. */
    lookOpen?: boolean;
    onToggleLook?: () => void;
    lookAnchorRef?: React.RefObject<View | null>;
  }>,
) {
  const { theme } = useUnistyles();
  return (
    <View ref={props.barRef} collapsable={false} testID="home-hub.customizing" style={styles.bar}>
      <View style={styles.words}>
        <Icon
          name="sliders-horizontal"
          size={ICON_SIZE.sm}
          color={theme.colors.text.primary}
        />
        <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>
          {t('homeIndex.customizing')}
        </Text>
        {props.phone ? null : (
          <Text style={styles.hint}>
            {t('homeIndex.customizingHint')}
          </Text>
        )}
      </View>
      <View style={styles.actions}>
        {props.onToggleLook ? (
          <View ref={props.lookAnchorRef} collapsable={false}>
            <SectionActionButton
              testID="home-hub.customizing.look"
              title={t('settingsAppearance.glassControls.look')}
              icon="palette"
              expanded={props.lookOpen}
              onPress={props.onToggleLook}
            />
          </View>
        ) : null}
        <View ref={props.sectionsAnchorRef} collapsable={false}>
          <SectionActionButton
            testID="home-hub.customizing.sections"
            title={t('homeIndex.sections')}
            icon="list-bullets"
            expanded={props.sectionsOpen}
            onPress={props.onToggleSections}
          />
        </View>
        <View ref={props.addAnchorRef} collapsable={false}>
          <RoundButton
            testID="home-hub.customizing.add"
            size="small"
            display="secondary"
            title={t('homeIndex.addWidget')}
            leading={
              <Icon
                name="plus"
                size={ICON_SIZE.xs}
                color={theme.colors.text.primary}
              />
            }
            expanded={props.addOpen}
            onPress={props.onToggleAdd}
          />
        </View>
        <RoundButton
          testID="home-hub.customizing.done"
          size="small"
          title={t('common.done')}
          onPress={props.onDone}
        />
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  // The one tinted surface on the page while customizing: it says what state Home is in.
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: theme.space.s8,
    paddingVertical: theme.space.s6,
    paddingLeft: theme.space.s12,
    paddingRight: theme.space.s6,
    borderRadius: theme.borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.state.active.border,
    backgroundColor: theme.colors.state.active.background,
  },
  words: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    columnGap: theme.space.s8,
    rowGap: theme.space.s2,
    flexGrow: 1,
    flexShrink: 1,
    // Takes the room the actions leave. The hint is the one sentence that teaches the mode, so it is
    // never cut: it moves under the title and wraps when the actions need the room.
    flexBasis: 0,
    minWidth: 160,
  },
  title: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('rowTitle'),
    color: theme.colors.text.primary,
    flexShrink: 0,
  },
  hint: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
    flexShrink: 1,
    minWidth: 0,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    flexShrink: 0,
  },
}));
