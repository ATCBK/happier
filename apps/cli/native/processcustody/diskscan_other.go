//go:build !linux && !darwin && !windows

package main

import (
	"errors"
	"path/filepath"
)

func diskNormalizePath(path string) string { return filepath.Clean(path) }

func diskOpenRoot(string) (diskDirectory, error) {
	return nil, errors.New("disk scanning is unavailable on this platform")
}
func diskReadMetadata(string, ...map[string]diskMetadata) (diskMetadata, error) {
	return diskMetadata{}, errors.New("disk measurement is unavailable on this platform")
}
func diskSetBackgroundPriority() error {
	return errors.New("background priority is unavailable on this platform")
}
func diskMeasureSharedExtents(_ string, meta diskMetadata) (int64, int64, error) {
	return 0, meta.allocatedBytes, errors.New("shared extent measurement is unavailable on this platform")
}
func diskShouldSkip(string, string, diskMetadata) (bool, string) { return true, "unsupported_platform" }
