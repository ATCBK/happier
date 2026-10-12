/** Interface typography. Transcript, code and terminal text keep their domain scales. */
export type HappierTypeRole = 'display' | 'title' | 'heading' | 'label' | 'reading' | 'body' | 'meta' | 'micro';
export type HappierTypeEmphasis = 'regular' | 'medium' | 'semiBold';
export type HappierTypeScaleStep = Readonly<{
  fontSize: number;
  lineHeight: number;
  weight: HappierTypeEmphasis;
  letterSpacing: number;
  ios?: Readonly<{ fontSize: number; lineHeight: number }>;
}>;

/** One metric owner for app text, plugin text and generated design-lab tokens (scale-roles r1, D3). */
export const HAPPIER_TYPE_SCALE = Object.freeze({
  display: { fontSize: 28, lineHeight: 34, weight: 'semiBold', letterSpacing: -0.56 },
  title: { fontSize: 22, lineHeight: 28, weight: 'semiBold', letterSpacing: -0.4 },
  heading: { fontSize: 15, lineHeight: 20, weight: 'semiBold', letterSpacing: -0.15, ios: { fontSize: 16, lineHeight: 21 } },
  label: { fontSize: 14, lineHeight: 20, weight: 'medium', letterSpacing: 0, ios: { fontSize: 15, lineHeight: 20 } },
  reading: { fontSize: 14, lineHeight: 21, weight: 'regular', letterSpacing: 0, ios: { fontSize: 15, lineHeight: 22 } },
  body: { fontSize: 13, lineHeight: 18, weight: 'regular', letterSpacing: 0, ios: { fontSize: 14, lineHeight: 18 } },
  meta: { fontSize: 12, lineHeight: 16, weight: 'regular', letterSpacing: 0, ios: { fontSize: 13, lineHeight: 16 } },
  micro: { fontSize: 11, lineHeight: 14, weight: 'regular', letterSpacing: 0.05, ios: { fontSize: 12, lineHeight: 14 } },
} as const satisfies Readonly<Record<HappierTypeRole, HappierTypeScaleStep>>);

export const HAPPIER_TYPE_WEIGHT = Object.freeze({ regular: '400', medium: '500', semiBold: '600' } as const);

/** Resolve platform metrics at the consumer boundary; web on an iPhone still uses the web column. */
export function resolveHappierTypeScale(role: HappierTypeRole, platform: string = 'web', emphasis?: HappierTypeEmphasis) {
  const step: HappierTypeScaleStep = HAPPIER_TYPE_SCALE[role];
  return {
    fontSize: platform === 'ios' ? step.ios?.fontSize ?? step.fontSize : step.fontSize,
    lineHeight: platform === 'ios' ? step.ios?.lineHeight ?? step.lineHeight : step.lineHeight,
    weight: emphasis ?? step.weight,
    letterSpacing: step.letterSpacing,
  };
}
