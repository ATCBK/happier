import { parseThemeColor } from '@/theme/parseThemeColor';

import { shadowLevelStyle, type ShadowElevationToken } from "@/shadowElevation";
import { motionTokens } from '@/components/ui/motion/motionTokens';

export const AGENT_INPUT_CHIP_PICKER_OPTION_ICON_SIZE = 16;
export const AGENT_INPUT_CHIP_PICKER_OPTION_ROW_RADIUS = 12;

type AgentInputChipPickerOptionStyleTheme = Readonly<{
    colors: Readonly<{
        shadowLevels: Readonly<Record<1, ShadowElevationToken>>;
        surface: Readonly<{
            base: string;
            pressed: string;
        }>;
    }>;
}>;

export type AgentInputChipPickerOptionTransientStyles = Readonly<{
    optionRowFocused: Readonly<Record<string, unknown>>;
    optionRowHovered: Readonly<{
        backgroundColor: string;
    }>;
    optionRowPressed: Readonly<{
        opacity: number;
    }>;
    optionRowDisabled: Readonly<{
        opacity: number;
    }>;
}>;

export function createAgentInputChipPickerOptionTransientStyles(
    theme: AgentInputChipPickerOptionStyleTheme,
): AgentInputChipPickerOptionTransientStyles {
    return {
        optionRowFocused: {
            backgroundColor: theme.colors.surface.base,
            ...shadowLevelStyle(theme.colors.shadowLevels[1]),
        },
        optionRowHovered: {
            backgroundColor: parseThemeColor(theme.colors.surface.base)?.alpha(0.8).rgb().string()
                ?? theme.colors.surface.pressed,
        },
        optionRowPressed: {
            opacity: motionTokens.press.opacitySubtle,
        },
        optionRowDisabled: {
            opacity: 0.45,
        },
    };
}
