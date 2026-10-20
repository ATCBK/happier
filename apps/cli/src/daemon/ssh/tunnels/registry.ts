import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod/mini';

import type { SshTunnelRegistry, SshTunnelRegistryEntry } from './types';

const RegistryEntrySchema = z.object({
  tunnelKey: z.string().check(z.minLength(1)),
  controlPath: z.string().check(z.minLength(1)),
  localPort: z.number().check(z.int(), z.minimum(1), z.maximum(65_535)),
  remoteHost: z.string().check(z.minLength(1)),
  remotePort: z.number().check(z.int(), z.minimum(1), z.maximum(65_535)),
  ownerPid: z.number().check(z.int(), z.minimum(1)),
  createdAt: z.string().check(z.iso.datetime()),
  lastProbeAt: z.string().check(z.iso.datetime()),
  purpose: z.enum(['remote-host-access', 'relay-access-local-bridge', 'bootstrap', 'diagnostic']),
  remoteHostId: z.optional(z.string().check(z.minLength(1))),
  httpBaseUrl: z.string().check(z.url()),
  wsBaseUrl: z.optional(z.string().check(z.url())),
  sshTarget: z.optional(z.string().check(z.minLength(1))),
  sshPort: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(65_535))),
  sshConfigFile: z.optional(z.string().check(z.minLength(1))),
  knownHostsPath: z.optional(z.string().check(z.minLength(1))),
});

const RegistryFileSchema = z.object({
  entries: z.array(RegistryEntrySchema),
});

export function createSshTunnelRegistry(params: Readonly<{ registryPath: string }>): SshTunnelRegistry {
  return {
    async read(): Promise<readonly SshTunnelRegistryEntry[]> {
      try {
        const raw = await readFile(params.registryPath, 'utf8');
        const parsed = RegistryFileSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data.entries : [];
      } catch {
        return [];
      }
    },
    async write(entries: readonly SshTunnelRegistryEntry[]): Promise<void> {
      await mkdir(dirname(params.registryPath), { recursive: true });
      await writeFile(params.registryPath, `${JSON.stringify({ entries }, null, 2)}\n`, 'utf8');
    },
  };
}
