import { definePlugin } from '@happier-dev/plugin-sdk';

import { demoRuntime } from './runtime.js';

// Package-root authoring follows the maintained advanced example; the producer
// shape follows the public Connected accounts guide, without a private host seam.
export const { manifest, activate } = definePlugin({
    id: 'qa.public-connected-service',
    version: '0.1.0',
    displayName: 'QA Connected service',
    description: 'QA-only fake connected-service producer; not shipped.',
    entrypoints: { daemon: './dist/index.js', development: './src/index.ts' },
    connectedAccountDescriptors: {
        demo: {
            declaration: {
                title: 'QA Demo service',
                authentication: {
                    defaultModeId: 'manual',
                    modes: [{
                        id: 'manual', kind: 'manual', title: 'Use the QA demo token',
                        outcomeReconciliation: 'none',
                        fields: [{ id: 'token', title: 'QA demo token', secret: true,
                            schema: { type: 'string', enum: ['qa-demo-token'] } }],
                    }],
                },
            },
            runtime: demoRuntime,
        },
    },
});
