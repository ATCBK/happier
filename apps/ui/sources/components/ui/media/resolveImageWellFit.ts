export function resolveImageWellFit(input: Readonly<{
    imageWidth: number;
    imageHeight: number;
    wellWidth: number;
    wellHeight: number;
}>): Readonly<{ width: number; height: number; scale: number; pixelated: boolean }> {
    const { imageWidth, imageHeight, wellWidth, wellHeight } = input;
    if (![imageWidth, imageHeight, wellWidth, wellHeight].every(value => Number.isFinite(value) && value > 0)) {
        return { width: 0, height: 0, scale: 0, pixelated: false };
    }
    const pixelated = imageWidth <= 64 && imageHeight <= 64;
    const availableScale = Math.min(wellWidth / imageWidth, wellHeight / imageHeight);
    const scale = pixelated && availableScale >= 1
        ? Math.min(4, Math.floor(availableScale))
        : Math.min(1, availableScale);
    return { width: imageWidth * scale, height: imageHeight * scale, scale, pixelated };
}
