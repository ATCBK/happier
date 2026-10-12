import { parseThemeColor } from '@/theme/parseThemeColor';

export function resolveWebBlurTintColor(params: Readonly<{ surfaceColor: string; dark: boolean }>): string {
    const alpha = params.dark ? 0.20 : 0.25;
    const color = parseThemeColor(params.surfaceColor);
    return color?.alpha(alpha).rgb().string()
        ?? `color-mix(in srgb, ${params.surfaceColor} ${alpha * 100}%, transparent)`;
}

