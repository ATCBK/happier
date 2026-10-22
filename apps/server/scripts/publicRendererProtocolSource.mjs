import { resolve } from 'node:path';

/** Source-generated renderers share the workspace protocol, never a private installed copy. */
export function createPublicRendererProtocolSourcePlugin(projectDir) {
    return { name: 'public-renderer-protocol-source', setup(builder) {
        builder.onResolve({ filter: /^@happier-dev\/protocol(?:\/|$)/ }, args => {
            if (args.path === '@happier-dev/protocol/sharing/public-viewer') {
                return { path: resolve(projectDir, '../../packages/protocol/src/sharing/publicViewer.ts') };
            }
            if (args.pluginData?.publicRendererWorkspaceProtocol) return;
            return builder.resolve(args.path, { kind: args.kind, resolveDir: resolve(projectDir, '../..'),
                pluginData: { publicRendererWorkspaceProtocol: true } })
                .then(result => ({ ...result, pluginData: undefined }));
        });
    } };
}
