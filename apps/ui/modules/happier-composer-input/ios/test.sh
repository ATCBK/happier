#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  printf 'Usage: sh test.sh "id=<iOS simulator UDID>"\n' >&2
  exit 2
fi

native_source_root=$(cd "$(dirname "$0")" && pwd)
native_test_scratch=$(mktemp -d "${TMPDIR:-/tmp}/happier-composer-tests.XXXXXX")

# Xcode generates .swiftpm/xcode beside Package.swift. Keep that build directory
# outside the moving mirror; symlinks keep compilation on the current sources.
for native_source in Package.swift HappierComposerInputTextView.swift ComposerAttachmentDrop.swift HappierComposerInputModule.swift HappierComposerInputView.swift HappierComposerInput.podspec Tests; do
  ln -s "$native_source_root/$native_source" "$native_test_scratch/$native_source"
done

cd "$native_test_scratch"
if xcodebuild -scheme HappierComposerInputNative -destination "$1" \
  -derivedDataPath "$native_test_scratch/build" \
  -resultBundlePath "$native_test_scratch/result.xcresult" test \
  >"$native_test_scratch/xcodebuild.log" 2>&1; then
  native_test_status=0
else
  native_test_status=$?
fi
printf 'Native composer test artifacts: %s\n' "$native_test_scratch"
tail -60 "$native_test_scratch/xcodebuild.log"
exit "$native_test_status"
