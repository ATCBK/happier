import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { endianness } from 'node:os';

/** Filesystem boundary fixture shared by the reader's contract and loaded probes. */
export async function createLinuxVitalsFixture() {
    const root = await mkdtemp(join(tmpdir(), 'happier-vitals-linux-'));
    const put = async (path: string, value: string | Uint8Array) => {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), value);
    };
    await put('/proc/stat', 'cpu 100 20 30 400 50 0 0 10 0 0\ncpu0 100 20 30 400 50 0 0 10 0 0\nbtime 100\n');
    await put('/proc/meminfo', 'MemTotal: 100000 kB\nMemAvailable: 40000 kB\nMemFree: 1000 kB\nCached: 10000 kB\nSReclaimable: 1000 kB\nShmem: 1000 kB\nSlab: 2000 kB\nKernelStack: 100 kB\nPageTables: 100 kB\nSwapTotal: 10000 kB\nSwapFree: 8000 kB\n');
    await put('/proc/vmstat', 'pswpin 0\npswpout 0\noom_kill 0\n');
    await put('/proc/pressure/memory', 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n');
    await put('/proc/zoneinfo', 'Node 0, zone Normal\n pages free 100\n min 10\n low 20\n high 30\n');
    await put('/proc/self/smaps', 'KernelPageSize: 4 kB\n');
    const wordBytes = process.arch === 'ia32' || process.arch === 'arm' ? 4 : 8;
    const auxv = Buffer.alloc(wordBytes * 4);
    if (wordBytes === 8) {
        if (endianness() === 'LE') { auxv.writeBigUInt64LE(6n, 0); auxv.writeBigUInt64LE(4096n, 8); }
        else { auxv.writeBigUInt64BE(6n, 0); auxv.writeBigUInt64BE(4096n, 8); }
    } else if (endianness() === 'LE') { auxv.writeUInt32LE(6, 0); auxv.writeUInt32LE(4096, 4); }
    else { auxv.writeUInt32BE(6, 0); auxv.writeUInt32BE(4096, 4); }
    await put('/proc/self/auxv', auxv);
    await put('/proc/loadavg', '1.0 2.0 3.0 1/100 23\n');
    await put('/proc/self/cgroup', '0::/\n');
    await put('/proc/self/mountinfo', '1 0 8:1 / / rw - ext4 /dev/sda rw\n2 1 8:1 / /bind rw - ext4 /dev/sda rw\n3 1 8:2 / /data rw - ext4 /dev/sdb rw\n');
    await put('/proc/net/dev', 'Inter-| Receive | Transmit\n eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0\n veth0: 9000 0 0 0 0 0 0 0 9000 0 0 0 0 0 0 0\n');
    await mkdir(join(root, '/sys/class/net/eth0'), { recursive: true });
    await mkdir(join(root, '/sys/class/net/veth0'), { recursive: true });
    return { root, put, cleanup: async () => { await rm(root, { recursive: true, force: true }); } };
}
