import { existsSync } from 'node:fs';

export const LINUX_KEEP_AWAKE_READY = 'happier-keep-awake-ready\n';

export function linuxKeepAwakeInvocation(exists: (path: string) => boolean = existsSync) {
    // logind owns these runtime directories. A container or non-systemd host
    // cannot hold an inhibitor, even if systemd-inhibit happens to be installed.
    if (!exists('/run/systemd/system') || !exists('/run/systemd/seats')) return null;
    const command = ['/usr/bin/systemd-inhibit', '/bin/systemd-inhibit'].find(exists);
    const cat = ['/usr/bin/cat', '/bin/cat'].find(exists);
    if (!command || !cat) return null;
    return { command, args: ['--what=idle:sleep', '--mode=block', '--who=Happier',
        '--why=Keeping this machine reachable', cat] };
}
