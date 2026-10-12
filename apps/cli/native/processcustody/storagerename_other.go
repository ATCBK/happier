//go:build !linux && !darwin && !windows

package main

import "fmt"

func renameStorageLeafNoReplace(source, target string, expected *storageRenameIdentity) error {
	return fmt.Errorf("native storage rename is unavailable on this platform")
}
