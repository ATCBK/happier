/**
 * Whether a picture of this content type can carry transparency, so the checkerboard has something to
 * show. The one decision every picture presentation shares; JPEG and BMP have no alpha and stay plain.
 */
export function isHappierAlphaCapableImageMimeType(mimeType: string | null | undefined): boolean {
  switch (mimeType?.split(';', 1)[0]?.trim().toLowerCase()) {
    case 'image/png':
    case 'image/gif':
    case 'image/webp':
    case 'image/avif':
    case 'image/svg+xml':
    case 'image/x-icon':
      return true;
    default:
      return false;
  }
}
