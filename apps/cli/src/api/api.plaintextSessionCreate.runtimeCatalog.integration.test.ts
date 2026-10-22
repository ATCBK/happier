import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
  deriveSessionCreationTagV1,
  SessionCreationCorrespondenceV1Schema,
} from '@happier-dev/protocol';

import { ApiClient } from './api';
import type { Metadata } from './types';
import { decodeBase64, decrypt } from './encryption';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { resolveSessionCreateEncryptionMode } from './session/resolveSessionCreateEncryptionMode';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';

const mockPost = vi.fn();
const mockGet = vi.fn();

function serverFeaturesResponse(capabilities: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ features: {}, capabilities }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

vi.mock('axios', () => ({
  default: {
    post: (...args: any[]) => mockPost(...args),
    get: (...args: any[]) => mockGet(...args),
    isAxiosError: (value: unknown) =>
      Boolean(
        value
        && typeof value === 'object'
        && (value as { isAxiosError?: unknown }).isAxiosError,
      ),
  },
  isAxiosError: (value: unknown) =>
    Boolean(
      value
      && typeof value === 'object'
      && (value as { isAxiosError?: unknown }).isAxiosError,
    ),
}));

vi.mock('@/configuration', () => ({
  configuration: {
    serverUrl: 'https://api.example.com',
    apiServerUrl: 'https://api.example.com',
    currentCliVersion: '0.0.0-test',
  },
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

describe('ApiClient.getOrCreateSession (plaintext sessions)', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  beforeEach(() => {
    resetServerFeaturesClientForTests();
    mockPost.mockReset();
    mockGet.mockReset();
    mockGet.mockResolvedValue({
      status: 200,
      data: {
        mode: 'plain',
        version: 1,
        signingKeyFingerprint: null,
        contentKeyFingerprint: null,
        updatedAt: 1,
        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
      },
    });
    vi.unstubAllGlobals();
  });

  it.each([200, 503])('overlaps independent creation preflights without bypassing Account admission (%s)', async status => {
    let releaseFeatures!: () => void;
    const features = new Promise<void>(resolve => { releaseFeatures = resolve; });
    let featureRequests = 0;
    let accountRequests = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      featureRequests += 1;
      await features;
      return serverFeaturesResponse({ encryption: {
        storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain',
      } });
    }));
    mockGet.mockImplementation(async () => {
      accountRequests += 1;
      return { status, data: status === 200 ? {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null,
        updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
      } : {} };
    });
    const pending = resolveSessionCreateEncryptionMode({ token: 'token-test', serverBaseUrl: 'https://api.example.com' });
    try {
      await vi.waitFor(() => expect(accountRequests).toBe(1));
      expect(featureRequests).toBe(1);
    } finally {
      releaseFeatures();
    }
    expect(await pending).toMatchObject(status === 200
      ? { status: 'resolved', desiredSessionEncryptionMode: 'plain', storagePolicy: 'optional' }
      : { status: 'currentness_unavailable' });
    expect(accountRequests).toBe(1);
    expect(featureRequests).toBe(1);
  });

  it('sends plaintext metadata when server policy is plaintext_only', async () => {
    const credential = {
      token: 'token-test',
      encryption: null,
    };

    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : String((input as any)?.url ?? input);
      if (url.endsWith('/v1/features')) {
        return serverFeaturesResponse({
              accountStoredContentCompatibility: {
                v: 1,
                minimumProtocolVersion: 2,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                declarationTransport: 'http-header-and-socket-auth-v1',
              },
              encryption: {
                storagePolicy: 'plaintext_only',
                allowAccountOptOut: false,
                defaultAccountMode: 'e2ee',
              },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as any);


    mockPost.mockImplementation(async (_url: string, body: any) => {
      expect(body.encryptionMode).toBe('plain');
      expect(body.metadataLayoutVersion).toBe(1);
      expect(JSON.parse(body.sharedMetadata.ciphertext)).toMatchObject({
        v: 1,
      });
      expect(body.ownerMetadata).toMatchObject({
        t: 'plain',
        v: {
          workspace: {
            path: '/tmp',
            host: 'localhost',
          },
        },
      });
      expect(body.dataEncryptionKey).toBeNull();

      return {
        data: {
          created: true,
          organizationPlacement: {
            folderId: 'folder-1',
            tagIds: ['tag-1'],
          },
          session: {
            id: 'session-plain',
            seq: 1,
            encryptionMode: 'plain',
            metadata: body.sharedMetadata.ciphertext,
            ownerMetadata: body.ownerMetadata,
            metadataLayoutVersion: 1,
            metadataVersion: 1,
            agentState: body.agentState,
            agentStateVersion: 0,
            dataEncryptionKey: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      };
    });

    const api = await ApiClient.create(credential);
    const session = await api.getOrCreateSession({
      tag: 'tag-plain',
      metadata: {
        path: '/tmp',
        host: 'localhost',
        homeDir: '/home/user',
        happyHomeDir: '/home/user/.happy',
        happyLibDir: '/home/user/.happy/lib',
        happyToolsDir: '/home/user/.happy/tools',
      },
      state: null,
    });

    expect(session).not.toBeNull();
    expect(session?.metadata.path).toBe('/tmp');
    expect(session?.sessionCreationOutcome).toEqual({
      disposition: 'created',
      organizationPlacement: {
        folderId: 'folder-1',
        tagIds: ['tag-1'],
      },
    });
  });

  it('uses account mode to decide plaintext session creation when policy is optional', async () => {
    const credential = {
      token: 'token-test',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(7),
      },
    };

    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : String((input as any)?.url ?? input);
      if (url.endsWith('/v1/features')) {
        return serverFeaturesResponse({
              accountStoredContentCompatibility: {
                v: 1,
                minimumProtocolVersion: 2,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                declarationTransport: 'http-header-and-socket-auth-v1',
              },
              encryption: {
                storagePolicy: 'optional',
                allowAccountOptOut: true,
                defaultAccountMode: 'e2ee',
              },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as any);

    mockGet.mockResolvedValue({
      status: 200,
      data: {
        mode: 'plain',
        version: 1,
        signingKeyFingerprint: null,
        contentKeyFingerprint: null,
        updatedAt: 1,
        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
      },
    });

    mockPost.mockImplementation(async (_url: string, body: any) => {
      expect(body.encryptionMode).toBe('plain');
      expect(body.metadataLayoutVersion).toBe(1);
      expect(JSON.parse(body.sharedMetadata.ciphertext)).toMatchObject({
        v: 1,
      });
      expect(body.ownerMetadata).toMatchObject({
        t: 'plain',
        v: {
          workspace: {
            path: '/tmp',
            host: 'localhost',
          },
        },
      });
      expect(body.dataEncryptionKey).toBeNull();
      return {
        data: {
          session: {
            id: 'session-plain',
            seq: 1,
            encryptionMode: 'plain',
            metadata: body.sharedMetadata.ciphertext,
            ownerMetadata: body.ownerMetadata,
            metadataLayoutVersion: 1,
            metadataVersion: 1,
            agentState: body.agentState,
            agentStateVersion: 0,
            dataEncryptionKey: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      };
    });

    const api = await ApiClient.create(credential as any);
    const session = await api.getOrCreateSession({
      tag: 'tag-plain',
      metadata: {
        path: '/tmp',
        host: 'localhost',
        homeDir: '/home/user',
        happyHomeDir: '/home/user/.happy',
        happyLibDir: '/home/user/.happy/lib',
        happyToolsDir: '/home/user/.happy/tools',
      },
      state: null,
    });

    expect(session).not.toBeNull();
    expect(session?.metadata.path).toBe('/tmp');
  });

  it('creates a keyless plain Session when feature discovery omits stored-content requirements', async () => {
    const credential = {
      token: 'token-test',
      encryption: null,
    };
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = typeof input === 'string'
        ? input
        : String((input as { url?: unknown })?.url ?? input);
      if (url.endsWith('/v1/features')) {
        return serverFeaturesResponse({
              encryption: {
                storagePolicy: 'plaintext_only',
                allowAccountOptOut: false,
                defaultAccountMode: 'plain',
              },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    // Stored-content requirements do not gate Session creation. Account
    // currentness still owns its mode; HTTP carries the current declaration.
    mockPost.mockImplementation(async (_url: string, body: Readonly<{
      sharedMetadata: Readonly<{ ciphertext: string }>;
      ownerMetadata: unknown;
      agentState: string | null;
    }>) => ({ status: 200, data: { session: {
      id: 'session-no-stored-content-requirements',
      seq: 1,
      encryptionMode: 'plain',
      metadata: body.sharedMetadata.ciphertext,
      ownerMetadata: body.ownerMetadata,
      metadataLayoutVersion: 1,
      metadataVersion: 1,
      agentState: body.agentState,
      agentStateVersion: 0,
      dataEncryptionKey: null,
      share: null,
      createdAt: 1,
      updatedAt: 1,
    } } }));
    const api = await ApiClient.create(credential);
    const session = await api.getOrCreateSession({
      tag: 'tag-old-server',
      metadata: {
        path: '/private',
        host: 'private-host',
        homeDir: '/private/home',
        happyHomeDir: '/private/home/.happy',
        happyLibDir: '/private/home/.happy/lib',
        happyToolsDir: '/private/home/.happy/tools',
      },
      state: null,
    });
    expect(session).toMatchObject({
      id: 'session-no-stored-content-requirements',
      encryptionMode: 'plain',
      metadataLayoutVersion: 1,
      metadata: { path: '/private', host: 'private-host' },
    });
    expect(mockGet).toHaveBeenCalledWith(
      'https://api.example.com/v1/account/encryption/currentness',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer token-test' }) }),
    );
    expect(mockPost).toHaveBeenCalledExactlyOnceWith('https://api.example.com/v1/sessions',
      expect.objectContaining({ metadataLayoutVersion: 1, encryptionMode: 'plain', dataEncryptionKey: null,
        ownerMetadata: expect.objectContaining({ t: 'plain', v: expect.objectContaining({
          workspace: expect.objectContaining({ path: '/private', host: 'private-host' }),
        }) }),
      }),
      expect.objectContaining({ headers: expect.objectContaining(buildCurrentAccountStoredContentCompatibilityHttpHeaders()) }),
    );
    expect(credential.encryption).toBeNull();
    expect(session).not.toHaveProperty('encryptionKey');
    expect(JSON.parse(mockPost.mock.calls[0]![1].sharedMetadata.ciphertext)).not.toHaveProperty('path');
  });

  it('does not relabel a current invalid-params 400 as an old-server upgrade', async () => {
    const credential = {
      token: 'token-test',
      encryption: null,
    };
    vi.stubGlobal('fetch', vi.fn(async () => serverFeaturesResponse({
          accountStoredContentCompatibility: {
            v: 1,
            minimumProtocolVersion: 2,
            currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
            declarationTransport: 'http-header-and-socket-auth-v1',
          },
          encryption: {
            storagePolicy: 'plaintext_only',
            allowAccountOptOut: false,
            defaultAccountMode: 'plain',
          },
    })));
    mockPost.mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        status: 400,
        data: { error: 'invalid-params' },
      },
      message: 'Request failed with status code 400',
    });

    const api = await ApiClient.create(credential);
    const error = await api.getOrCreateSession({
      tag: 'tag-current-invalid',
      metadata: {
        path: '/private',
        host: 'private-host',
        homeDir: '/private/home',
        happyHomeDir: '/private/home/.happy',
        happyLibDir: '/private/home/.happy/lib',
        happyToolsDir: '/private/home/.happy/tools',
      },
      state: null,
    }).catch((caught) => caught);
    expect(error).not.toMatchObject({
      code: 'client-upgrade-required',
    });
    expect(mockPost).toHaveBeenCalledOnce();
  });

  it('loads a layout-v1 response through the recipient-safe metadata contract', async () => {
    const credential = {
      token: 'token-test',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(7),
      },
    };

    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = typeof input === 'string'
        ? input
        : String((input as { url?: unknown })?.url ?? input);
      if (url.endsWith('/v1/features')) {
        return serverFeaturesResponse({
              accountStoredContentCompatibility: {
                v: 1,
                minimumProtocolVersion: 2,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                declarationTransport: 'http-header-and-socket-auth-v1',
              },
              encryption: {
                storagePolicy: 'plaintext_only',
                allowAccountOptOut: false,
                defaultAccountMode: 'e2ee',
              },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const responseTuple = buildSessionMetadataEnvelopeFields({
      credentials: credential,
      accountEncryptionMode: 'plain',
      metadata: {
        path: '/private/workspace',
        host: 'private-host',
        homeDir: '/private/home',
        happyHomeDir: '/private/home/.happy',
        happyLibDir: '/private/home/.happy/lib',
        happyToolsDir: '/private/home/.happy/tools',
      },
      agentState: null,
      storedContentMode: 'plain',
    });
    mockPost.mockImplementation(async () => ({
      data: {
        session: {
          id: 'session-layout-v1',
          seq: 1,
          encryptionMode: 'plain',
          metadata: JSON.stringify({
            v: 1,
            summary: {
              text: 'Recipient-safe summary',
              updatedAt: 10,
            },
          }),
          ownerMetadata: responseTuple.ownerMetadata,
          metadataLayoutVersion: 1,
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 0,
          dataEncryptionKey: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    }));

    const api = await ApiClient.create(credential);
    const session = await api.getOrCreateSession({
      tag: 'tag-layout-v1',
      metadata: {
        path: '/private/workspace',
        host: 'private-host',
        homeDir: '/private/home',
        happyHomeDir: '/private/home/.happy',
        happyLibDir: '/private/home/.happy/lib',
        happyToolsDir: '/private/home/.happy/tools',
      },
      state: null,
    });
    if (!session) throw new Error('Expected layout-v1 session response');

    expect(session).toMatchObject({
      metadataLayoutVersion: 1,
      metadata: {
        path: '/private/workspace',
        host: 'private-host',
        homeDir: '/private/home',
        happyHomeDir: '/private/home/.happy',
        happyLibDir: '/private/home/.happy/lib',
        happyToolsDir: '/private/home/.happy/tools',
        summary: {
          text: 'Recipient-safe summary',
          updatedAt: 10,
        },
      },
    });
    expect(session.ownerMetadataEnvelope).toEqual(
      responseTuple.ownerMetadata,
    );
    expect(session.ownerMetadata).toMatchObject({
      v: 1,
      workspace: {
        path: '/private/workspace',
        host: 'private-host',
      },
    });
    expect(session.metadata).not.toHaveProperty('ownerMetadata');
  });

  it.each([false, true])('rejects a rejoined Session whose immutable creation correspondence differs from the admitted request (lostReceipt=%s)', async (lostReceipt) => {
    vi.stubEnv('HAPPIER_API_CREATE_SESSION_RETRY_BASE_DELAY_MS', '0');
    const credential = {
      token: 'token-test',
      encryption: null,
    };
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'user',
      creationKey: 'manual:correspondence-conflict',
    });
    const buildCorrespondence = (directory: string) =>
      SessionCreationCorrespondenceV1Schema.parse({
        v: 1,
        sessionCreationTag,
        recipe: {
          execution: { machineId: 'machine-1', directory: { kind: 'path', path: directory } },
          organization: { folderId: null, tagIds: [] },
          agentTarget: {
            kind: 'agent',
            identity: { pluginId: 'example.external-agent', localId: 'external' },
          },
          modelSelection: null,
          profileId: null,
          requestedPermissionMode: null,
          agentModeId: null,
          configuration: null,
          connectedServices: null,
          capabilitySelection: null,
          transcriptStorage: null,
          terminal: null,
          agentSessionStartupInstructionsMarkerV1: null,
          checkout: null,
        },
      });
    const admittedCorrespondence = buildCorrespondence('/workspace/admitted');
    const existingCorrespondence = buildCorrespondence('/workspace/existing');
    const existingMetadata = {
      path: '/workspace/existing',
      host: 'private-host',
      homeDir: '/private/home',
      happyHomeDir: '/private/home/.happy',
      happyLibDir: '/private/home/.happy/lib',
      happyToolsDir: '/private/home/.happy/tools',
      sessionCreationCorrespondenceV1: existingCorrespondence,
    };
    const existingEnvelope = buildSessionMetadataEnvelopeFields({
      credentials: credential,
      accountEncryptionMode: 'plain',
      metadata: existingMetadata,
      agentState: null,
      storedContentMode: 'plain',
    });

    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = typeof input === 'string'
        ? input
        : String((input as { url?: unknown })?.url ?? input);
      if (url.endsWith('/v1/features')) {
        return serverFeaturesResponse({
              accountStoredContentCompatibility: {
                v: 1,
                minimumProtocolVersion: 2,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                declarationTransport: 'http-header-and-socket-auth-v1',
              },
              encryption: {
                storagePolicy: 'plaintext_only',
                allowAccountOptOut: false,
                defaultAccountMode: 'plain',
              },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    mockPost.mockResolvedValue({
      data: {
        created: false,
        organizationPlacement: { folderId: null, tagIds: [] },
        session: {
          id: 'session-existing',
          seq: 1,
          encryptionMode: 'plain',
          metadata: existingEnvelope.sharedMetadata.ciphertext,
          ownerMetadata: existingEnvelope.ownerMetadata,
          metadataLayoutVersion: 1,
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 0,
          dataEncryptionKey: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });
    if (lostReceipt) mockPost.mockRejectedValueOnce({ isAxiosError: true, code: 'ECONNRESET' });

    const admittedMetadata: Metadata & Readonly<{
      sessionCreationCorrespondenceV1: typeof admittedCorrespondence;
    }> = {
      ...existingMetadata,
      path: '/workspace/admitted',
      sessionCreationCorrespondenceV1: admittedCorrespondence,
    };
    const api = await ApiClient.create(credential);
    await expect(api.getOrCreateSession({
      tag: sessionCreationTag,
      metadata: admittedMetadata,
      state: null,
    })).rejects.toMatchObject({
      code: 'creation_conflict',
    });
    expect(mockPost).toHaveBeenCalledTimes(lostReceipt ? 2 : 1);
  });

  it('creates encrypted fresh sessions on layout 1 without exposing owner metadata in the shared envelope', async () => {
    const credential = {
      token: 'token-test',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(7),
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = typeof input === 'string'
        ? input
        : String((input as { url?: unknown })?.url ?? input);
      if (url.endsWith('/v1/features')) {
        return serverFeaturesResponse({
              accountStoredContentCompatibility: {
                v: 1,
                minimumProtocolVersion: 2,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                declarationTransport: 'http-header-and-socket-auth-v1',
              },
              encryption: {
                storagePolicy: 'required_e2ee',
                allowAccountOptOut: false,
                defaultAccountMode: 'e2ee',
              },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    mockGet.mockResolvedValue({
      status: 200,
      data: {
        mode: 'e2ee',
        version: 1,
        signingKeyFingerprint: null,
        contentKeyFingerprint: 'content-fingerprint',
        updatedAt: 1,
        recipientEnvelopeReadiness: { status: 'available' },
      },
    });

    mockPost.mockImplementation(async (_url: string, body: any) => {
      expect(body.metadataLayoutVersion).toBe(1);
      const sharedMetadata = decrypt(
        credential.encryption.secret,
        'legacy',
        decodeBase64(body.sharedMetadata.ciphertext),
      );
      expect(sharedMetadata).toMatchObject({
        v: 1,
      });
      expect(sharedMetadata).not.toHaveProperty('path');
      expect(sharedMetadata).not.toHaveProperty('codexSessionId');
      expect(body.ownerMetadata).toMatchObject({ t: 'encrypted' });
      expect(decrypt(
        credential.encryption.secret,
        'legacy',
        decodeBase64(body.agentState),
      )).toMatchObject({
        completedRequests: {
          permission_1: {
            arguments: { command: 'git status' },
          },
        },
      });

      return {
        data: {
          session: {
            id: 'session-e2ee-layout-v1',
            seq: 1,
            // Layout 1 must carry an authenticated owner/recipient projection.
            // This owner response uses the canonical released owner marker.
            share: null,
            encryptionMode: 'e2ee',
            metadata: body.sharedMetadata.ciphertext,
            ownerMetadata: body.ownerMetadata,
            metadataLayoutVersion: 1,
            metadataVersion: 1,
            agentState: body.agentState,
            agentStateVersion: 1,
            dataEncryptionKey: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      };
    });

    const api = await ApiClient.create(credential);
    const session = await api.getOrCreateSession({
      tag: 'tag-e2ee-layout-v1',
      metadata: {
        path: '/private/e2ee',
        host: 'private-host',
        homeDir: '/private/home',
        happyHomeDir: '/private/home/.happy',
        happyLibDir: '/private/home/.happy/lib',
        happyToolsDir: '/private/home/.happy/tools',
        flavor: 'codex',
        codexSessionId: 'codex-private',
      },
      state: {
        completedRequests: {
          permission_1: {
            tool: 'Bash',
            kind: 'permission',
            arguments: { command: 'git status' },
            createdAt: 1,
            completedAt: 2,
            status: 'approved',
          },
        },
      },
    });

    expect(session).toMatchObject({
      metadataLayoutVersion: 1,
      metadata: {
        path: '/private/e2ee',
        codexSessionId: 'codex-private',
      },
    });
  });
});
