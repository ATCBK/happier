import { expect, it } from 'vitest';
import { prepareArtifactHeaderForRevisionV1 } from './artifactHeaderRestorationV1.js';
import { readArtifactPublicNetworkPolicyV1 } from './artifactPublicNetworkPolicyV1.js';
import { ArtifactHtmlBundleV1Schema } from './artifactHtmlV1.js';
import { WidgetDefinitionV1Schema } from '../widgets/widgetDefinitionV1.js';
import { RoleArtifactV1Schema } from '../prompts/roles/roleArtifactV1.js';
import { AIBackendProfileSchema } from '../profiles/backendProfileSchema.js';
import { LaunchProfileArtifactV1Schema } from '../launchProfiles/launchProfileArtifactV1.js';

it('restores retained role revisions through the canonical stored body projection', () => {
  const canonical = { name: 'Role', instructions: 'Do the work', runsAs: { kind: 'session' },
    workspaceWrites: 'deny', secondOpinion: 'off', enabled: true };
  expect(RoleArtifactV1Schema.parse(canonical)).toEqual(canonical);
  const body = { ...canonical, runsAs: { ...canonical.runsAs, retired: true }, retired: true };
  const input = { artifactId: 'role', header: { kind: 'role.v1', name: 'Old name' }, body: JSON.stringify(body),
    expectedRevision: { headerVersion: 2, bodyVersion: 2 }, nextRevision: { headerVersion: 3, bodyVersion: 3 } };
  expect(prepareArtifactHeaderForRevisionV1(input)).toEqual({ kind: 'role.v1', name: 'Role' });
  expect(() => prepareArtifactHeaderForRevisionV1({ ...input, body: JSON.stringify({ ...body, enabled: 'true' }) }))
    .toThrow();
  expect(RoleArtifactV1Schema.safeParse(body).success).toBe(false);
});

it('restores an annotated retained LaunchProfile through its registered profile read owner', () => {
  const canonical = LaunchProfileArtifactV1Schema.parse({ kind: 'launch-profile.v1',
    profile: AIBackendProfileSchema.parse({ id: 'profile', name: 'Profile' }), secretBindings: {} });
  const retained = { ...canonical, retired: true, profile: { ...canonical.profile, retired: true } };
  const input = { artifactId: 'profile-artifact', header: { kind: 'launch-profile.v1' }, body: JSON.stringify(retained),
    expectedRevision: { headerVersion: 2, bodyVersion: 2 }, nextRevision: { headerVersion: 3, bodyVersion: 3 } };
  expect(prepareArtifactHeaderForRevisionV1(input)).toEqual({ kind: 'launch-profile.v1',
    profileId: 'profile', name: 'Profile', title: 'Profile' });
  expect(LaunchProfileArtifactV1Schema.safeParse(retained).success).toBe(false);
  expect(() => prepareArtifactHeaderForRevisionV1({ ...input,
    body: JSON.stringify({ ...retained, profile: { ...retained.profile, id: '' } }) })).toThrow();
});

it('reads a retained Widget network policy without weakening authored definitions', () => {
  const bundle = ArtifactHtmlBundleV1Schema.parse({ v: 1, entrypoint: 'index.html',
    files: { 'index.html': { mime: 'text/html', contentBase64: 'PGgxPkhlbGxvPC9oMT4=' } } });
  const definition = { v: 1, id: 'visual', name: 'Saved HTML', sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
    body: { kind: 'html', source: bundle, requestedCapabilities: { network: 'open' } },
    inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false },
    provenance: { source: { kind: 'authored' } } };
  const resource = { artifactId: 'visual', header: { kind: 'widget-definition.v1', v: 1 } };
  expect(readArtifactPublicNetworkPolicyV1({ ...resource, body: JSON.stringify(definition) }))
    .toEqual({ network: 'open', networkOrigins: [] });
  const retained = { ...definition, retired: true,
    sizeDeclaration: { ...definition.sizeDeclaration, retired: true } };
  expect(readArtifactPublicNetworkPolicyV1({ ...resource, body: JSON.stringify(retained) }))
    .toEqual({ network: 'open', networkOrigins: [] });
  expect(WidgetDefinitionV1Schema.safeParse(retained).success).toBe(false);
  expect(readArtifactPublicNetworkPolicyV1({ ...resource, artifactId: 'other', body: JSON.stringify(retained) }))
    .toEqual({ network: 'none', networkOrigins: [] });
});
