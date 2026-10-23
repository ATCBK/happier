# Background Indexer

This maintained reference plugin uses only public Plugin SDK imports and the one
public author path, `definePlugin(...)`. Its single source module declares one
daemon-local `workspace-index` database and one `process` + `demand`
`workspace-indexer` background service in unreleased 0.3 development source. The
`refresh` Action demands a finite run and awaits its settlement, forwarding
cancellation through the returned handle. Cancelling rejects only that caller's
handle; it does not wait for shared child teardown. The author build projects the cold
`.happier-plugin/plugin.json` from that same module, so there is no
hand-maintained manifest to keep in sync. The runner opens the database through
`context.services.storage.daemon.database(...)`, writes an index heartbeat, and
verifies it with a bounded query.

The host launches the runner in a supervised Happier child and lets that child
exit after the run settles. Its database calls, including migration and
transaction callbacks, reach the daemon's bound storage owner through the
shared process-service bridge. The plugin creates no scheduler, launcher, host
import, or private database driver access. The host owns database path
derivation, migration safety, currentness, cancellation, quotas, and
close/reload behavior.

Run the normal external-author commands from this directory:

```sh
hdev plugins dev typecheck .
hdev plugins test .
hdev plugins dev
```

The source workload measurement is gated by
`HAPPIER_RUN_DAEMON_DATABASE_WORKLOAD=1` in the CLI database owner test. Managed source-development activation/restart/reload and Windows/Linux/macOS
evidence remain separate live product gates on the existing stack.
