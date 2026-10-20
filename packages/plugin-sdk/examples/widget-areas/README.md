# Widget areas

This 0.3 development-source example counts files or folders on its serving machine,
embeds a personal widget area, and demonstrates typed entity drag-and-drop.

From this directory, run `happier plugins dev`. Use the managed authoring commands
`happier plugins dev typecheck .` and `happier plugins dev build .` after edits.
The existing development registration watches the source; it does not need a
separate install or another watcher.

Open **Widget areas** and drag **Directory check** onto the inspection target.
You can also carry a Session from My work onto that target. The declared client
runtime validates the reference and proposes the `inspect-drop` Action; the host
owns admission, Action policy, execution, and retirement. The Action opens the
reference on this page without modifying the Session or sending a message.
`entityContract.ts` supplies the same closed schemas to declarations and runtime.

The gallery offers two counters with the same directory and Files/Folders inputs:
**Directory count** uses native UI, while **Directory count for snapshots** reads
a declarative document from the registered `count-document` Resource. Add the
latter to a Session Board, choose its inputs, and wait for the actual count.
The document uses literal metric data, which the canonical snapshot projector can
freeze without retaining its Resource or directory binding. Once the current
document is ready, **Post a snapshot** previews its displayed values through the
same host capture path as saved declarative widgets. Confirming publishes that
frozen output as a Session Board item. The SDK test exercises the real directory
read and proves that freezing its output preserves the displayed count after the
directory changes.

The example uses public SDK and plugin-ui entrypoints. It does not provide a
third-party PR source, share a viewer's credentials, or publish anything on hover.
