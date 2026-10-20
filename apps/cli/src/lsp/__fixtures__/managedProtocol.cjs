// External stdio process boundary for the canonical managed-launch composition.
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], JSON.stringify({ cwd: process.cwd(), owner: process.env.HAPPIER_PROCESS_OWNER }));
let pending = Buffer.alloc(0);
process.stdin.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
        const end = pending.indexOf('\r\n\r\n');
        if (end < 0) return;
        const length = Number(/Content-Length:\s*(\d+)/i.exec(pending.subarray(0, end).toString())[1]);
        if (pending.length < end + 4 + length) return;
        const message = JSON.parse(pending.subarray(end + 4, end + 4 + length).toString());
        pending = pending.subarray(end + 4 + length);
        if (message.method === 'echo' || message.method === 'largeReply') {
            const result = message.method === 'largeReply' ? { value: 'x'.repeat(message.params.characters) } : message.params;
            const json = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
            process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
        }
    }
});
