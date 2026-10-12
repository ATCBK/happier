//go:build linux

package main

import (
	"fmt"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

func storageRenameLinuxParent(path string) (*workspaceConfinedLinuxPath, error) {
	parent := filepath.Dir(path)
	if parent == "/" {
		root, err := openWorkspaceConfinedLinuxRoot("/")
		if err != nil {
			return nil, err
		}
		return &workspaceConfinedLinuxPath{rootPath: "/", handles: []workspaceConfinedLinuxHandle{root}}, nil
	}
	held, err := openWorkspaceConfinedLinuxPath("/", strings.TrimPrefix(parent, "/"))
	if err != nil {
		return nil, fmt.Errorf("unsafe storage parent: %s", err.code)
	}
	if held.missing || held.handles[len(held.handles)-1].kind != workspaceConfinedKindDirectory {
		held.close()
		return nil, fmt.Errorf("storage parent is missing or not a directory")
	}
	return held, nil
}

func renameStorageLeafNoReplace(source, target string, expected *storageRenameIdentity) error {
	from, err := storageRenameLinuxParent(source)
	if err != nil {
		return err
	}
	defer from.close()
	to, err := storageRenameLinuxParent(target)
	if err != nil {
		return err
	}
	defer to.close()
	for _, held := range []*workspaceConfinedLinuxPath{from, to} {
		if len(held.components) > 0 {
			if err := held.revalidate(); err != nil {
				return fmt.Errorf("storage parent changed: %s", err.code)
			}
		}
	}
	fromParent, toParent := from.handles[len(from.handles)-1].fd, to.handles[len(to.handles)-1].fd
	var stat unix.Stat_t
	if err := unix.Fstatat(fromParent, filepath.Base(source), &stat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return err
	}
	if !expected.matches(strconv.FormatUint(uint64(stat.Dev), 10), strconv.FormatUint(stat.Ino, 10)) {
		return storageRenameChanged
	}
	return unix.Renameat2(fromParent, filepath.Base(source), toParent, filepath.Base(target), unix.RENAME_NOREPLACE)
}
