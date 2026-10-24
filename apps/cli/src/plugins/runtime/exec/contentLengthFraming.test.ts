import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { attachContentLengthFrameReader, encodeContentLengthFrame } from './contentLengthFraming';

describe('content-length framing', () => {
    it('decodes fragmented and coalesced frames with headers above 8 KiB in transport order', async () => {
        const stream = new PassThrough();
        const frames: number[][] = [];
        const onError = vi.fn();
        attachContentLengthFrameReader(stream, (frame) => frames.push([...frame]), {
            maxFrameBytes: 4,
            onError,
            onTrailingPartialFrame: () => undefined,
        });
        const headerValueOffset = Buffer.byteLength('Content-Length: ');
        const first = encodeContentLengthFrame(new Uint8Array([0, 1, 2, 3]));
        const encoded = Buffer.concat([
            first.subarray(0, headerValueOffset),
            Buffer.from('0'.repeat(9 * 1024), 'ascii'),
            first.subarray(headerValueOffset),
            encodeContentLengthFrame(new Uint8Array([4])),
        ]);

        stream.write(encoded.subarray(0, 5));
        stream.write(encoded.subarray(5, 9 * 1024));
        stream.end(encoded.subarray(9 * 1024));

        expect(onError).not.toHaveBeenCalled();
        await expect.poll(() => frames).toEqual([[0, 1, 2, 3], [4]]);
    });

    it('rejects a frame at max plus one before delivering payload', async () => {
        const stream = new PassThrough();
        const onError = vi.fn();
        const onFrame = vi.fn();
        attachContentLengthFrameReader(stream, onFrame, {
            maxFrameBytes: 4,
            onError,
            onTrailingPartialFrame: () => undefined,
        });

        stream.end(encodeContentLengthFrame(new Uint8Array(5)));

        await expect.poll(() => onError).toHaveBeenCalledTimes(1);
        expect(onFrame).not.toHaveBeenCalled();
    });

    it('rejects non-ASCII header bytes before decoding can mask their high bits', async () => {
        const stream = new PassThrough();
        const onError = vi.fn();
        const onFrame = vi.fn();
        attachContentLengthFrameReader(stream, onFrame, {
            onError,
            onTrailingPartialFrame: () => undefined,
        });
        const malformed = encodeContentLengthFrame(new Uint8Array([1]));
        malformed[0] = 0xc3;

        stream.end(Buffer.concat([
            malformed,
            encodeContentLengthFrame(new Uint8Array([2])),
        ]));

        await expect.poll(() => onError).toHaveBeenCalledTimes(1);
        expect(onFrame).not.toHaveBeenCalled();
    });

    it.each([
        'Content-Length: -1',
        'Content-Length: 1.5',
        'Content-Length: nope',
        'Content-Length: 9007199254740992',
        'Content-Type: application/json',
        'Content-Length: 2\r\nContent-Length: 2',
        'Content-Length: 2\r\nContent-Length: nope',
    ])('fails closed on malformed framing without a payload budget: %s', async (header) => {
        const stream = new PassThrough();
        const onError = vi.fn();
        const onFrame = vi.fn();
        attachContentLengthFrameReader(stream, onFrame, {
            onError,
            onTrailingPartialFrame: () => undefined,
        });

        stream.end(Buffer.concat([
            Buffer.from(`${header}\r\n\r\n{}`, 'ascii'),
            encodeContentLengthFrame(new Uint8Array([1])),
        ]));

        await expect.poll(() => onError).toHaveBeenCalledTimes(1);
        expect(onFrame).not.toHaveBeenCalled();
    });
});
