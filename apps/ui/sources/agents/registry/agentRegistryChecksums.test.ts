import { describe, expect, it } from 'vitest';
import { AcpRegistryAgentV1Schema } from '@happier-dev/protocol/registries';
import { areAgentRegistryChecksumsPublished } from './agentRegistryChecksums';

const assets = AcpRegistryAgentV1Schema.parse({
  id: 'review', name: 'Review', version: '1.0', description: 'A coding agent.',
  distributions: { binary: {
    'linux-x64': { archiveUrl: 'https://registry.example.test/review-linux.tar.gz', command: './review', args: [], env: {}, sha256: 'a'.repeat(64) },
    'darwin-arm64': { archiveUrl: 'https://registry.example.test/review-mac.tar.gz', command: './review', args: [], env: {} },
  } },
}).distributions.binary!;

describe('registry checksum summary', () => {
  it('requires a digest on every relevant build and falls back to every published build', () => {
    expect(areAgentRegistryChecksumsPublished(assets, ['linux-x64'])).toBe(true);
    expect(areAgentRegistryChecksumsPublished(assets, ['linux-x64', 'darwin-arm64'])).toBe(false);
    expect(areAgentRegistryChecksumsPublished(assets)).toBe(false);
    expect(areAgentRegistryChecksumsPublished({ 'linux-x64': assets['linux-x64'] })).toBe(true);
  });

  it('never claims verification when no build or digest is published', () => {
    expect(areAgentRegistryChecksumsPublished({})).toBe(false);
    expect(areAgentRegistryChecksumsPublished({ 'darwin-arm64': assets['darwin-arm64'] })).toBe(false);
  });
});
