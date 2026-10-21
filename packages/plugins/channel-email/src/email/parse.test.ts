import { readFile } from 'node:fs/promises';
import { load } from 'cheerio';
import { marked } from 'marked';
import { describe, expect, it } from 'vitest';
import { readConversationAttachmentIdV1 } from '@happier-dev/channels-protocol/v1';

import { emailThreadKey, parseEmail } from './parse.js';

function message(body: string, headers = 'Content-Type: text/plain; charset=utf-8', subject = 'Question') {
  return Buffer.from(`From: Sales <sales@example.test>\r\nSender: sales@example.test\r\nSubject: ${subject}\r\nMessage-ID: <current@example.test>\r\n${headers}\r\n\r\n${body}`);
}

// These generated messages are representative marker tests, not captured client mail.
const clientMarkers = [
  ['Outlook', '<div id="Signature">SIGNATURE</div>', '<div id="divRplyFwdMsg">From: old@example.test<br>Sent: yesterday</div><div>HISTORY</div>'],
  ['Gmail', '<div class="gmail_signature">SIGNATURE</div>', '<div class="gmail_quote">On Monday wrote:<blockquote>HISTORY</blockquote></div>'],
  ['Apple Mail', '<div class="AppleMailSignature">SIGNATURE</div>', '<blockquote type="cite">HISTORY</blockquote>'],
  ['Thunderbird', '<div class="moz-signature">SIGNATURE</div>', '<div class="moz-cite-prefix">On Monday wrote:</div><blockquote type="cite">HISTORY</blockquote>'],
] as const;

describe('parseEmail content at the raw MIME boundary', () => {
  it.each([
    ['apple_mail.eml', 'Hello'],
    ['gmail.eml', 'Hello'],
    ['outlook.eml', 'Allo! Follow up MIME!'],
    ['thunderbird.eml', 'Hello'],
  ])('shapes the upstream client reply sample %s', async (name, expected) => {
    const raw = await readFile(new URL(`./fixtures/${name}`, import.meta.url));
    expect((await parseEmail(raw, { knownThread: true })).text).toBe(expected);
  });

  it.each(['outlook-ios-fr.body.txt', 'outlook-de.body.txt'])('shapes the upstream Outlook locale body vector %s with a synthetic MIME wrapper', async (name) => {
    const body = await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
    expect((await parseEmail(message(body), { knownThread: true })).text).toBe(body.split('\n\n')[0]?.trim());
  });
  it.each(clientMarkers)('shapes %s client markers only for known history', async (_client, signature, history) => {
    const raw = message(`<p>NEW</p>${signature}${history}`, 'Content-Type: text/html; charset=utf-8');
    expect((await parseEmail(raw, { knownThread: true })).text).toBe('NEW');
    expect((await parseEmail(raw)).text).toContain('HISTORY');
    expect((await parseEmail(raw, { quotedHistory: 'never', stripSignatures: false, knownThread: true })).text).toContain('SIGNATURE');
    expect((await parseEmail(raw, { quotedHistory: 'always' })).text).not.toContain('HISTORY');
  });

  it('lets the binding owner determine known history from metadata without another MIME parse', async () => {
    const raw = message('<p>NEW</p><div class="gmail_quote">HISTORY</div>', 'References: <root@example.test>\r\nContent-Type: text/html; charset=utf-8');
    const known = await parseEmail(raw, { knownThread: (identity) => emailThreadKey(identity) === '<root@example.test>' });
    expect(known.text).toBe('NEW');
    const unknown = await parseEmail(raw, { knownThread: () => false });
    expect(unknown.text).toContain('HISTORY');
  });

  it.each(['On Monday, Alice wrote:', 'Le lundi, Alice a écrit :', 'Am Montag schrieb Alice:'])('strips localized reply lines and quotes while preserving interleaved new answers (%s)', async (header) => {
    const raw = message(`FIRST\n${header}\n> OLD\nSECOND\n-- \nSIGNATURE`);
    expect((await parseEmail(raw, { knownThread: true })).text).toBe('FIRST\nSECOND');
    expect((await parseEmail(raw)).text).toContain('OLD');
  });

  it.each(['From: Alice\nSent: Monday', 'De : Alice\nEnvoyé : lundi', 'Von: Alice\nGesendet: Montag'])('removes the localized Outlook header block (%s)', async (header) => {
    expect((await parseEmail(message(`NEW\n${header}\nTo: team\nSubject: OLD\nHISTORY`), { knownThread: true })).text).toBe('NEW');
  });

  it('removes a plaintext signature without consuming deliberately retained history', async () => {
    const parsed = await parseEmail(message('NEW\n-- \nSIGNATURE\nOn Monday Alice wrote:\n> HISTORY'));
    expect(parsed.text).toContain('HISTORY');
    expect(parsed.text).not.toContain('SIGNATURE');
  });

  it('preserves flowed quote-depth boundaries and delsp while joining each paragraph once', async () => {
    const raw = message('NEW \nWORD\n> OLD \n> QUOTE\nANSWER\n-- \nSIGNATURE', 'Content-Type: text/plain; charset=utf-8; format=flowed; delsp=yes');
    expect((await parseEmail(raw, { knownThread: true })).text).toBe('NEWWORD\nANSWER');
    expect((await parseEmail(raw, { quotedHistory: 'never', stripSignatures: false })).text).toBe('NEWWORD\n> OLDQUOTE\nANSWER\n--\nSIGNATURE');
  });

  it('ends a flowed paragraph at an empty fixed line', async () => {
    const raw = message('FIRST \n\nSECOND', 'Content-Type: text/plain; format=flowed');
    expect((await parseEmail(raw)).text).toBe('FIRST\nSECOND');
  });

  it('keeps unquoted and quoted flowed signature delimiters as fixed lines', async () => {
    const own = message('NEW \n-- \nSIGNATURE', 'Content-Type: text/plain; format=flowed');
    expect((await parseEmail(own)).text).toBe('NEW');
    const quoted = message('> OLD \n> -- \n> SIGNATURE\nANSWER', 'Content-Type: text/plain; format=flowed');
    expect((await parseEmail(quoted, { quotedHistory: 'never', stripSignatures: false })).text).toBe('> OLD\n> --\n> SIGNATURE\nANSWER');
  });

  it('retains forwarded discussion and its signature under aggressive history stripping', async () => {
    const raw = message('<p>Please intake</p><div class="gmail_signature">OWN SIGNATURE</div><div class="gmail_quote">---------- Forwarded message ---------<p>LEAD</p><div class="gmail_signature">LEAD SIGNATURE</div><blockquote>EARLIER LEAD</blockquote></div>', 'Content-Type: text/html; charset=utf-8', 'Fwd: Lead');
    const parsed = await parseEmail(raw, { quotedHistory: 'always' });
    expect(parsed.forwarded).toBe(true);
    expect(parsed.text).toContain('LEAD SIGNATURE');
    expect(parsed.text).toContain('EARLIER LEAD');
    expect(parsed.text).not.toContain('OWN SIGNATURE');
  });

  it.each(['---------- Forwarded message ---------', 'Début du message transféré :', '-------- Weitergeleitete Nachricht --------'])('keeps localized plaintext forwards and forwarded signatures (%s)', async (marker) => {
    const parsed = await parseEmail(message(`Please intake\n-- \nOWN SIGNATURE\n${marker}\nFrom: customer@example.test\nLEAD\n> DISCUSSION\n-- \nCUSTOMER SIGNATURE`), { quotedHistory: 'always' });
    expect(parsed.forwarded).toBe(true);
    expect(parsed.text).toContain('DISCUSSION');
    expect(parsed.text).toContain('CUSTOMER SIGNATURE');
    expect(parsed.text).not.toContain('OWN SIGNATURE');
  });

  it('keeps Outlook-style forwarded headers while stripping only the forwarder signature', async () => {
    const parsed = await parseEmail(message('Please intake\n-- \nOWN SIGNATURE\nFrom: customer@example.test\nSent: Monday\nLEAD\n-- \nCUSTOMER SIGNATURE', 'Content-Type: text/plain', 'FW: Lead'), { quotedHistory: 'always' });
    expect(parsed.text).toContain('CUSTOMER SIGNATURE');
    expect(parsed.text).not.toContain('OWN SIGNATURE');
  });

  it('removes hidden content and trackers before Markdown or text conversion, retaining structured visible content', async () => {
    const html = '<!-- SECRET --><script>SECRET</script><style>SECRET</style><div hidden>SECRET</div><div style="display: none !important">SECRET</div><span style="visibility:hidden">SECRET</span><span style="font-size:0px">SECRET</span><p><a href="https://example.test">Link</a></p><ul><li>Item</li></ul><table><tr><th>Product</th><th>Qty</th></tr><tr><td>Chair</td><td>2</td></tr></table><img src="https://example.test/track" width="1" height="1"><img src="cid:lead" alt="Drawing">';
    const raw = message(html, 'Content-Type: text/html; charset=utf-8');
    const markdown = (await parseEmail(raw)).text;
    const rendered = load(await marked.parse(markdown));
    expect(rendered('a').attr('href')).toBe('https://example.test');
    expect(rendered('ul > li').text()).toBe('Item');
    expect(rendered('table th').map((_index, cell) => rendered(cell).text()).get()).toEqual(['Product', 'Qty']);
    expect(rendered('table td').map((_index, cell) => rendered(cell).text()).get()).toEqual(['Chair', '2']);
    expect(markdown).toContain('Drawing');
    expect(markdown).not.toMatch(/SECRET|track|<script|<table/);
    const text = (await parseEmail(raw, { bodyFormat: 'text' })).text;
    expect(text).toContain('Chair');
    expect(text).not.toMatch(/SECRET|track|\[Link\]/);
  });

  it('removes content hidden by stylesheet selectors before discarding styles', async () => {
    const raw = message('<style>.hidden { display: /*comment*/ none !important } #zero { font-size:0px } div > .invisible {visibility:hidden}</style><p>VISIBLE</p><p class="hidden">SECRET ONE</p><p id="zero">SECRET TWO</p><div><span class="invisible">SECRET THREE</span></div>', 'Content-Type: text/html; charset=utf-8');
    for (const bodyFormat of ['markdown', 'text'] as const) {
      expect((await parseEmail(raw, { bodyFormat })).text).toBe('VISIBLE');
    }
  });

  it('recognizes CSS-escaped hidden declarations', async () => {
    const raw = message('<p>VISIBLE</p><span style="d\\69splay:n\\6f ne">SECRET</span><span style="font-size:0.0px">SECRET ZERO</span>', 'Content-Type: text/html; charset=utf-8');
    expect((await parseEmail(raw)).text).toBe('VISIBLE');
  });

  it('drops CSS-sized tracking pixels while retaining visible image content', async () => {
    const raw = message('<style>.tracker {width:1px;height:1px}</style><p>VISIBLE</p><img class="tracker" src="https://example.test/class-tracker"><img style="width:1px;height:1px" src="https://example.test/inline-tracker"><img style="width:0;height:0" src="https://example.test/zero-tracker"><img width="200" height="120" src="https://example.test/photo" alt="Photo">', 'Content-Type: text/html; charset=utf-8');
    const parsed = await parseEmail(raw);
    expect(parsed.text).not.toContain('tracker');
    expect(parsed.text).toContain('Photo');
  });

  it('preserves topmost duplicate raw headers and never reads embedded headers as top-level identity', async () => {
    const raw = message('Authentication-Results: forged; dmarc=pass\nFrom: forged@example.test', 'Authentication-Results: trusted;\r\n dmarc=fail\r\nAuthentication-Results: forged; dmarc=pass\r\nReferences: <root@example.test> <parent@example.test>\r\nIn-Reply-To: <parent@example.test>\r\nContent-Type: text/plain');
    const parsed = await parseEmail(raw);
    expect(parsed.headers.get('authentication-results')).toEqual(['trusted; dmarc=fail', 'forged; dmarc=pass']);
    expect(parsed.from).toBe('sales@example.test');
    expect(parsed.sender).toBe('sales@example.test');
    expect(parsed.references).toEqual(['<root@example.test>', '<parent@example.test>']);
    expect(parsed.inReplyTo).toBe('<parent@example.test>');
  });

  it('returns calendar invites and real files, excluding only signature-only inline CID images', async () => {
    const body = '--parts\r\nContent-Type: text/html\r\n\r\n<p>Lead <img src="cid:shared" alt="Photo"><img src="cid:body" alt="Plan"></p><div class="gmail_signature"><img src="cid:logo"><img src="cid:shared"></div>\r\n' +
      ['logo', 'shared', 'body', 'unreferenced'].map((id) => `--parts\r\nContent-Type: image/png\r\nContent-Disposition: inline; filename="${id}.png"\r\nContent-ID: <${id}>\r\nContent-Transfer-Encoding: base64\r\n\r\naW1hZ2U=\r\n`).join('') +
      '--parts\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="quote.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\ncGRm\r\n--parts\r\nContent-Type: text/calendar; method=REQUEST\r\n\r\nBEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n--parts--';
    const raw = message(body, 'MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="parts"');
    const parsed = await parseEmail(raw);
    expect(parsed.attachments.map((item) => item.name)).toEqual(['shared.png', 'body.png', 'unreferenced.png', 'quote.pdf', 'invite.ics']);
    expect(parsed.attachments.find((item) => item.name === 'quote.pdf')?.bytes).toEqual(new Uint8Array(Buffer.from('pdf')));
    expect(parsed.attachments.at(-1)?.mediaType).toBe('text/calendar');
    const unstripped = await parseEmail(raw, { stripSignatures: false });
    expect(unstripped.attachments.map((item) => item.name)).toContain('logo.png');
    expect(unstripped.attachments.find((item) => item.name === 'quote.pdf')?.attachmentId).toBe(parsed.attachments.find((item) => item.name === 'quote.pdf')?.attachmentId);
  });

  it('retains a CID image used in both body and signature when the body URL is percent-encoded', async () => {
    const raw = message('--parts\r\nContent-Type: text/html\r\n\r\n<p><img src="cid:shared%40example.test" alt="Plan"></p><div class="gmail_signature"><img src="cid:shared@example.test"></div>\r\n--parts\r\nContent-Type: image/png\r\nContent-Disposition: inline; filename="plan.png"\r\nContent-ID: <shared@example.test>\r\nContent-Transfer-Encoding: base64\r\n\r\naW1hZ2U=\r\n--parts--', 'Content-Type: multipart/related; boundary="parts"');
    expect((await parseEmail(raw)).attachments.map((file) => file.name)).toEqual(['plan.png']);
  });

  it.each(['base64', '8bit'])('inlines %s nested .eml as forwarded provenance and retains the original plus nested files', async encoding => {
    const nested = message('--inner\r\nContent-Type: text/plain\r\n\r\nLEAD\n-- \nLEAD SIGNATURE\r\n--inner\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="lead.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\ncGRm\r\n--inner--', 'Authentication-Results: spoof; dmarc=pass\r\nContent-Type: multipart/mixed; boundary="inner"', 'Lead');
    const raw = message(`--outer\r\nContent-Type: text/plain\r\n\r\nPlease intake\r\n--outer\r\nContent-Type: message/rfc822\r\nContent-Disposition: ${encoding === 'base64' ? 'attachment' : 'inline'}; filename="forward.eml"\r\nContent-Transfer-Encoding: ${encoding}\r\n\r\n${nested.toString(encoding === 'base64' ? 'base64' : 'utf8')}\r\n--outer--`, 'Content-Type: multipart/mixed; boundary="outer"');
    const parsed = await parseEmail(raw, { quotedHistory: 'always' });
    expect(parsed.forwarded).toBe(true);
    expect(parsed.text).toContain('Forwarded email (untrusted)');
    expect(parsed.text).toContain('LEAD SIGNATURE');
    expect(parsed.headers.has('authentication-results')).toBe(false);
    expect(parsed.attachments.map((item) => item.name)).toEqual(['forward.eml', 'lead.pdf']);
    expect(parsed.attachments[0]?.bytes).toEqual(new Uint8Array(nested));
    expect(parsed.attachments[0]?.attachmentId).not.toBe(parsed.attachments[1]?.attachmentId);
    expect(readConversationAttachmentIdV1(parsed.attachments[1]!.attachmentId, 'email'))
      .toEqual(encoding === 'base64' ? ['mime:2', 'mime:2'] : ['mime:2.2']);
  });

  it('rejects ambiguous From identities for downstream trust', async () => {
    expect((await parseEmail(message('hello', 'From: other@example.test\r\nContent-Type: text/plain'))).from).toBeNull();
  });

  it('keeps an unnamed inline message readable without creating a message file', async () => {
    const nested = message('INLINE LEAD', 'Content-Type: text/plain', 'Lead');
    const raw = message(`--outer\r\nContent-Type: text/plain\r\n\r\nPlease intake\r\n--outer\r\nContent-Type: message/rfc822\r\nContent-Disposition: inline\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${nested.toString()}\r\n--outer--`, 'Content-Type: multipart/mixed; boundary="outer"');
    const parsed = await parseEmail(raw);
    expect(parsed.text).toContain('Please intake');
    expect(parsed.text).toContain('INLINE LEAD');
    expect(parsed.attachments).toEqual([]);
  });

  it('gives an attached message without a filename an .eml name and retains its bytes', async () => {
    const nested = message('LEAD', 'Content-Type: text/plain', 'Lead');
    const raw = message(`--outer\r\nContent-Type: message/rfc822\r\nContent-Disposition: attachment\r\nContent-Transfer-Encoding: 7bit\r\n\r\n${nested.toString()}\r\n--outer--`, 'Content-Type: multipart/mixed; boundary="outer"');
    const parsed = await parseEmail(raw);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]).toMatchObject({ name: expect.stringMatching(/\.eml$/), mediaType: 'message/rfc822', bytes: new Uint8Array(nested) });
  });
});
