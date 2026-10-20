# Telegram Channels

In unreleased 0.3 development source, inbound photos, documents, audio, voice,
video and animations use the shared Channels attachment materializer. Captions
and caption entities retain the same addressing and provenance rules as text.
Photos select the largest valid native size; an animation's duplicate document
entry produces one attachment.

Observation retains descriptors and opaque native file identities. Session
materialization revalidates the selected bot, calls `getFile` for a fresh path,
and downloads from Telegram with redirects disabled. Tokens, download URLs and
file bytes are never included in observation descriptors. The provider creates
no temporary files or attachment store.

The Cloud Bot API supports downloads up to 20 MiB. Larger files retain their
descriptors and return typed `notReady` / `unsupported` during materialization;
download failures also return typed unavailability. The existing fetch operation
returns one result for a requested batch, so a failed file makes that batch
unavailable. Session file delivery follows the existing same-machine Channels
contract. Outbound file delivery is outside this implementation.

Provider basis, retrieved 2026-10-20: [Telegram `getFile`](https://core.telegram.org/bots/api#getfile)
documents the 20 MB limit and download links valid for at least one hour;
the [official Cloud Bot API implementation](https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Client.h)
defines the exact byte boundary as `20 << 20`. Fetching resolves the path again
on every invocation instead of retaining an expiring URL.
