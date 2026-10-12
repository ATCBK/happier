// nl2 measurements: 16,803 watches for one CLI/server stack, 221,994 across
// 124 instances. Watches allow >9x current fleet demand; the queue holds >4
// events per watched input (next power of two). Keep the existing 1024-instance
// policy for observed exhaustion of the platform's 128 default.
export function buildLinuxInotifyScript() {
  return `
set -eu
inotify_file=/etc/sysctl.d/60-happier-inotify.conf
install -d -m 0755 /etc/sysctl.d
inotify_candidate="$(mktemp "$inotify_file.XXXXXX")"
trap 'rm -f -- "$inotify_candidate"' EXIT
inotify_instances="$(sysctl -n fs.inotify.max_user_instances)"
inotify_watches="$(sysctl -n fs.inotify.max_user_watches)"
inotify_queue="$(sysctl -n fs.inotify.max_queued_events)"
[ "$inotify_instances" -ge 1024 ] || inotify_instances=1024
[ "$inotify_watches" -ge 2097152 ] || inotify_watches=2097152
[ "$inotify_queue" -ge 131072 ] || inotify_queue=131072
printf '%s\\n' "fs.inotify.max_user_instances=$inotify_instances" "fs.inotify.max_user_watches=$inotify_watches" "fs.inotify.max_queued_events=$inotify_queue" > "$inotify_candidate"
if ! cmp -s -- "$inotify_candidate" "$inotify_file"; then
  chmod 0644 "$inotify_candidate"
  mv -f -- "$inotify_candidate" "$inotify_file"
fi
rm -f -- "$inotify_candidate"
trap - EXIT
if [ "$(sysctl -n fs.inotify.max_user_instances)" != "$inotify_instances" ] ||
   [ "$(sysctl -n fs.inotify.max_user_watches)" != "$inotify_watches" ] ||
   [ "$(sysctl -n fs.inotify.max_queued_events)" != "$inotify_queue" ]; then
  sysctl -p "$inotify_file"
fi
[ "$(sysctl -n fs.inotify.max_user_instances)" = "$inotify_instances" ] &&
[ "$(sysctl -n fs.inotify.max_user_watches)" = "$inotify_watches" ] &&
[ "$(sysctl -n fs.inotify.max_queued_events)" = "$inotify_queue" ] || {
  echo 'Happier inotify policy did not take effect' >&2; exit 1;
}
`;
}
