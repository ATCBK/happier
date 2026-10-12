"""Linux CI wait4 measurement beneath the existing foreground group custodian."""

import errno
import json
import os
import signal
import subprocess
import sys
import threading
import time


def process_sample():
    processes = {}
    for name in os.listdir('/proc'):
        if not name.isdecimal():
            continue
        try:
            with open(f'/proc/{name}/status', encoding='utf-8') as source:
                fields = dict(line.split(':', 1) for line in source if ':' in line)
            processes[int(name)] = (int(fields['PPid']), int(fields.get('VmRSS', '0').split()[0]))
        except (OSError, ValueError, KeyError):
            # Exit/reap can race this read; absent processes have no resident pages.
            continue
    return processes


def tree_rss(processes, root):
    members = {root}
    while True:
        additions = {pid for pid, (parent, _rss) in processes.items() if parent in members} - members
        if not additions:
            return sum(processes.get(pid, (0, 0))[1] for pid in members)
        members.update(additions)


def measurement_root(processes):
    ancestors = []
    current = os.getpid()
    while current > 1 and current in processes:
        ancestors.append(current)
        current = processes[current][0]
    admitted = os.environ.get('HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN', '').split(':')[0]
    if admitted.isdecimal() and int(admitted) in ancestors:
        return int(admitted), 'admitted-command'
    # The foreground custodian is this adapter's parent; its parent is the
    # canonical compiler runner. Include both plus the measurement adapter.
    custodian = os.getppid()
    return processes.get(custodian, (custodian, 0))[0], 'compiler-runner'


# The custodian broadcasts cancellation to this same process group. Keep this
# leaf alive until the compiler finishes so its result and descendants retain
# custody even when the compiler handles TERM gracefully or delays completion.
for cancellation in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    signal.signal(cancellation, lambda _signal, _frame: None)

try:
    started_at = time.monotonic()
    child = subprocess.Popen(sys.argv[2:])
except OSError as error:
    result = {"error": {"message": str(error), "code": errno.errorcode.get(error.errno)}}
else:
    root_pid, root_scope = measurement_root(process_sample())
    peaks = {'aggregateMaxRssKiB': 0, 'ancestorMaxRssKiB': 0}
    stopped = threading.Event()

    def sample_memory():
        while not stopped.is_set():
            processes = process_sample()
            aggregate = tree_rss(processes, root_pid)
            compiler = tree_rss(processes, child.pid)
            peaks['aggregateMaxRssKiB'] = max(peaks['aggregateMaxRssKiB'], aggregate)
            peaks['ancestorMaxRssKiB'] = max(peaks['ancestorMaxRssKiB'], aggregate - compiler)
            stopped.wait(0.1)

    sampler = threading.Thread(target=sample_memory, daemon=True)
    sampler.start()
    _, status, usage = os.wait4(child.pid, 0)
    stopped.set()
    sampler.join()
    child.returncode = os.waitstatus_to_exitcode(status)
    result = {
        "status": os.WEXITSTATUS(status) if os.WIFEXITED(status) else None,
        "signal": signal.Signals(os.WTERMSIG(status)).name if os.WIFSIGNALED(status) else None,
        "maxRssKiB": usage.ru_maxrss,
        "elapsedMs": round((time.monotonic() - started_at) * 1000),
        "aggregateRootPid": root_pid,
        "aggregateRootScope": root_scope,
        **peaks,
    }

with open(sys.argv[1], "w", encoding="utf-8") as report:
    json.dump(result, report)
