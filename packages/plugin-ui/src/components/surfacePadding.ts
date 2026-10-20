/** @internal The Surface insets, for a floating owner that scrolls inside its Surface instead of around it. */
export const SURFACE_PADDING_BY_SIZE: Readonly<Record<'none' | 'small' | 'medium' | 'large', Readonly<{
  horizontal: number;
  vertical: number;
}>>> = Object.freeze({
  none: { horizontal: 0, vertical: 0 },
  small: { horizontal: 12, vertical: 10 },
  medium: { horizontal: 16, vertical: 14 },
  large: { horizontal: 20, vertical: 18 },
});
