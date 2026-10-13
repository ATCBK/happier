# Generated from mutagen_runtime.mjs; do not edit.
# Regenerate: node apps/stack/scripts/utils/dev_targets/native_execution_projection.mjs --write-sync-policy
classify_clean_mutagen_readiness() {
  if [ "$sync_fact_scanProblems" = 1 ] && [ "$sync_fact_transientScanProblems" = 1 ]; then
    sync_readiness=rescan
    return
  fi
  if [ "$sync_fact_scanProblems" = 1 ]; then
    sync_readiness=unhealthy
    return
  fi
  if [ "$sync_fact_transientTransitionProblems" = 1 ]; then
    sync_readiness=rescan
    return
  fi
  if [ "$sync_fact_cyclesValid" = 0 ]; then
    sync_readiness=synchronizing
    return
  fi
  if [ "$sync_fact_watching" = 1 ] && [ "$sync_fact_noWatch" = 1 ] && [ "$sync_fact_completed" = 0 ]; then
    sync_readiness=needs-flush
    return
  fi
  if [ "$sync_fact_scanned" = 0 ]; then
    sync_readiness=synchronizing
    return
  fi
  if [ "$sync_fact_completed" = 0 ]; then
    sync_readiness=synchronizing
    return
  fi
  sync_readiness=ready
}
classify_transient_mutagen_transition_errors() {
  printf '%s\n' "$1" | grep -Eiv '(^|: )unable to validate existing file: modification detected$|(^|: )unable to relocate staged file: file exists$|(^|: )leaf name does not exist( or has incorrect casing)?$|unable to set staged file permissions: .*(: no such file or directory|: The system cannot find the file specified\.)$' >/dev/null
  case "$?" in 1) return 0 ;; *) return 1 ;; esac
}
classify_transient_mutagen_scan_errors() {
  printf '%s\n' "$1" | grep -Eiv '^hashed size mismatch: [0-9]+ != [0-9]+$' >/dev/null
  case "$?" in 1) return 0 ;; *) return 1 ;; esac
}
