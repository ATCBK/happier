export type KeyboardAvoidanceClampInput = Readonly<{
    value: number;
    min?: number;
    max: number;
}>;

export type ComposerBottomOffsetInput = Readonly<{
    keyboardHeight: number;
    safeAreaBottom: number;
}>;

export type ListBottomInsetInput = Readonly<{
    composerHeight: number;
    keyboardHeightForInset: number;
    safeAreaBottom: number;
}>;

export type AvailablePanelHeightInput = Readonly<{
    viewportHeight: number;
    headerHeight?: number;
    keyboardHeight?: number;
    safeAreaBottom?: number;
    reservedHeight?: number;
    preferredHeight?: number;
    minHeight?: number;
    maxHeight?: number;
}>;

function normalizeNonNegativeNumber(value: number | null | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return 0;
    }
    return Math.max(0, Math.abs(value));
}

export function normalizeKeyboardEventHeight(height: number): number {
    return normalizeNonNegativeNumber(height);
}

export function normalizeReanimatedKeyboardHeight(height: number): number {
    return normalizeNonNegativeNumber(height);
}

export function clampKeyboardAvoidanceValue({ value, min = 0, max }: KeyboardAvoidanceClampInput): number {
    const normalizedMax = normalizeNonNegativeNumber(max);
    const effectiveMin = Math.min(normalizeNonNegativeNumber(min), normalizedMax);
    const normalizedValue = typeof value === 'number' && Number.isFinite(value) ? value : effectiveMin;

    return Math.min(Math.max(normalizedValue, effectiveMin), normalizedMax);
}

/**
 * How far a keyboard rises inside a scaffold that already sits above `layoutBottomInset` of bottom
 * chrome (the tab bar's reservation). The keyboard covers that chrome first, so only the remainder
 * lifts the composer — one rule for native and web, or the composer floats a tab bar's height over
 * the keyboard on one platform and every overlay placed from the shared rule overlaps it (R9).
 */
export function resolveKeyboardHeightWithinScaffold(keyboardHeight: number, layoutBottomInset: number): number {
    'worklet';
    return Math.max(0, keyboardHeight - Math.max(0, layoutBottomInset));
}

export function resolveComposerBottomOffset({ keyboardHeight, safeAreaBottom }: ComposerBottomOffsetInput): number {
    return Math.max(normalizeNonNegativeNumber(keyboardHeight), normalizeNonNegativeNumber(safeAreaBottom));
}

export function resolveListBottomInset({
    composerHeight,
    keyboardHeightForInset,
    safeAreaBottom,
}: ListBottomInsetInput): number {
    return normalizeNonNegativeNumber(composerHeight)
        + resolveComposerBottomOffset({ keyboardHeight: keyboardHeightForInset, safeAreaBottom });
}

export function resolveAvailablePanelHeight({
    viewportHeight,
    headerHeight = 0,
    keyboardHeight = 0,
    safeAreaBottom = 0,
    reservedHeight = 0,
    preferredHeight,
    minHeight = 0,
    maxHeight,
}: AvailablePanelHeightInput): number {
    const keyboardOffset = resolveComposerBottomOffset({ keyboardHeight, safeAreaBottom });
    const visibleRegion = Math.max(
        0,
        normalizeNonNegativeNumber(viewportHeight)
            - normalizeNonNegativeNumber(headerHeight)
            - keyboardOffset
            - normalizeNonNegativeNumber(reservedHeight),
    );
    const effectiveMax = Math.min(normalizeNonNegativeNumber(maxHeight ?? visibleRegion), visibleRegion);

    return clampKeyboardAvoidanceValue({
        value: preferredHeight ?? effectiveMax,
        min: minHeight,
        max: effectiveMax,
    });
}
