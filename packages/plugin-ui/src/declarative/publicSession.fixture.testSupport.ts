import { externalTableVisual } from '../../fixtures/external-authoring/src/sessionVisuals.js';

export const publicSessionDeclarativeDocument = { version: 1, root: { kind: 'stack', children: [
    { kind: 'markdown', text: '**Experiment result**' },
    externalTableVisual.item.source.document.root,
    { kind: 'state', state: 'error', title: 'Source unavailable', description: 'The shared source cannot be reached.' },
] } };
