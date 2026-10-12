import { once } from 'node:events';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import imapkit, { type IMAPServer } from 'imapkit';
import { SMTPServer } from 'smtp-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConnectedAccountAuthenticationContext, ConnectedAccountCredentialStore, ConnectedAccountReadContext } from '@happier-dev/plugin-sdk/connected-accounts';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { createPluginTestkit, type PluginTestkit } from '@happier-dev/plugin-sdk/testing';

import { createImapSmtpTransport, type ImapSmtpAccount } from './client';
import { IMAP_SMTP_CONNECTED_ACCOUNT_ID } from './connectedAccount';
import { imapSmtpActions } from './index';
import { emailPlugin } from '../../plugin';

const mailbox = 'wilson@example.com';
const raw = (id: string) => Buffer.from(`From: sales@example.com\r\nTo: ${mailbox}\r\nMessage-ID: <${id}@example.com>\r\nSubject: Meubles\r\n\r\nBonjour.\r\n`);

describe('IMAP/SMTP transport against real TLS protocol servers', () => {
  let imap: IMAPServer;
  let smtp: SMTPServer;
  let account: ImapSmtpAccount;
  let submitted: Buffer[];
  let rejection: number | undefined;
  let saveSent: boolean;
  let loseReceipt: boolean;
  let holdReceipt: boolean;
  let onSubmitted: (() => void) | undefined;
  let transport: ReturnType<typeof createImapSmtpTransport>;
  let originalCertificates: string[];
  let registeredPlugin: PluginTestkit | undefined;

  beforeEach(async () => {
    submitted = []; rejection = undefined; saveSent = false;
    loseReceipt = false; holdReceipt = false; onSubmitted = undefined;
    registeredPlugin = undefined;
    imap = imapkit({
      secureConnection: true, plugins: ['IDLE', 'SPECIAL-USE', 'UIDPLUS', 'SASL-IR', 'XOAUTH2'],
      users: { [mailbox]: { password: 'testpass', xoauth2: { accessToken: 'testtoken' } } },
      storage: { INBOX: {}, '': { folders: { Sent: { 'special-use': '\\Sent' } } } },
    });
    const imapPort = await imap.start(0, '127.0.0.1');
    originalCertificates = getCACertificates('default');
    setDefaultCACertificates([...originalCertificates, imap.getCredentials().cert.toString()]);
    smtp = new SMTPServer({
      ...imap.getCredentials(), secure: false, logger: false,
      authMethods: ['PLAIN', 'LOGIN', 'XOAUTH2'],
      onAuth(auth, _session, callback) {
        if (auth.username === mailbox && (auth.password === 'testpass' || auth.accessToken === 'testtoken')) callback(null, { user: mailbox });
        else callback(new Error('Invalid credentials'));
      },
      onData(stream, _session, callback) {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          if (rejection) { callback(Object.assign(new Error('Test refusal'), { responseCode: rejection })); return; }
          const bytes = Buffer.concat(chunks); submitted.push(bytes);
          if (saveSent) imap.control.addMessage('Sent', { raw: bytes, flags: ['\\Seen'] });
          onSubmitted?.();
          if (holdReceipt) return;
          if (loseReceipt) {
            // smtp-server's connections set is an untyped OS/network boundary.
            for (const connection of smtp.connections as Set<{ close(): void }>) connection.close();
            return;
          }
          callback(null, 'Accepted');
        });
      },
    });
    smtp.listen(0, '127.0.0.1'); await once(smtp.server, 'listening');
    const smtpAddress = smtp.server.address();
    if (!smtpAddress || typeof smtpAddress === 'string') throw new Error('Missing SMTP listener');
    account = { mailbox, imapHost: 'localhost', imapPort, smtpHost: 'localhost', smtpPort: smtpAddress.port,
      inboxFolder: 'INBOX', auth: { user: mailbox, pass: 'testpass' } };
    transport = createImapSmtpTransport(account, { ca: imap.getCredentials().cert });
  });

  afterEach(async () => {
    await registeredPlugin?.dispose();
    await imap?.stop();
    if (smtp) await new Promise<void>((resolve) => smtp.close(() => resolve()));
    if (originalCertificates) setDefaultCACertificates(originalCertificates);
  });

  it('receives raw bytes, pages UIDs without replay, reads only INBOX and never marks Seen', async () => {
    imap.control.addMessage('INBOX', { raw: raw('first') });
    imap.control.addMessage('INBOX', { raw: raw('second') });
    imap.control.addMessage('Sent', { raw: raw('outgoing') });
    const first = await transport.listSince({ uidValidity: String(imap.control.getMailbox('INBOX').uidvalidity), lastUid: 0, futureField: 'ignored' }, 0, 1);
    expect(first.kind).toBe('batch');
    if (first.kind !== 'batch') throw new Error('Expected first batch');
    expect(first.refs).toHaveLength(1);
    expect(await transport.fetchRaw(first.refs[0])).toEqual(raw('first'));
    const second = await transport.listSince(first.checkpointAfterBatch, 0, 1);
    if (second.kind !== 'batch') throw new Error('Expected second batch');
    expect(second.refs).toHaveLength(1);
    expect(await transport.fetchRaw(second.refs[0])).toEqual(raw('second'));
    const empty = await transport.listSince(second.checkpointAfterBatch, 0, 10);
    expect(empty).toMatchObject({ kind: 'batch', refs: [] });
    expect(imap.control.listMessages('INBOX').every((message) => !message.flags.includes('\\Seen'))).toBe(true);
  });

  it('wakes IDLE on arrival within the containing waitMs', async () => {
    const initial = await transport.listSince(null, 0, 10);
    if (initial.kind !== 'batch') throw new Error('Expected initial batch');
    const idling = new Promise<void>((resolve) => imap.on('session', (event: { type: string; command?: string }) => {
      if (event.type === 'waiting' && event.command === 'IDLE') resolve();
    }));
    const pending = transport.listSince(initial.checkpointAfterBatch, 10_000, 10);
    await idling;
    imap.control.addMessage('INBOX', { raw: raw('wake') });
    const result = await pending;
    expect(result).toMatchObject({ kind: 'batch', refs: [expect.any(String)] });
  });

  it('reports UIDVALIDITY replacement rather than confusing a reused UID with the old message', async () => {
    imap.control.addMessage('INBOX', { raw: raw('old') });
    const first = await transport.listSince(null, 0, 10);
    if (first.kind !== 'batch') throw new Error('Expected batch');
    imap.control.resetUidValidity('INBOX');
    expect(await transport.listSince(first.checkpointAfterBatch, 0, 10)).toEqual({ kind: 'historyGap', reason: 'providerHistoryUnavailable' });
    await expect(transport.fetchRaw(first.refs[0])).rejects.toThrow();
  });

  it('fetches the email core RFC Message-ID from Inbox or Sent for reply context and lazy attachments', async () => {
    imap.control.addMessage('INBOX', { raw: raw('incoming-reference') });
    imap.control.addMessage('Sent', { raw: raw('outgoing-reference') });
    expect(await transport.fetchRaw('<incoming-reference@example.com>')).toEqual(raw('incoming-reference'));
    expect(await transport.fetchRaw('<outgoing-reference@example.com>')).toEqual(raw('outgoing-reference'));
  });

  it.each([false, true])('submits raw reply and start MIME; saves exactly one Sent copy (server saves=%s)', async (serverSaves) => {
    saveSent = serverSaves;
    const start = raw('start');
    const reply = Buffer.from(raw('reply').toString().replace('Subject:', 'In-Reply-To: <start@example.com>\r\nReferences: <start@example.com>\r\nSubject:'));
    for (const [bytes, id] of [[start, 'start'], [reply, 'reply']] as const) {
      expect(await transport.submitRaw(bytes, { from: mailbox, to: ['sales@example.com'] }, `<${id}@example.com>`))
        .toEqual({ kind: 'delivered', providerMessageIds: [`<${id}@example.com>`] });
      expect(await transport.findSent(`<${id}@example.com>`)).toBe(true);
    }
    expect(submitted).toEqual([start, reply]);
    expect(imap.control.listMessages('Sent')).toHaveLength(2);
    expect(await transport.findSent('<missing@example.com>')).toBe(false);
  });

  it.each([[451, 'safe'], [550, 'never']] as const)('maps SMTP %i to %s without a Sent copy', async (code, retry) => {
    rejection = code;
    expect(await transport.submitRaw(raw('refused'), { from: mailbox, to: ['sales@example.com'] }, '<refused@example.com>'))
      .toEqual({ kind: 'notDelivered', retry });
    expect(imap.control.listMessages('Sent')).toHaveLength(0);
  });

  it('authenticates both real servers with XOAUTH2 access tokens', async () => {
    transport = createImapSmtpTransport({ ...account, auth: { user: mailbox, accessToken: 'testtoken' } }, { ca: imap.getCredentials().cert });
    expect(await transport.connectionTest()).toEqual({ kind: 'ready', mailbox });
    expect(await transport.submitRaw(raw('oauth'), { from: mailbox, to: ['sales@example.com'] }, '<oauth@example.com>')).toMatchObject({ kind: 'delivered' });
  });

  it('submits over implicit TLS as used by port 465, with certificate verification', async () => {
    const options = smtp.options;
    await new Promise<void>((resolve) => smtp.close(() => resolve()));
    smtp = new SMTPServer({ ...options, secure: true });
    smtp.listen(0, '127.0.0.1'); await once(smtp.server, 'listening');
    const address = smtp.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing implicit TLS listener');
    transport = createImapSmtpTransport({ ...account, smtpPort: address.port, smtpSecurity: 'tls' }, { ca: imap.getCredentials().cert });
    expect(await transport.submitRaw(raw('implicit-tls'), { from: mailbox, to: ['sales@example.com'] }, '<implicit-tls@example.com>'))
      .toEqual({ kind: 'delivered', providerMessageIds: ['<implicit-tls@example.com>'] });
  });

  it('keeps a lost SMTP DATA receipt ambiguous and reconciles the server-saved Sent identity without resending', async () => {
    loseReceipt = true; saveSent = true;
    expect(await transport.submitRaw(raw('lost'), { from: mailbox, to: ['sales@example.com'] }, '<lost@example.com>'))
      .toMatchObject({ kind: 'outcomeUnknown' });
    expect(await transport.findSent('<lost@example.com>')).toBe(true);
    expect(submitted).toHaveLength(1);
  });

  it('cancels a pending SMTP receipt and closes the connection rather than leaving a send behind', async () => {
    holdReceipt = true;
    const received = new Promise<void>((resolve) => { onSubmitted = resolve; });
    const abort = new AbortController();
    const pending = transport.submitRaw(raw('cancel'), { from: mailbox, to: ['sales@example.com'] }, '<cancel@example.com>', abort.signal);
    const assertion = expect(pending).rejects.toThrow();
    await received; abort.abort(); await assertion;
    await expect.poll(() => smtp.connections.size).toBe(0);
  });

  it('cancels IDLE and closes its socket without waiting for the poll duration', async () => {
    const initial = await transport.listSince(null, 0, 10);
    if (initial.kind !== 'batch') throw new Error('Expected batch');
    const abort = new AbortController();
    const idling = new Promise<void>((resolve) => imap.on('session', (event: { type: string; command?: string }) => {
      if (event.type === 'waiting' && event.command === 'IDLE') resolve();
    }));
    const pending = transport.listSince(initial.checkpointAfterBatch, 10_000, 10, abort.signal);
    const rejectionAssertion = expect(pending).rejects.toThrow();
    await idling; abort.abort(); await rejectionAssertion;
    await expect.poll(() => imap.control.sessions()).toHaveLength(0);
  });

  it.each(['password', 'microsoft-app-only'])('completes %s only after live IMAP and SMTP login, and materializes no application secret', async (modeId) => {
    registeredPlugin = await createPluginTestkit({ manifest: emailPlugin.manifest, module: emailPlugin });
    const runtime = registeredPlugin.registration('connectedAccountDescriptors', IMAP_SMTP_CONNECTED_ACCOUNT_ID);
    if (!runtime) throw new Error('Missing registered Connected Account runtime');
    const mode = runtime.authentication.modes[modeId];
    if (!mode || mode.kind !== 'manual') throw new Error('Missing manual mode');
    const stored = new Map<string, string>();
    const credentials: ConnectedAccountCredentialStore = {
      async get(key) { return stored.get(key) ?? null; },
      async set(key, value) { stored.set(key, value); },
      async delete(key) { stored.delete(key); },
    };
    // Host and credential-store adapters are genuine boundaries; the runtime
    // consumes only configuration, signal, HTTP and these credential members.
    const context = {
      configuration: { target: { kind: 'attempt', modeId }, values: { mailbox, imapHost: 'localhost', imapPort: account.imapPort, smtpHost: 'localhost', smtpPort: account.smtpPort }, getSecret: async () => null },
      signal: new AbortController().signal, attemptCredentials: credentials,
      services: { http: { async request() { return { status: 200, finalUrl: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token', headers: {}, body: Buffer.from(JSON.stringify({ access_token: 'testtoken', token_type: 'Bearer' })) }; } } },
    } as unknown as ConnectedAccountAuthenticationContext;
    const fields: Record<string, string> = modeId === 'password' ? { password: 'testpass' } : { tenantId: 'tenant', clientId: 'app', clientSecret: 'application-secret' };
    const result = await mode.complete({ fields }, context);
    expect(result).toMatchObject({ status: 'connected', accountId: mailbox });
    expect(imap.sessionCounter).toBeGreaterThan(0);
    const readContext = { ...context, credentials } as unknown as ConnectedAccountReadContext;
    const materialized = await runtime.materialize({ kind: 'environment', keys: ['HAPPIER_EMAIL_IMAP_SMTP_ACCOUNT', 'UNRELATED'] }, readContext);
    expect(materialized.kind).toBe('environment');
    if (materialized.kind !== 'environment') throw new Error('Missing environment');
    expect(Object.keys(materialized.env)).toEqual(['HAPPIER_EMAIL_IMAP_SMTP_ACCOUNT']);
    expect(JSON.parse(materialized.env.HAPPIER_EMAIL_IMAP_SMTP_ACCOUNT)).toMatchObject({ mailbox, auth: modeId === 'password' ? { pass: 'testpass' } : { accessToken: 'testtoken' } });
    expect(JSON.stringify(materialized)).not.toContain('application-secret');
    const bad: Record<string, string> = modeId === 'password' ? { password: 'wrong' } : { tenantId: 'tenant', clientId: 'app', clientSecret: 'application-secret' };
    if (modeId === 'microsoft-app-only') imap.control.updateUser(mailbox, { xoauth2: { accessToken: 'revoked' } });
    const rejectedStore = new Map<string, string>();
    const rejectedContext = { ...context, attemptCredentials: { ...credentials, async set(key: string, value: string) { rejectedStore.set(key, value); } } };
    expect(await mode.complete({ fields: bad }, rejectedContext)).toMatchObject({ status: 'rejected' });
    expect(rejectedStore.size).toBe(0);
  });

  it('invokes the declared transport connection Action with exact Connected Account materialization and rejects other callers', async () => {
    const test = imapSmtpActions['transport/imap-smtp/connection-test-v1'].run;
    const credentialRef = { service: { pluginId: 'happier.channel.email', localId: 'email-imap-smtp' }, accountId: mailbox };
    const input = { credentialRef, config: {} };
    const context = {
      surface: 'plugin', caller: { kind: 'plugin', pluginId: 'happier.channel.email' }, signal: new AbortController().signal,
      services: { connectedAccounts: { async materialize(purpose: string, request: unknown, options: { expectedAccount: unknown }) {
        expect(purpose).toBe('email-mailbox');
        expect(request).toEqual({ kind: 'environment', keys: ['HAPPIER_EMAIL_IMAP_SMTP_ACCOUNT'] });
        expect(options.expectedAccount).toEqual(credentialRef);
        return { kind: 'environment', env: { HAPPIER_EMAIL_IMAP_SMTP_ACCOUNT: JSON.stringify(account) } };
      } } },
    } as unknown as PluginInvocationContext;
    expect(await test(input, context)).toEqual({ kind: 'ready', mailbox });
    if (context.caller?.kind !== 'plugin') throw new Error('Missing plugin caller fixture');
    await expect(test(input, { ...context, caller: { ...context.caller, pluginId: 'other.plugin' } })).rejects.toThrow();
    expect(await test({ ...input, credentialRef: null }, context)).toMatchObject({ kind: 'notReady', reason: 'credentialInvalid' });
  });
});
