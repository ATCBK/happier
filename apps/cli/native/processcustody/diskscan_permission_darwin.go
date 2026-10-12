//go:build darwin

package main

import (
	"context"
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

func diskDarwinPermissionAccess(path string, directory bool) error {
	parent, name, _, err := darwinDiskOpenParent(path)
	if err != nil {
		return err
	}
	defer unix.Close(parent)
	var stat unix.Stat_t
	if err := unix.Fstatat(parent, name, &stat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return err
	}
	if stat.Flags&unix.SF_DATALESS != 0 || stat.Mode&unix.S_IFMT == unix.S_IFLNK {
		return errors.New("permission probe is not a local leaf")
	}
	options := unix.O_RDONLY | unix.O_NOFOLLOW | unix.O_CLOEXEC | unix.O_NONBLOCK
	if directory {
		options |= unix.O_DIRECTORY
	} else if stat.Mode&unix.S_IFMT != unix.S_IFREG {
		return errors.New("permission database is not a regular file")
	}
	fd, err := unix.Openat(parent, name, options, 0)
	if err != nil {
		return err
	}
	// Access only: no file contents or directory listing is read.
	return unix.Close(fd)
}

func diskEmitPermission(ctx context.Context, emit func(any) error) error {
	record, err := diskPermissionIdentity("unknown")
	if err != nil {
		return err
	}
	record.FullDiskAccess.WaitingForConsent = true
	if err := emit(record); err != nil {
		return err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		record.FullDiskAccess.WaitingForConsent = false
		return emit(record)
	}
	result := make(chan string, 1)
	go func() { result <- diskFullDiskAccessState(home, diskDarwinPermissionAccess) }()
	select {
	case record.FullDiskAccess.State = <-result:
		record.FullDiskAccess.WaitingForConsent = false
		return emit(record)
	case <-ctx.Done():
		// The helper exits without retaining a consent-blocked syscall worker.
		return ctx.Err()
	}
}
