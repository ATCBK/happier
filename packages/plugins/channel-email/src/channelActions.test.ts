import { describe, expect, it } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { deliverEmailMessage, pollEmailObservations, reconcileEmailDelivery,
  resolveEmailEndpoint, resolveEmailPrincipal, setupEmailChannels, testEmailConnection,
  fetchEmailAttachment, cleanupEmailAttachments } from './channelActions.js';

const config = {
  mailbox: 'wilson@example.com',
  transport: { pluginId: 'acme.email', contributionId: 'mail' },
  transportConfig: {},
  trustStrategy: { kind: 'authenticationResults', authservId: 'mx.example.com' },
  allowedDomains: ['example.com'],
};
const connection = {
  v: 1, connectionId: 'mail-1', providerConnectionKey: 'email:wilson@example.com',
  providerConfigVersion: 1, providerConfig: config, credentialRef: null,
};
const context = {
  surface: 'plugin', caller: { kind: 'plugin', pluginId: 'happier.channels' },
  signal: new AbortController().signal,
} as PluginInvocationContext;

describe('email provider principal admission', () => {
  it('normalizes an owner-entered address and rejects addresses outside configured domains', async () => {
    const resolve = resolveEmailPrincipal;
    const endpoint = { kind: 'direct', audience: 'direct', id: config.mailbox };
    await expect(resolve({ ...connection, providerConfig: { ...config, futureField: true,
      trustStrategy: { ...config.trustStrategy, futureMarker: true } }, endpoint, query: ' Alice@EXAMPLE.COM ' }, context))
      .resolves.toEqual({ kind: 'resolved', candidates: [{ id: 'alice@example.com', kind: 'human', label: 'alice@example.com' }] });
    await expect(resolve({ ...connection, endpoint, query: 'alice@external.com' }, context))
      .resolves.toEqual({ kind: 'resolved', candidates: [] });
  });

  it('does not impose a domain policy when the owner leaves allowedDomains empty', async () => {
    const resolve = resolveEmailPrincipal;
    await expect(resolve({ ...connection, providerConfig: { ...config, allowedDomains: [] },
      endpoint: { kind: 'direct', audience: 'direct', id: config.mailbox }, query: 'partner@external.com' }, context))
      .resolves.toEqual({ kind: 'resolved', candidates: [{ id: 'partner@external.com', kind: 'human', label: 'partner@external.com' }] });
  });

  it('refuses address lists instead of broadening one principal into several recipients', async () => {
    const resolve = resolveEmailPrincipal;
    await expect(resolve({ ...connection, endpoint: { kind: 'direct', audience: 'direct', id: config.mailbox },
      query: 'alice@example.com, bob@example.com' }, context)).resolves.toEqual({ kind: 'resolved', candidates: [] });
  });
});

describe('email provider caller authority', () => {
  it.each([setupEmailChannels, testEmailConnection, resolveEmailEndpoint, resolveEmailPrincipal,
    pollEmailObservations, deliverEmailMessage, reconcileEmailDelivery, fetchEmailAttachment])('refuses a non-core caller before parsing or I/O (%s)', async role => {
    await expect(role({}, { ...context, surface: 'cli', caller: undefined }))
      .rejects.toMatchObject({ code: 'channels_core_caller_required' });
    await expect(role({}, { ...context, caller: { kind: 'plugin', pluginId: 'acme.transport' } as PluginInvocationContext['caller'] }))
      .rejects.toMatchObject({ code: 'channels_core_caller_required' });
  });
});

describe('email mailbox resolution', () => {
  it('resolves only the configured mailbox and does not expose a recipient picker', async () => {
    await expect(resolveEmailEndpoint({ ...connection, query: ' WILSON@EXAMPLE.COM ' }, context))
      .resolves.toEqual({ kind: 'resolved', candidates: [{ kind: 'direct', audience: 'direct', id: config.mailbox, label: config.mailbox }] });
    await expect(resolveEmailEndpoint({ ...connection, query: 'alice@example.com' }, context))
      .resolves.toEqual({ kind: 'resolved', candidates: [] });
    await expect(resolveEmailEndpoint({ ...connection, query: config.mailbox, kinds: ['thread'] }, context))
      .resolves.toEqual({ kind: 'resolved', candidates: [] });
  });
});

describe('email lazy attachment fetch', () => {
  it('exports trusted attachment bytes in a protected owned file until occurrence cleanup', async () => {
    const mime = ['Message-ID: <file@example.com>', 'From: Alice <alice@example.com>',
      'Authentication-Results: mx.example.com; dmarc=pass header.from=example.com',
      'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="files"', '',
      '--files', 'Content-Type: text/plain', '', 'See attachment.', '--files',
      'Content-Type: application/octet-stream', 'Content-Disposition: attachment; filename="../../outside.txt"',
      'Content-Transfer-Encoding: base64', '', 'aGVsbG8=', '--files--', ''].join('\r\n');
    let rawMime = mime;
    const handle = Object.freeze({ identity: { role: 'fetchRaw' } });
    // The host catalog and admitted executor are genuine system boundaries. MIME,
    // sender trust, selection and protected filesystem staging remain real.
    const services = {
      targetedContributions: { observeForSelf: () => ({ dispose() {}, readCurrent: async () => ({
        contributions: [{ protocol: { id: 'happier.channel.email/transports', version: 1 },
          contributor: config.transport, operations: { fetchRaw: handle } }],
      }) }) },
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin: async (operation: unknown) => {
        expect(operation).toBe(handle);
        return { result: { kind: 'raw', mimeBase64: Buffer.from(rawMime).toString('base64') } };
      } },
    } as unknown as PluginInvocationContext['services'];
    let path: string | undefined;
    try {
      const result = await fetchEmailAttachment({ ...connection, messageId: '<file@example.com>', attachmentId: 'mime:2' }, { ...context, services });
      expect(result.kind).toBe('fetched');
      if (result.kind !== 'fetched') return;
      path = result.path;
      expect(await readFile(result.path, 'utf8')).toBe('hello');
      expect(path).not.toContain('outside.txt');
      if (process.platform !== 'win32') expect((await stat(result.path)).mode & 0o777).toBe(0o600);
      await expect(fetchEmailAttachment({ ...connection, messageId: '<different@example.com>', attachmentId: 'mime:2' }, { ...context, services }))
        .resolves.toMatchObject({ kind: 'notReady', reason: 'permissionMissing' });
      rawMime = mime.replace('dmarc=pass', 'dmarc=fail');
      await expect(fetchEmailAttachment({ ...connection, messageId: '<file@example.com>', attachmentId: 'mime:2' }, { ...context, services }))
        .resolves.toMatchObject({ kind: 'notReady', reason: 'permissionMissing' });
    } finally {
      cleanupEmailAttachments();
    }
    if (path) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
