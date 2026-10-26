import { Platform, processColor } from 'react-native';

/**
 * Native SVG replaces stopColor's alpha with stopOpacity. Keep the platform's color parser,
 * separating its ARGB result and multiplying an authored fade exactly once. Web keeps CSS colors.
 */
export function happierSvgGradientStop(color: string, opacity = 1): Readonly<{ stopColor: string; stopOpacity: number }> {
  if (Platform.OS === 'web') return { stopColor: color, stopOpacity: opacity };
  const argb = processColor(color);
  // Preserve the SVG SDK's own handling/diagnostic for an unresolved or invalid platform color.
  if (typeof argb !== 'number') return { stopColor: color, stopOpacity: opacity };
  return {
    stopColor: `rgb(${(argb >>> 16) & 255}, ${(argb >>> 8) & 255}, ${argb & 255})`,
    stopOpacity: (argb >>> 24) / 255 * opacity,
  };
}
