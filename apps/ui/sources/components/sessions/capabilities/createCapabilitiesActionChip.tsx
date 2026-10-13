import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { AgentInputPopoverContent } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { AgentInputChipLabel } from '@/components/sessions/agentInput/components/AgentInputChipLabel';
import {
  AGENT_INPUT_CHIP_ICON_SIZE_PX,
  AGENT_INPUT_CHIP_ICON_STYLE,
  AGENT_INPUT_MENU_ICON_SIZE_PX,
} from '@/components/sessions/agentInput/definitions/agentInputChipIconMetrics';
import { Icon } from '@/components/ui/icons/Icon';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { t } from '@/text';

export const SESSION_CAPABILITIES_CHIP_KEY = 'session-capabilities';
/** The lab popover's width: the menu grid (name | scope | action) stays in its wide form on desktop. */
export const SESSION_CAPABILITIES_POPOVER_WIDTH_PX = 520;
/** The popover caps at this share of the window; its body scrolls under the fixed add field and footer (lab §12). */
export const SESSION_CAPABILITIES_POPOVER_HEIGHT_RATIO = 0.7;
const CHIP_GLYPH = 'stack' as const;

function AttentionDot() {
  const { theme } = useUnistyles();
  return <StatusDot color={theme.colors.state.warning.foreground} size={6} />;
}

/**
 * The composer chip for "This session gets" (draft, existing session, workflow and trigger authoring):
 * "6 skills · 7 MCP" with the amber dot when a row needs the person, opening the shared content popover
 * (a bottom sheet on a phone). The content is `SessionCapabilitiesContent`, rendered by the caller.
 */
export function createCapabilitiesActionChip(
  params: Readonly<{
    label: string;
    attention: boolean;
    stabilityKey: string;
    popoverContent: AgentInputPopoverContent;
    /** The one demand signal: hover, press-in, focus and overflow all route through it. */
    onIntent?: () => void;
    maxHeightCap?: number;
  }>,
): AgentInputExtraActionChip {
  const title = t('capabilities.session.sheet.title');
  return {
    key: SESSION_CAPABILITIES_CHIP_KEY,
    onIntent: params.onIntent,
    stabilityKey: `${params.stabilityKey}:${params.label}:${params.attention ? 1 : 0}`,
    // PD1 renames this control id to 'capabilities' when Lane 12 Main mounts the chip (C6).
    controlId: 'mcp',
    collapsedContentPopover: {
      title,
      label: params.label,
      icon: (tint: string) =>
        normalizeNodeForView(
          <Icon
            name={CHIP_GLYPH}
            size={AGENT_INPUT_MENU_ICON_SIZE_PX}
            color={tint}
          />,
        ),
      renderContent: params.popoverContent,
      header: { title },
      phonePresentation: 'sheet',
      // The content scrolls its own body under a fixed add field and footer.
      scrollEnabled: false,
      keyboardShouldPersistTaps: 'handled',
      maxHeightCap: params.maxHeightCap,
      maxWidthCap: SESSION_CAPABILITIES_POPOVER_WIDTH_PX,
    },
    render: ({
      chipStyle,
      iconColor,
      showLabel,
      textStyle,
      countTextStyle,
      chipAnchorRef,
      toggleCollapsedPopover,
    }) => (
      <Pressable
        ref={chipAnchorRef}
        testID="session-capabilities-chip"
        accessibilityRole="button"
        accessibilityLabel={`${title}: ${params.label}`}
        onPress={() => toggleCollapsedPopover?.(SESSION_CAPABILITIES_CHIP_KEY)}
        onHoverIn={params.onIntent}
        onPressIn={params.onIntent}
        onFocus={params.onIntent}
        hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
        style={(pressed) => chipStyle(pressed.pressed)}
      >
        {normalizeNodeForView(
          <Icon
            name={CHIP_GLYPH}
            size={AGENT_INPUT_CHIP_ICON_SIZE_PX}
            color={iconColor}
            style={AGENT_INPUT_CHIP_ICON_STYLE}
          />,
        )}
        {showLabel ? (
          <AgentInputChipLabel
            label={params.label}
            textStyle={[textStyle, { fontVariant: ['tabular-nums'] }]}
            countTextStyle={countTextStyle}
          />
        ) : null}
        {params.attention ? (
          <View testID="session-capabilities-chip:attention">
            <AttentionDot />
          </View>
        ) : null}
      </Pressable>
    ),
  };
}
