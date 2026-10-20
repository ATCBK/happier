# Discord channel provider

Development / unreleased.

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
