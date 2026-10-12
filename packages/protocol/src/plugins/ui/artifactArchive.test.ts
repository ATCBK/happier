import { describe, expect, it } from 'vitest';

import {
  computePluginUiArtifactFileSetSha256DigestV1,
  computePluginUiArtifactSha256DigestV1,
} from './artifactIntegrity.js';
import {
  createPluginUiArtifactArchiveV1,
  decodePluginUiArtifactArchiveBodyV1,
  encodePluginUiArtifactArchiveBodyV1,
  openPluginUiArtifactArchiveV1,
} from './artifactArchive.js';

const pluginId = 'com.acme.hosted';
const entryBytes = new TextEncoder().encode('entry');
const assetBytes = new TextEncoder().encode('asset');

function artifactGraph() {
  return {
    artifactId: 'hosted',
    tier: 'hostedWeb' as const,
    entry: 'hosted-web/hosted/index.html',
    files: [
      {
        relativePath: 'hosted-web/hosted/index.html',
        digest: computePluginUiArtifactSha256DigestV1(entryBytes),
        byteSize: entryBytes.byteLength,
      },
      {
        relativePath: 'hosted-web/hosted/assets/icon.svg',
        digest: computePluginUiArtifactSha256DigestV1(assetBytes),
        byteSize: assetBytes.byteLength,
      },
    ],
    digest: computePluginUiArtifactFileSetSha256DigestV1([
      { relativePath: 'hosted-web/hosted/index.html', bytes: entryBytes },
      { relativePath: 'hosted-web/hosted/assets/icon.svg', bytes: assetBytes },
    ]),
    builtWith: { staging: 'staticDirectory' as const },
    hostUiApiRange: '^1.0.0',
  };
}

describe('Plugin UI Artifact archive codec', () => {
  it('round-trips one strict logical file graph and binds it to the expected outer digest', () => {
    const graph = artifactGraph();
    const archive = createPluginUiArtifactArchiveV1({
      pluginId,
      artifactGraph: graph,
      files: [
        { relativePath: 'hosted-web/hosted/index.html', bytes: entryBytes },
        { relativePath: 'hosted-web/hosted/assets/icon.svg', bytes: assetBytes },
      ],
    });
    expect(archive).not.toBeNull();
    if (!archive) throw new Error('Expected archive');

    const decoded = decodePluginUiArtifactArchiveBodyV1(
      encodePluginUiArtifactArchiveBodyV1(archive.body),
    );
    expect(decoded).toEqual(archive.body);

    const opened = openPluginUiArtifactArchiveV1({
      pluginId,
      expectedArtifactDigest: graph.digest,
      header: archive.header,
      body: decoded,
    });
    expect(opened?.artifactGraph).toEqual(graph);
    expect(opened?.files.get('hosted-web/hosted/index.html')).toEqual(entryBytes);
    expect(opened?.files.get('hosted-web/hosted/assets/icon.svg')).toEqual(assetBytes);
    const retainedBody = { ...archive.body, retired: true,
      files: archive.body.files.map(file => ({ ...file, retired: true })) };
    const retainedHeader = { ...archive.header, retired: true, artifactGraph: { ...graph, retired: true,
      files: graph.files.map(file => ({ ...file, retired: true })) } };
    expect(decodePluginUiArtifactArchiveBodyV1(JSON.stringify(retainedBody))).toEqual(archive.body);
    expect(openPluginUiArtifactArchiveV1({ pluginId, expectedArtifactDigest: graph.digest,
      header: retainedHeader, body: retainedBody })).toEqual(opened);
    expect(() => encodePluginUiArtifactArchiveBodyV1(retainedBody)).toThrow();
    expect(openPluginUiArtifactArchiveV1({ pluginId, expectedArtifactDigest: graph.digest,
      header: retainedHeader, body: { ...retainedBody, files: [...retainedBody.files,
        { relativePath: 'hosted-web/extra.js', bytesBase64: 'ZXh0cmE=' }] } })).toBeNull();
  });

  it('fails closed on a tampered file or a different outer link digest', () => {
    const graph = artifactGraph();
    const archive = createPluginUiArtifactArchiveV1({
      pluginId,
      artifactGraph: graph,
      files: [
        { relativePath: 'hosted-web/hosted/index.html', bytes: entryBytes },
        { relativePath: 'hosted-web/hosted/assets/icon.svg', bytes: assetBytes },
      ],
    });
    if (!archive) throw new Error('Expected archive');

    expect(openPluginUiArtifactArchiveV1({
      pluginId,
      expectedArtifactDigest: `sha256:${'f'.repeat(64)}`,
      header: archive.header,
      body: archive.body,
    })).toBeNull();

    expect(openPluginUiArtifactArchiveV1({
      pluginId,
      expectedArtifactDigest: graph.digest,
      header: archive.header,
      body: {
        ...archive.body,
        files: archive.body.files.map((file) => file.relativePath === 'hosted-web/hosted/index.html'
          ? { ...file, bytesBase64: 'dGFtcGVyZWQ=' }
          : file),
      },
    })).toBeNull();
  });
});
