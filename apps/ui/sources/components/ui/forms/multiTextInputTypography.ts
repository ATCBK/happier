export const MULTI_TEXT_INPUT_BASE_FONT_SIZE = 16;
export const MULTI_TEXT_INPUT_BASE_LINE_HEIGHT = 22;
export const MULTI_TEXT_INPUT_DEFAULT_MAX_HEIGHT = 120;
// Inline-reference anatomy, approved by the composer lab; native drawing consumes these tokens.
export const COMPOSER_REFERENCE_CHIP_HEIGHT = 20;
export const COMPOSER_REFERENCE_CHIP_PHONE_MAX_LABEL_WIDTH = 190;
/** Shared by both native chip renderers; values are logical points before font scaling. */
export const NATIVE_REFERENCE_CHIP_ANATOMY = Object.freeze({
    height: COMPOSER_REFERENCE_CHIP_HEIGHT,
    radius: 6,
    paddingLeft: 4,
    paddingRight: 6,
    glyphSize: 14,
    gap: 4,
    thumbnailRadius: 3,
    maxLabelWidth: COMPOSER_REFERENCE_CHIP_PHONE_MAX_LABEL_WIDTH,
    baseFontSize: MULTI_TEXT_INPUT_BASE_FONT_SIZE,
});
