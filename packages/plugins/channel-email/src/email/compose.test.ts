import { createHash } from 'node:crypto';

import { simpleParser } from 'mailparser';
import { describe, expect, it } from 'vitest';

import { composeEmail, emailDeliveryMessageId } from './compose.js';

const mailbox = 'wilson@batiplus.ch';
const deliveryKey = 'channel-delivery:brief-session:turn-1';

describe('emailDeliveryMessageId', () => {
  it('uses the custody key as the stable identity at the mailbox domain', () => {
    const digest = createHash('sha256').update(deliveryKey).digest('hex');
    expect(emailDeliveryMessageId(deliveryKey, mailbox)).toBe(`<${digest}@batiplus.ch>`);
    expect(emailDeliveryMessageId(deliveryKey, 'other@BATIPLUS.CH')).toBe(`<${digest}@batiplus.ch>`);
    expect(emailDeliveryMessageId('another-delivery', mailbox)).not.toBe(emailDeliveryMessageId(deliveryKey, mailbox));
  });
});

describe('composeEmail', () => {
  it('starts a MIME alternative message for the resolved audience and preserves branded HTML', async () => {
    const recipients = ['owner@batiplus.ch', 'ceo@batiplus.ch'];
    const html = '<html><body><h1>Brief du matin</h1><p>Éléments prêts.</p></body></html>';
    const composed = await composeEmail({
      mailbox, recipients, deliveryKey, subject: 'Brief du matin — lundi',
      content: { text: 'Brief du matin\nÉléments prêts.', html },
    });
    const mail = await simpleParser(Buffer.from(composed.mime));

    expect(composed.envelope).toEqual({ from: mailbox, to: recipients });
    expect(mail.from?.value.map((address) => address.address)).toEqual([mailbox]);
    expect(mail.to && !Array.isArray(mail.to) ? mail.to.value.map((address) => address.address) : []).toEqual(recipients);
    expect(mail.cc).toBeUndefined();
    expect(mail.bcc).toBeUndefined();
    expect(mail.replyTo).toBeUndefined();
    expect(mail.subject).toBe('Brief du matin — lundi');
    expect(mail.text?.trim()).toBe('Brief du matin\nÉléments prêts.');
    expect(mail.html).toBe(html);
    expect(mail.messageId).toBe(composed.messageId);
    expect(mail.messageId).toBe(emailDeliveryMessageId(deliveryKey, mailbox));
    expect(mail.headers.get('content-type')).toMatchObject({ value: 'multipart/alternative' });
    expect(mail.headers.get('auto-submitted')).toBe('auto-replied');
    expect(mail.headers.get('x-auto-response-suppress')).toBe('All');
    expect(mail.headers.has('x-happier-delivery-key')).toBe(false);
    expect(mail.inReplyTo).toBeUndefined();
    expect(mail.references).toBeUndefined();
  });

  it('threads a Markdown reply to its one sender and quotes the answered text in both alternatives', async () => {
    const composed = await composeEmail({
      mailbox, recipients: ['sales@batiplus.ch'], deliveryKey,
      content: { text: '**Créé** : [voir le lead](https://example.com/lead).' },
      reply: {
        messageId: '<latest@batiplus.ch>', references: ['<root@batiplus.ch>', '<older@batiplus.ch>'],
        subject: 'RE: Re: Demande de devis', text: 'Bonjour,\nMeubles <script>alert("x")</script> & tables.\n',
      },
    });
    const mail = await simpleParser(Buffer.from(composed.mime));

    expect(composed.envelope.to).toEqual(['sales@batiplus.ch']);
    expect(mail.subject).toBe('Re: Demande de devis');
    expect(mail.inReplyTo).toBe('<latest@batiplus.ch>');
    expect(mail.references).toEqual(['<root@batiplus.ch>', '<older@batiplus.ch>', '<latest@batiplus.ch>']);
    expect(mail.text).toContain('**Créé** : [voir le lead](https://example.com/lead).');
    expect(mail.text).toContain('> Bonjour,\n> Meubles <script>alert("x")</script> & tables.');
    expect(mail.text!.indexOf('**Créé**')).toBeLessThan(mail.text!.indexOf('> Bonjour,'));
    expect(mail.html).toContain('<strong>Créé</strong>');
    expect(mail.html).toContain('<a href="https://example.com/lead">voir le lead</a>');
    expect(mail.html).toContain('<blockquote');
    expect(mail.html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; tables.');
    expect(mail.html).not.toContain('<script>');
    expect(mail.headers.get('content-type')).toMatchObject({ value: 'multipart/alternative' });
  });

  it('includes the answered message in References once when already present', async () => {
    const composed = await composeEmail({
      mailbox, recipients: ['owner@batiplus.ch'], deliveryKey, content: { text: 'Oui.' },
      reply: { messageId: '<root@batiplus.ch>', references: ['<root@batiplus.ch>'], subject: 'Question', text: 'Disponible ?' },
    });
    const mail = await simpleParser(Buffer.from(composed.mime));
    expect(mail.inReplyTo).toBe('<root@batiplus.ch>');
    expect(mail.references).toBe('<root@batiplus.ch>');
    expect(mail.subject).toBe('Re: Question');
  });

  it('refuses a reply recipient list rather than producing reply-all mail', async () => {
    await expect(composeEmail({
      mailbox, recipients: ['owner@batiplus.ch', 'ceo@batiplus.ch'], deliveryKey, content: { text: 'Oui.' },
      reply: { messageId: '<root@batiplus.ch>', references: [], subject: 'Question', text: 'Disponible ?' },
    })).rejects.toThrow();
  });

  it('rejects an address list disguised as one resolved recipient', async () => {
    await expect(composeEmail({
      mailbox, recipients: ['owner@batiplus.ch, outside@example.com'], deliveryKey,
      content: { text: 'Réponse' }, subject: 'Question',
    })).rejects.toThrow();
  });

  it('keeps both alternatives even for empty content', async () => {
    const composed = await composeEmail({
      mailbox, recipients: ['owner@batiplus.ch'], deliveryKey, subject: 'Question', content: { text: '', html: '' },
    });
    const mail = await simpleParser(Buffer.from(composed.mime));
    expect(mail.headers.get('content-type')).toMatchObject({ value: 'multipart/alternative' });
  });

  it.each(['mailbox', 'recipient', 'subject', 'replySubject', 'messageId', 'reference'] as const)(
    'rejects a CRLF injection in %s before it can enter MIME headers', async (field) => {
      const injected = 'value\r\nBcc: outside@example.com';
      await expect(composeEmail({
        mailbox: field === 'mailbox' ? injected : mailbox,
        recipients: [field === 'recipient' ? injected : 'owner@batiplus.ch'],
        deliveryKey, subject: field === 'subject' ? injected : 'Question', content: { text: 'Réponse' },
        reply: {
          messageId: field === 'messageId' ? injected : '<root@batiplus.ch>',
          references: [field === 'reference' ? injected : '<older@batiplus.ch>'],
          subject: field === 'replySubject' ? injected : 'Question', text: 'Bonjour',
        },
      })).rejects.toThrow();
    },
  );
});
