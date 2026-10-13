import { Typography } from '@/constants/Typography';
import * as React from "react";
import { Pressable, View } from 'react-native';
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { Text } from "@/components/ui/text/Text";
import { t } from "@/text";
import { Icon } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion/motionTokens';

export type AgentInputSessionModeOption = Readonly<{
  id: string;
  name: string;
  description?: string;
}>;

type AgentInputSessionModeSectionProps = Readonly<{
  options: ReadonlyArray<AgentInputSessionModeOption>;
  selectedOptionId: string;
  summary?: React.ReactNode;
  headerAccessory?: React.ReactNode;
  onSelectOption?: (optionId: string) => void;
}>;

export function AgentInputSessionModeSection(
  props: AgentInputSessionModeSectionProps,
) {
  const { theme } = useUnistyles();
  const selectedIndicatorColor = theme.dark ? theme.colors.text.primary : theme.colors.button.primary.background;

  if (props.options.length === 0) {
    return null;
  }

  return (
    <View style={styles.section}>
      <View style={styles.headerRow}>
        <Text style={styles.sectionTitle}>
          {t("agentInput.mode.sectionTitle")}
        </Text>
        {props.headerAccessory ? (
          <View style={styles.headerAccessory}>{props.headerAccessory}</View>
        ) : null}
      </View>

      {props.summary ? (
        <View
          style={styles.summaryRow}
          testID="agent-input-session-mode-summary"
        >
          {typeof props.summary === "string" ? (
            <Text style={styles.summaryText}>{props.summary}</Text>
          ) : (
            props.summary
          )}
        </View>
      ) : null}

      <View style={styles.cardsGrid}>
        {props.options.map((option) => {
          const selected = props.selectedOptionId === option.id;
          const hasDescription =
            typeof option.description === "string" &&
            option.description.trim().length > 0;

          return (
            <Pressable
              key={option.id}
              testID={`agent-input-session-mode-option:${option.id}`}
              accessibilityRole="radio"
              accessibilityLabel={option.name}
              accessibilityState={{ selected }}
              onPress={() => props.onSelectOption?.(option.id)}
              style={({ pressed }) => [
                styles.optionCard,
                props.options.length === 1 ? styles.optionCardFullWidth : null,
                selected ? styles.optionCardSelected : null,
                pressed ? styles.optionCardPressed : null,
              ]}
            >
              <View style={styles.optionCardHeader}>
                <Text
                  numberOfLines={hasDescription ? 2 : 1}
                  style={styles.optionCardTitle}
                >
                  {option.name}
                </Text>
                <View style={styles.optionCardIndicator}>
                  {selected ? (
                    <Icon
                      name="check-circle"
                      size={16}
                      color={selectedIndicatorColor}
                    />
                  ) : null}
                </View>
              </View>
              {hasDescription ? (
                <Text style={styles.optionCardDescription}>
                  {option.description}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    gap: theme.space.s4,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.space.s8,
  },
  headerAccessory: {
    flexShrink: 0,
  },
  sectionTitle: {
    ...Typography.variant('micro', 'semiBold'),
    color: theme.colors.text.secondary,
  },
  summaryRow: {
    minHeight: 0,
  },
  summaryText: {
    ...Typography.variant('micro'),
    color: theme.colors.text.secondary,
  },
  cardsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.space.s4,
  },
  optionCard: {
    width: "48.5%",
    minHeight: 52,
    borderRadius: 13,
    paddingHorizontal: theme.space.s8,
    paddingVertical: theme.space.s6,
    backgroundColor: theme.colors.surface.base,
    gap: theme.space.s2,
  },
  optionCardFullWidth: {
    width: "100%",
  },
  optionCardSelected: {
    backgroundColor: theme.colors.surface.pressed,
  },
  optionCardPressed: {
    opacity: motionTokens.press.opacitySubtle,
  },
  optionCardHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.space.s4,
  },
  optionCardTitle: {
    flex: 1,
    ...Typography.variant('micro', 'semiBold'),
    color: theme.colors.text.primary,
  },
  optionCardIndicator: {
    minWidth: 16,
    minHeight: 16,
    alignItems: "flex-end",
    justifyContent: "flex-start",
  },
  optionCardDescription: {
    ...Typography.variant('micro'),
    color: theme.colors.text.secondary,
  },
}));
