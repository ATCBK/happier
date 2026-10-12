//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"golang.org/x/sys/windows"
)

func storageRenameWindowsParent(path string) (*workspaceConfinedHeldPath, string, error) {
	cleaned, _, domainErr := workspaceConfinedNTAbsolutePath(path)
	if domainErr != nil {
		return nil, "", fmt.Errorf("invalid storage path: %s", domainErr.code)
	}
	volumeRoot := filepath.VolumeName(cleaned) + `\`
	parent := filepath.Dir(cleaned)
	relative, err := filepath.Rel(volumeRoot, parent)
	if err != nil {
		return nil, "", err
	}
	var held *workspaceConfinedHeldPath
	if relative == "." {
		_, ntRoot, domainErr := workspaceConfinedNTAbsolutePath(volumeRoot)
		if domainErr != nil {
			return nil, "", fmt.Errorf("invalid storage volume: %s", domainErr.code)
		}
		root, err := openWorkspaceConfinedAbsoluteRoot(ntRoot)
		if err != nil {
			return nil, "", err
		}
		held = &workspaceConfinedHeldPath{rootPath: volumeRoot, handles: []workspaceConfinedHandle{root}, missingIndex: -1}
	} else {
		var domainErr *workspaceConfinedDomainError
		held, domainErr = openWorkspaceConfinedHeldPath(volumeRoot, relative, false)
		if domainErr != nil {
			return nil, "", fmt.Errorf("unsafe storage parent: %s", domainErr.code)
		}
	}
	if held.missingIndex >= 0 || held.final().kind != workspaceConfinedKindDirectory {
		held.close()
		return nil, "", fmt.Errorf("storage parent is missing or not a directory")
	}
	return held, filepath.Base(cleaned), nil
}

func renameStorageLeafNoReplace(source, target string, expected *storageRenameIdentity) error {
	from, fromName, err := storageRenameWindowsParent(source)
	if err != nil {
		return err
	}
	defer from.close()
	to, toName, err := storageRenameWindowsParent(target)
	if err != nil {
		return err
	}
	defer to.close()
	for _, held := range []*workspaceConfinedHeldPath{from, to} {
		if err := held.revalidate(); err != nil {
			return fmt.Errorf("storage parent changed: %s", err.code)
		}
	}
	// FILE_OPEN_NO_RECALL (NtCreateFile) and attributes-only access avoid
	// hydrating cloud leaves; FILE_OPEN_REPARSE_POINT is set by the shared owner.
	leaf, err := openWorkspaceConfinedRelativeHandle(from.final().handle, fromName, windows.DELETE|windows.FILE_READ_ATTRIBUTES|windows.SYNCHRONIZE, workspaceConfinedShareMode, 0x00400000)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(leaf.handle)
	if !expected.matches(strconv.FormatUint(uint64(leaf.info.VolumeSerialNumber), 10), strconv.FormatUint(uint64(leaf.info.FileIndexHigh)<<32|uint64(leaf.info.FileIndexLow), 10)) {
		return storageRenameChanged
	}
	// The shared handle rename sets ReplaceIfExists=0 and targets the held parent.
	err = renameWorkspaceConfinedHandle(leaf.handle, to.final().handle, toName)
	if errors.Is(err, windows.STATUS_OBJECT_NAME_COLLISION) {
		return os.ErrExist
	}
	return err
}
