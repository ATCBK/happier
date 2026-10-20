# Discord channel provider

Development / unreleased.

## Inbound files

Gateway messages retain native attachment descriptors alongside their content,
including messages containing only files. Signed CDN URLs and bytes are never
stored in observations. The declared `attachmentFetch` Action refreshes the
owning message through authenticated REST, then downloads the exact native file
from `https://cdn.discordapp.com` without bot credentials or redirects. The
existing Channels `channel-file` owner handles Session materialization; Discord
creates no temporary files or Session writes. Embeds remain non-input.

The [Attachment object](https://docs.discord.com/developers/resources/message#attachment-object)
and [signed CDN URL contract](https://docs.discord.com/developers/reference#signed-attachment-cdn-urls)
were checked on 2026-10-20 against REST v10. Discord documents upload limits,
which do not establish an inbound download cap, so this provider adds none.
Deleted messages/files, expired downloads and provider failures return explicit
unavailable results. Fetch batches use the existing all-or-nothing core contract;
one unavailable file makes the requested batch unavailable. Outbound files
remain out of scope. Loaded-provider validation requires a refreshed runtime.

## Ingress ordering

`discordIngressScheduler.ts` runs one task at a time for each connection and
endpoint pair, preserving received message order. Other endpoints progress
independently, including while a busy endpoint waits on Discord's HTTP
`retry_after`. Worker cancellation removes queued work before it can start.

The scheduler has no fixed admission-concurrency or backlog counts. The former
8 / 64 / 512 defaults had no provider or measured resource basis and could reject
received messages before Channels admission. Queue-count overflow is therefore
absent; real lookup or admission failures still use the Gateway worker's existing
`applicationAdmissionLost` reporting. Pending work is process-local and remains
inside Discord's disclosed best-effort-before-durable-admission window.

Discord's [Gateway limits](https://docs.discord.com/developers/events/gateway#rate-limiting)
govern sending events and starting sessions, while its
[HTTP rate limits](https://docs.discord.com/developers/topics/rate-limits)
govern requests and provider retry delays (checked 2026-10-20). Those contracts
do not derive a received-message queue count.
