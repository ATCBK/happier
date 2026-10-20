import type { InstallerFs, InstallerOverrides } from './types';

export async function getFs(overrides: InstallerOverrides): Promise<InstallerFs> {
  if (overrides.fs) return overrides.fs;
  const fs = await import('expo-file-system');
  // The fixture constructor seam accepts unknown inputs; real host callers supply
  // URI strings or native File/Directory instances accepted by the Expo constructors.
  return fs as unknown as InstallerFs;
}

export function getFetch(overrides: InstallerOverrides): typeof fetch {
  return overrides.fetch ?? fetch;
}

