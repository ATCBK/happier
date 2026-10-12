//go:build darwin

package main

import (
	"fmt"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

func storageRenameDarwinParent(path string) (*workspaceConfinedDarwinHeldPath, error) {
	parent := filepath.Dir(path)
	if parent == "/" {
		_, root, err := openWorkspaceConfinedDarwinRoot("/")
		if err != nil {
			return nil, err
		}
		return &workspaceConfinedDarwinHeldPath{rootPath: "/", handles: []workspaceConfinedDarwinHandle{root}, missingIndex: -1}, nil
	}
	held, err := openWorkspaceConfinedDarwinHeldPath("/", strings.TrimPrefix(parent, "/"))
	if err != nil {
		return nil, fmt.Errorf("unsafe storage parent: %s", err.code)
	}
	if held.missingIndex >= 0 || held.final().kind != workspaceConfinedKindDirectory {
		held.close()
		return nil, fmt.Errorf("storage parent is missing or not a directory")
	}
	return held, nil
}

func renameStorageLeafNoReplace(source, target string, expected *storageRenameIdentity) error {
	from, err := storageRenameDarwinParent(source)
	if err != nil {
		return err
	}
	defer from.close()
	to, err := storageRenameDarwinParent(target)
	if err != nil {
		return err
	}
	defer to.close()
	for _, held := range []*workspaceConfinedDarwinHeldPath{from, to} {
		if len(held.components) > 0 {
			if err := held.revalidate(); err != nil {
				return fmt.Errorf("storage parent changed: %s", err.code)
			}
		}
	}
	fromParent, toParent := from.final().fd, to.final().fd
	var stat unix.Stat_t
	if err := unix.Fstatat(fromParent, filepath.Base(source), &stat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return err
	}
	if !expected.matches(strconv.FormatUint(uint64(stat.Dev), 10), strconv.FormatUint(stat.Ino, 10)) {
		return storageRenameChanged
	}
	return unix.RenameatxNp(fromParent, filepath.Base(source), toParent, filepath.Base(target), unix.RENAME_EXCL)
}
