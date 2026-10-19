import imapkit, { type IMAPServer } from 'imapkit';
import { afterEach, describe, expect, it } from 'vitest';

import { createImapSmtpTransport } from './client';

describe('IMAP mailbox continuity after server replacement', () => {
  const servers: IMAPServer[] = [];
  afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.stop())); });

  async function mailbox(messages: number) {
    const server = imapkit({ secureConnection: true, users: { 'wilson@example.com': { password: 'fixture' } }, storage: { INBOX: {} } });
    servers.push(server);
    const port = await server.start(0, '127.0.0.1');
    for (let index = 0; index < messages; index++) {
      server.control.addMessage('INBOX', { raw: Buffer.from(`From: owner@example.com\r\nMessage-ID: <${index}@example.com>\r\n\r\nFixture\r\n`) });
    }
    const transport = createImapSmtpTransport({ mailbox: 'wilson@example.com', imapHost: 'localhost', imapPort: port,
      smtpHost: 'localhost', smtpPort: 587, inboxFolder: 'INBOX', auth: { user: 'wilson@example.com', pass: 'fixture' } },
    { ca: server.getCredentials().cert });
    return { server, transport };
  }

  it('reports a history gap when a replacement reuses UIDVALIDITY but regresses UIDNEXT', async () => {
    const old = await mailbox(3);
    const baseline = await old.transport.listSince(null, 0, 10);
    if (baseline.kind !== 'batch') throw new Error('Expected initial baseline');
    // Expunging every message does not invalidate UID continuity: UIDNEXT
    // still exceeds the checkpoint even with an empty mailbox.
    old.server.control.expungeMessages('INBOX', [1, 2, 3]);
    expect(await old.transport.listSince(baseline.checkpointAfterBatch, 0, 10)).toEqual(baseline);
    const replacement = await mailbox(1);
    expect(replacement.server.control.getMailbox('INBOX').uidvalidity).toBe(old.server.control.getMailbox('INBOX').uidvalidity);
    expect(await replacement.transport.listSince(baseline.checkpointAfterBatch, 0, 10))
      .toEqual({ kind: 'historyGap', reason: 'providerHistoryUnavailable' });
    // The existing explicit baseline recovery remains the only way to accept
    // the new mailbox; a gap must never silently rewind the saved checkpoint.
    expect(await replacement.transport.listSince(null, 0, 10)).toMatchObject({ kind: 'batch', refs: [],
      checkpointAfterBatch: { lastUid: 1 } });
  });
});
