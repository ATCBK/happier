import { createHash } from 'node:crypto';

import { normalizeEmailAddress } from './address.js';

function assertHeaderValue(value: string, name: string): void {
  if (/[\r\n]/.test(value)) throw new TypeError(`${name} must not contain line breaks`);
}

function mailboxAddress(value: string): string {
  assertHeaderValue(value, 'Email address');
  const address = normalizeEmailAddress(value);
  if (address === null) throw new TypeError('Expected a single bare email address');
  return address;
}

function escapeHtml(text: string): string {
  const entities: Record<string, string> = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  };
  return text.replace(/[&<>"']/g, (character) => entities[character]);
}

export function emailDeliveryMessageId(deliveryKey: string, mailbox: string): string {
  const address = mailboxAddress(mailbox);
  const domain = address.slice(address.lastIndexOf('@') + 1);
  return `<${createHash('sha256').update(deliveryKey).digest('hex')}@${domain}>`;
}

export async function composeEmail(input: {
  mailbox: string;
  recipients: readonly string[];
  content: { text: string; html?: string };
  deliveryKey: string;
  subject?: string;
  reply?: { messageId: string; references: readonly string[]; subject: string; text: string };
}): Promise<{ mime: Uint8Array; messageId: string; envelope: { from: string; to: string[] } }> {
  const from = mailboxAddress(input.mailbox);
  const to = input.recipients.map(mailboxAddress);
  if (to.length === 0 || (input.reply && to.length !== 1)) {
    throw new TypeError('Email requires recipients; a reply requires exactly one sender recipient');
  }
  if (input.subject !== undefined) assertHeaderValue(input.subject, 'Subject');
  if (input.reply) {
    assertHeaderValue(input.reply.subject, 'Reply subject');
    assertHeaderValue(input.reply.messageId, 'In-Reply-To');
    input.reply.references.forEach((reference) => assertHeaderValue(reference, 'References'));
  }

  const messageId = emailDeliveryMessageId(input.deliveryKey, from);
  const envelope = { from, to };
  let text = input.content.text;
  let html = input.content.html;
  if (html === undefined) {
    const { marked } = await import('marked');
    html = await marked.parse(input.content.text);
  }
  if (input.reply) {
    const quotedText = input.reply.text.split(/\r\n|\n|\r/).map((line) => `> ${line}`).join('\n');
    text += `\n\n${quotedText}`;
    html += `<blockquote>${escapeHtml(input.reply.text).replace(/\r\n|\n|\r/g, '<br>')}</blockquote>`;
  }

  const nodemailer = await import('nodemailer');
  const { createTransport } = { ...nodemailer.default, ...nodemailer };
  const transporter = createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
  const result = await transporter.sendMail({
    from: { address: from, name: '' },
    to: to.map((address) => ({ address, name: '' })),
    subject: input.reply ? `Re: ${input.reply.subject.replace(/^(?:re\s*:\s*)+/i, '')}` : input.subject,
    // Buffers preserve both alternatives even when a body is empty.
    text: Buffer.from(text),
    html: Buffer.from(html),
    messageId,
    envelope,
    ...(input.reply ? {
      inReplyTo: input.reply.messageId,
      references: [...new Set([...input.reply.references, input.reply.messageId])],
    } : {}),
    headers: { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All' },
  });
  if (!Buffer.isBuffer(result.message)) throw new TypeError('Expected buffered MIME output');
  return { mime: result.message, messageId, envelope };
}
