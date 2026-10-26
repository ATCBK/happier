import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import {
  resolveNavigationPlacements,
  type NavigationPlacementPreferences,
} from '@/sync/domains/settings/mobileSurfacePinning';
import { t } from '@/text';

import type { AgentInputPlacementDescriptor } from '../controls/agentInputControlTypes';
import { createActionMenuTriggerChip } from '../definitions/createActionMenuTriggerChip';
import {
  AGENT_INPUT_CHIP_ICON_SIZE_PX,
  AGENT_INPUT_CHIP_ICON_STYLE,
} from '../definitions/agentInputChipIconMetrics';
import { AgentInputChipLabel } from './AgentInputChipLabel';
import { AgentInputSubmitButton } from './AgentInputSubmitButton';
import { AgentInputScrollableChipRow } from '../layout/AgentInputScrollableChipRow';
import { useViewportClass } from '@/utils/platform/useViewportClass';
import {
  AGENT_INPUT_ACTION_CHIP_STYLE,
  resolveAgentInputActionChipTextStyle,
} from './agentInputChromeStyles';

const NOOP = () => {};
const PHONE_ROW_STYLE = { flex: 1, minWidth: 0, overflow: 'hidden' } as const;
const FADE_EDGE = { position: 'absolute', top: 0, bottom: 0, width: 24, zIndex: 2 } as const;
const FADE_LEFT_STYLE = { ...FADE_EDGE, left: 0 } as const;
const FADE_RIGHT_STYLE = { ...FADE_EDGE, right: 0 } as const;
const NO_REF = { current: null };

/**
 * The composer row as a set of placement choices would draw it (calm-shell `cscust` K1 preview): the leading +,
 * the Shown chips in saved order, the Shown field accessories and the trailing send disc, at static props. It
 * resolves through the same pure placement owner as the live row and + menu, reads nothing, writes nothing and
 * subscribes to nothing, so the customizer can show the effect of each choice before it is left.
 */
export const ComposerPlacementPreview = React.memo(
  function ComposerPlacementPreview(
    props: Readonly<{
      descriptors: readonly AgentInputPlacementDescriptor[];
      preferences: NavigationPlacementPreferences;
      testID?: string;
    }>,
  ) {
    const { theme } = useUnistyles();
    const tint = theme.colors.composer.chipTint;
    const textStyle = React.useMemo(
      () => resolveAgentInputActionChipTextStyle(theme),
      [theme],
    );
    const pinned = resolveNavigationPlacements(
      props.descriptors,
      props.preferences,
    ).pinned;
    const chips = pinned.filter((descriptor) => descriptor.slot === 'chip');
    const accessories = pinned.filter(
      (descriptor) => descriptor.slot === 'fieldAccessory',
    );
    const chipStyle = React.useCallback(
      () => AGENT_INPUT_ACTION_CHIP_STYLE,
      [],
    );
    const phone = useViewportClass() === 'compact';
    const phoneRowContentStyle = React.useMemo(
      () => ({ flexDirection: 'row', alignItems: 'center', gap: theme.space.s2 }) as const,
      [theme.space.s2],
    );
    const chipNodes = chips.map((descriptor) => (
      <View
        key={descriptor.id}
        testID={`composer-placement-preview.chip:${descriptor.id}`}
        style={AGENT_INPUT_ACTION_CHIP_STYLE}
      >
        {descriptor.icon ? (
          <Icon
            name={descriptor.icon}
            size={AGENT_INPUT_CHIP_ICON_SIZE_PX}
            color={tint}
            style={AGENT_INPUT_CHIP_ICON_STYLE}
          />
        ) : null}
        <AgentInputChipLabel label={descriptor.title} textStyle={textStyle} />
      </View>
    ));
    return (
      <View
        testID={props.testID ?? 'composer-placement-preview'}
        accessibilityLabel={t('navigationPlacement.preview')}
        // A picture of the row, not a second set of controls: assistive tech reads the list below it.
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
        // The picture takes no presses; a phone's one-line row still scrolls under the finger.
        pointerEvents={phone ? 'box-none' : 'none'}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          // The scrolling chip row ends in an edge fade; the accessories after it need room of their own.
          gap: phone ? theme.space.s8 : theme.space.s2,
          padding: theme.space.s8,
          borderRadius: theme.parts.composer.radius,
          backgroundColor: theme.colors.surface.selected,
          overflow: 'hidden',
        }}
      >
        {createActionMenuTriggerChip({
          anchorRef: NO_REF,
          tint,
          chipStyle,
          open: true,
          openStyle: { backgroundColor: theme.colors.surface.selected },
          onPress: NOOP,
        })}
        {phone ? (
          // A phone draws the real composer row (ACCEPT-OPUS): one line that scrolls sideways, through the
          // live row's own scroller and edge fades, rather than a wrapped block a third of the sheet tall.
          <AgentInputScrollableChipRow
            fadeColor={theme.colors.surface.selected}
            indicatorColor={tint}
            containerStyle={PHONE_ROW_STYLE}
            contentStyle={phoneRowContentStyle}
            fadeLeftStyle={FADE_LEFT_STYLE}
            fadeRightStyle={FADE_RIGHT_STYLE}
          >
            {chipNodes}
          </AgentInputScrollableChipRow>
        ) : (
        // A wide preview has room for every Shown chip; they wrap, as the live row does in its default flow.
        <View
          style={{
            flex: 1,
            minWidth: 0,
            flexDirection: 'row',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: theme.space.s2,
          }}
        >
          {chipNodes}
        </View>
        )}
        {accessories.map((descriptor) =>
          descriptor.icon ? (
            <View
              key={descriptor.id}
              testID={`composer-placement-preview.accessory:${descriptor.id}`}
              style={{ padding: theme.space.s6 }}
            >
              <Icon
                name={descriptor.icon}
                size={AGENT_INPUT_CHIP_ICON_SIZE_PX}
                color={theme.colors.text.secondary}
              />
            </View>
          ) : null,
        )}
        <AgentInputSubmitButton
          testID="composer-placement-preview.send"
          disabled
          hasSendableContent={false}
          dictationStatus="idle"
          onSend={NOOP}
        />
      </View>
    );
  },
);
