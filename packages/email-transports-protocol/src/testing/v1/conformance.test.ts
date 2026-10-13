import { definePlugin } from '@happier-dev/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { EmailTransportsContributionProtocolV1 as protocol } from '../../v1/index.js';
import { assertEmailTransportContributionV1, checkEmailTransportContributionV1 } from './index.js';

function externalTransport() {
  const operation = (role: keyof typeof protocol.operations) => {
    const declaration = protocol.operations[role].declaration;
    return {
      title: role, surfaces: declaration.surfaces, dangerLevel: declaration.dangerLevel,
      inputSchema: declaration.input.schema.jsonSchema, resultSchema: declaration.resultSchema.jsonSchema,
      run: async () => null,
    };
  };
  const contribution = protocol.contribute({ operations: {
    listSince: protocol.operations.listSince.bind('author/list'),
    fetchRaw: protocol.operations.fetchRaw.bind('author/fetch'),
    submitRaw: protocol.operations.submitRaw.bind('author/send'),
    connectionTest: protocol.operations.connectionTest.bind('author/check'),
  } });
  return definePlugin({
    id: 'example.mail-transport', version: '1.0.0',
    actions: {
      'author/list': operation('listSince'), 'author/fetch': operation('fetchRaw'),
      'author/send': operation('submitRaw'), 'author/check': operation('connectionTest'),
    },
    contributesTo: { 'happier.channel.email': { transports: { primary: contribution, secondary: contribution } } },
  }).manifest;
}

function mutableManifest() {
  // Serialized author declarations are the external system boundary under test.
  return JSON.parse(JSON.stringify(externalTransport())) as {
    contributes: {
      actions: { id: string; inputSchema: unknown; resultSchema: unknown; surfaces: string[]; dangerLevel: string }[];
      targetedPluginContributions: { protocol: { version: number }; operations: Record<string, string> }[];
    };
  };
}

describe('public email transport declarative conformance', () => {
  it('accepts arbitrary Action ids, optional findSent omission, and several transports from one plugin', () => {
    expect(assertEmailTransportContributionV1(externalTransport()).contributions).toHaveLength(2);
  });

  it('checks every contributed transport for missing required role bindings', () => {
    const manifest = mutableManifest();
    delete manifest.contributes.targetedPluginContributions[1]!.operations.submitRaw;
    expect(checkEmailTransportContributionV1(manifest).ok).toBe(false);
  });

  it.each(['inputSchema', 'resultSchema', 'surfaces', 'dangerLevel'] as const)('rejects incompatible Action %s', field => {
    const manifest = mutableManifest();
    const send = manifest.contributes.actions.find(action => action.id === 'author/send')!;
    if (field === 'surfaces') send.surfaces = ['ui'];
    else if (field === 'dangerLevel') send.dangerLevel = 'safe';
    else send[field] = { type: 'null' };
    expect(checkEmailTransportContributionV1(manifest).ok).toBe(false);
  });

  it('accepts a safe transport Action with the required plugin surface and an additional CLI surface', () => {
    const manifest = mutableManifest();
    manifest.contributes.actions.find(action => action.id === 'author/fetch')!.surfaces = ['plugin', 'cli'];
    expect(checkEmailTransportContributionV1(manifest).ok).toBe(true);
  });

  it('rejects malformed caller surfaces through the public manifest parser', () => {
    const manifest = mutableManifest();
    manifest.contributes.actions.find(action => action.id === 'author/fetch')!.surfaces = ['plugin', 'unknown'];
    expect(checkEmailTransportContributionV1(manifest).ok).toBe(false);
  });

  it('rejects a different wire epoch', () => {
    const manifest = mutableManifest();
    manifest.contributes.targetedPluginContributions[0]!.protocol.version = 2;
    expect(checkEmailTransportContributionV1(manifest).ok).toBe(false);
  });
});
