import { describe, expect, it } from 'vitest';

import { parseSafeNativeSvgXml } from './SafeNativeSvgXml';

describe('parseSafeNativeSvgXml', () => {
    it.each([
        ['malformed XML', '<svg><path></svg>'],
        ['non-SVG root', '<image href="#local"/>'],
        ['external image', '<svg><image href="https://example.com/pixel.png"/></svg>'],
        ['external filter image', '<svg><filter><feImage href="https://example.com/filter.png"/></filter></svg>'],
        ['file reference', '<svg><image xlink:href="file:///private.png"/></svg>'],
        ['protocol relative reference', '<svg><image href="//example.com/pixel.png"/></svg>'],
        ['SVG data URI', '<svg><image href="data:image/svg+xml;base64,PHN2Zy8+"/></svg>'],
        ['external paint', '<svg><rect fill="url(https://example.com/paint.svg#gradient)"/></svg>'],
        ['external styled paint', '<svg><rect style="fill:url(file:///paint.svg#gradient)"/></svg>'],
        ['event handler', '<svg onload="run()"><path/></svg>'],
        ['foreignObject', '<svg><foreignObject><image href="#local"/></foreignObject></svg>'],
        ['script', '<svg><script>run()</script></svg>'],
    ])('rejects %s', (_name, xml) => {
        expect(parseSafeNativeSvgXml(xml)).toBeNull();
    });

    it.each([
        ['drawing', '<svg><path d="M0 0h16v16H0z"/></svg>'],
        ['text', '<svg><text x="1" y="8">safe</text></svg>'],
        ['local paint', '<svg><defs><linearGradient id="paint"/></defs><rect fill="url(\'#paint\')"/></svg>'],
        ['local use', '<svg><path id="shape"/><use href="#shape"/></svg>'],
        ['raster data', '<svg><image href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/></svg>'],
    ])('keeps safe %s', (_name, xml) => {
        expect(parseSafeNativeSvgXml(xml)).not.toBeNull();
    });

    it('keeps a document combining drawings, text, fragments, and raster data', () => {
        expect(parseSafeNativeSvgXml('<svg viewBox="0 0 16 16"><defs><path id="shape" d="M0 0h16v16H0z"/></defs><use href="#shape"/><text>safe</text><image href="data:image/png;base64,iVBORw0KGgo="/></svg>')).not.toBeNull();
    });
});
