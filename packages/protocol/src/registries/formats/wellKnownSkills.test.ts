import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { describe, expect, it } from 'vitest';
import { createRegistryHostV1 } from '../registryHostV1.js';
import type { RegistryHttpV1 } from './registryFormatAdapterV1.js';

const markdown = '---\nname: review\ndescription: Review a change\n---\nRead the bundled reference.';
const encode = (text: string) => new TextEncoder().encode(text);
const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const root = 'https://skills.example.invalid/team';
const index = `${root}/.well-known/skills/index.json`;

async function archive(kind: 'zip' | 'tar-gzip', unsafe = false): Promise<Uint8Array> {
  const entries = [{ path: 'SKILL.md', bytes: encode(markdown), mode: 0o644 },
    { path: unsafe ? '../escape.bin' : 'scripts/review.bin', bytes: new Uint8Array([0, 255, 42]), mode: 0o755 }];
  if (kind === 'zip') {
    const writer = new ZipWriter(new Uint8ArrayWriter());
    for (const entry of entries) await writer.add(entry.path, new Uint8ArrayReader(entry.bytes), {
      useWebWorkers: false, externalFileAttributes: ((0o100000 | entry.mode) << 16) >>> 0, msDosCompatible: false,
    });
    return writer.close();
  }
  // A standard ustar fixture: checksum/size/padding are independent of our reader.
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    const header = new Uint8Array(512);
    const field = (offset: number, value: string) => header.set(encode(value), offset);
    field(0, entry.path); field(100, entry.mode.toString(8).padStart(7, '0') + '\0');
    field(124, entry.bytes.length.toString(8).padStart(11, '0') + '\0');
    field(148, '        '); field(156, '0'); field(257, 'ustar\0'); field(263, '00');
    field(148, header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ');
    const content = new Uint8Array(Math.ceil(entry.bytes.length / 512) * 512); content.set(entry.bytes);
    chunks.push(header, content);
  }
  chunks.push(new Uint8Array(1024));
  return gzipSync(Buffer.concat(chunks));
}

function host(content: Uint8Array, options: { unsafeUrl?: boolean; schema?: string; absentDigest?: boolean } = {}) {
  const requests: string[] = [];
  const http: RegistryHttpV1 = {
    getJson: async url => {
      requests.push(url);
      if (url !== index) return { ok: false, status: { state: 'invalid_source' } };
      return { ok: true, fetchedAt: 1, value: { $schema: options.schema ?? 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
        skills: [{ name: 'review', type: 'archive', url: options.unsafeUrl ? 'http://skills.example.invalid/archive.zip' : './review.zip',
          ...(options.absentDigest ? {} : { digest: digest(content) }), futurePresentation: 'ignored' }] } };
    },
    getBytes: async url => {
      requests.push(url);
      return { ok: true, fetchedAt: 1, value: content };
    },
    getText: async () => { throw new Error('Archive reads must preserve binary bytes'); },
  };
  return { requests, registry: createRegistryHostV1({ host: 'node', http, readSources: async () => [] }) };
}

describe('well-known format and integrity boundary', () => {
  it.each(['zip', 'tar-gzip'] as const)('verifies %s bytes, preserves binary and executable files, and rejects unsafe paths', async kind => {
    const f = host(await archive(kind));
    const items = await f.registry.readLinkSkills(root);
    expect(items).toHaveLength(1);
    expect(items[0]!.payload.skill.ref).toMatchObject({ kind: 'wellKnown', indexUrl: index, name: 'review', publishedDigest: expect.stringMatching(/^sha256:/) });
    const files = await f.registry.fetchLinkSkillFiles(root, items[0]!);
    expect(files).toEqual([{ path: 'SKILL.md', unixMode: 0o644, bytes: encode(markdown) },
      { path: 'scripts/review.bin', unixMode: 0o755, bytes: new Uint8Array([0, 255, 42]) }]);
    expect(await host(await archive(kind, true)).registry.readLinkSkills(index)).toEqual([]);
  });

  it('probes preferred then legacy within the requested site scope', async () => {
    const f = host(await archive('zip'), { absentDigest: true });
    const items = await f.registry.readLinkSkills(root);
    expect(items[0]!.payload.skill.ref).not.toHaveProperty('publishedDigest');
    expect(f.requests.slice(0, 2)).toEqual([`${root}/.well-known/agent-skills/index.json`, index]);
    expect(f.requests.every(url => new URL(url).pathname.startsWith('/team/'))).toBe(true);
  });

  it('fails closed for an unknown discovery schema and non-HTTPS artifact URLs', async () => {
    const content = await archive('zip');
    await expect(host(content, { schema: 'https://skills.example.invalid/future' }).registry.readLinkSkills(index)).rejects.toBeDefined();
    expect(await host(content, { unsafeUrl: true }).registry.readLinkSkills(index)).toEqual([]);
  });
});
