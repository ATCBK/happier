# Email shaping fixtures

`seed1-forwarded-attachments.eml` is the original retained LIVE13/seed1 QA
harness message `3-wilson.eml`, captured read-only from nl3 on 2026-10-21.
Its addresses and lead content were authored for the QA harness. The fixture
uses LF in the repository; the transport regression restores its original CRLF
and was checked byte-for-byte against all 2,125 retained bytes. The native
`message/rfc822` part is inline 8bit, which Mailparser flattens; the PDF remains
attachment `mime:3` under the derivation preceding commit `dd247000f8`.
This vector protects retained occurrence evidence across attachment-ID codec
changes; it is not a captured mail-client sample.

The four `.eml` files in this directory come from Mailgun Talon's client-reply
corpus, pinned to commit `e288a5809675e2b47041c22ed5fb5d077ba91221`:
https://github.com/mailgun/talon/tree/e288a5809675e2b47041c22ed5fb5d077ba91221/tests/fixtures/standard_replies

Upstream identifies these as Outlook, Gmail, Apple Mail and Thunderbird replies.
Apple Mail and Thunderbird identify the client in headers; Outlook contains
Microsoft Word-generated HTML. These are inherited upstream client samples,
not messages captured by Happier or an assertion that all modern clients match.
The capture procedure and original accounts are not documented upstream.

Happier replaced personal names, addresses, message identifiers and remote URLs
with fixture values. The `X-Fixture-Modified` header records those modifications.
MIME boundaries, encodings, client markers and reply layout are retained.
The upstream Apache 2.0 license is included in `LICENSE.talon.txt`; upstream has
no `NOTICE` file at this commit.

These inherited samples are English. The twelve `*-{fr,en,de}-markup.eml`
fixtures are anonymized, constructed MIME messages, not captured client mail.
They use the client reply structures documented by the upstream corpus and
the client-marker cases in `parse.test.ts`: Outlook `Signature` and
`divRplyFwdMsg`, Gmail `gmail_signature` and `gmail_quote`, Apple Mail
`AppleMailSignature` and `blockquote type="cite"`, and Thunderbird
`moz-signature`, `moz-cite-prefix` and cited blockquotes. Localized payload and
reply-header text is authored for French, English and German. Each file labels
this basis in `X-Fixture-Kind`.

The constructed files exercise multipart alternatives, quoted-printable UTF-8,
history retention/removal, signature-only images versus body images, hidden
content, tracking pixels and calendar attachments through the actual MIME
parser. Trust, forwarded `.eml` files and outbound composition also have the
adjacent owner-level vectors in `trust.test.ts`, `parse.test.ts` and
`compose.test.ts`. These are representative regression inputs, not a claim
about every client version or actual receiving-server authentication headers.

The orchestrator accepted these realistic localized fixtures for the current
implementation corpus on 2026-10-12. Real captured French/German messages and
current Batiplus client samples remain a follow-up: the orchestrator will ask
Wilson for anonymized captures. They do not block this implementation gate.

The two `outlook-*.body.txt` samples are inherited body-only fixtures from
`crisp-oss/email-reply-parser` at commit
`340eff4458b90597e240be1c5d836db10a7e777b` (MIT; `LICENSE.crisp.txt`):

- French Outlook iOS: `test/fixtures/email_ios_outlook_fr.txt`, introduced in
  https://github.com/crisp-oss/email-reply-parser/commit/50a8e7057d276fb204c486348ac57d8660b0d9c7
  with an explicit Outlook iOS French attribution.
- German Outlook: `test/fixtures/email_german_outlook.txt`, introduced in
  https://github.com/crisp-oss/email-reply-parser/commit/2c6f88b2391acf30654d6b7748c5a8d0a5d17955
  with an explicit German Outlook attribution.

Happier anonymized identity/date/URL fields and capitalized payload words while
retaining line layout and client markers. Tests construct the RFC headers;
these files are not full captured RFC messages, and upstream does not document
the original capture procedure. They add source-backed localized client-body
shapes; full captured-message verification remains the follow-up above. No source-backed FR/DE
Gmail, Apple Mail or Thunderbird sample was found in the inspected Mailparser,
Talon, GitHub/Zapier email-reply-parser, or Crisp/Will Durand language corpora.
