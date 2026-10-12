import { Platform } from 'react-native';

/**
 * Whether the primary pointer can hover (a mouse or trackpad on the web). Native and touch-first browsers
 * answer false. Read per render (one media query), so the page's own environment decides.
 */
export function hasHappierPrecisePointer(): boolean {
  const match = (globalThis as { matchMedia?: (query: string) => { matches: boolean } }).matchMedia;
  return Platform.OS === 'web' && typeof match === 'function' && match('(hover: hover) and (pointer: fine)').matches;
}
