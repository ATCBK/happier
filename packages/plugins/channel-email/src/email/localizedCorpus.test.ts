import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { emailThreadKey, parseEmail } from './parse.js';
import { evaluateEmailTrust } from './trust.js';

const locales = {
  fr: { reply: 'Bonjour, le devis est validé.', signature: 'Équipe commerciale', old: 'Pouvez-vous confirmer le devis précédent ?', link: 'Détails du devis' },
  en: { reply: 'Hello, the quote is approved.', signature: 'Sales team', old: 'Could you confirm the previous quote?', link: 'Quote details' },
  de: { reply: 'Guten Tag, das Angebot ist bestätigt.', signature: 'Vertrieb', old: 'Können Sie das vorherige Angebot bestätigen?', link: 'Angebotsdetails' },
};
const corpus = ['outlook', 'gmail', 'apple-mail', 'thunderbird'].flatMap(client =>
  Object.entries(locales).map(([locale, expected]) => ({ client, locale, expected })));

describe('constructed localized client MIME corpus', () => {
  it.each(corpus)('shapes $client / $locale with real MIME decoding and explicit history policy', async ({ client, locale, expected }) => {
    const raw = await readFile(new URL(`./fixtures/${client}-${locale}-markup.eml`, import.meta.url));
    const mail = await parseEmail(raw, { knownThread: true });
    expect(mail.text).toContain(expected.reply);
    expect(mail.text).toContain(`[${expected.link}](https://example.test/quote)`);
    expect(mail.text).not.toContain(expected.old);
    expect(mail.text).not.toContain(expected.signature);
    expect(mail.text).not.toMatch(/HIDDEN FIXTURE CONTENT|tracker/);
    expect(mail.attachments.map(file => file.name)).toEqual(['project-plan.png', 'appointment.ics']);
    expect(emailThreadKey(mail)).toBe('<root@example.test>');
    expect(mail.messageId).toBe(`<${client}-${locale}@example.test>`);
    expect(evaluateEmailTrust({ ...mail, strategy: { kind: 'authenticationResults', authservId: 'mx.example.test' } }).trusted).toBe(true);

    const first = await parseEmail(raw);
    expect(first.text).toContain(expected.old);
    const retained = await parseEmail(raw, { knownThread: true, quotedHistory: 'never', stripSignatures: false });
    expect(retained.text).toContain(expected.old);
    expect(retained.text).toContain(expected.signature);
    expect(retained.attachments.map(file => file.name)).toContain('signature-logo.png');
    const text = await parseEmail(raw, { quotedHistory: 'always', bodyFormat: 'text' });
    expect(text.text).toContain(expected.reply);
    expect(text.text).toContain(expected.link);
    expect(text.text).not.toContain(expected.old);
    expect(text.text).not.toMatch(/HIDDEN FIXTURE CONTENT|tracker|\]\(https:/);
  });
});
