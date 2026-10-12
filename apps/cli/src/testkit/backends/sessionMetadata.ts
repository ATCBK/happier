import { readPreferredHostName } from '@happier-dev/cli-common/process';

import type { Metadata } from '@/api/types';

export function createTestMetadata(overrides?: Partial<Metadata>): Metadata {
  return {
    path: '/tmp/project',
    host: 'test-host',
    homeDir: '/tmp',
    happyHomeDir: '/tmp/.happy',
    happyLibDir: '/tmp/.happy/lib',
    happyToolsDir: '/tmp/.happy/tools',
    flavor: 'codex',
    ...overrides,
  };
}

/** Session locality on this test worker, rather than the generic foreign host. */
export async function createLocalTestMetadata(overrides?: Partial<Metadata>): Promise<Metadata> {
  return createTestMetadata({ host: await readPreferredHostName(), ...overrides });
}
