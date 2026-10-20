/**
 * Converts an installed model pack's directory URI (`packDirUri` from the installer) into the filesystem path
 * native speech engines take as `assetsDir`. Every caller must use this so one pack maps to one native engine
 * cache key, which `release` relies on.
 */
export function modelPackDirUriToNativePath(dirUri: string): string {
  return dirUri.startsWith('file://') ? dirUri.slice('file://'.length) : dirUri;
}
