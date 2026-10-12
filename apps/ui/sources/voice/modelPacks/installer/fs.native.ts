import type { InstallerFs, InstallerOverrides } from './types';

export async function getFs(overrides: InstallerOverrides): Promise<InstallerFs> {
  if (overrides.fs) return overrides.fs;
  const fs = await import('expo-file-system');
  return fs as any;
}

// React Native's global fetch exposes no streaming `response.body`, so model files would be buffered
// whole in the JS heap; `expo/fetch` streams natively.
const streamingFetch: typeof fetch = async (input, init) => {
  const { fetch: expoFetch } = await import('expo/fetch');
  // Boundary cast: expo's FetchResponse implements the Response members the installer uses.
  return (await expoFetch(String(input), init as Parameters<typeof expoFetch>[1])) as unknown as Response;
};

export function getFetch(overrides: InstallerOverrides): typeof fetch {
  return overrides.fetch ?? streamingFetch;
}
