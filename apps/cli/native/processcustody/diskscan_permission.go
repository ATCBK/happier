package main

import (
	"errors"
	"os"
	"path/filepath"
)

type diskPermissionRecord struct {
	V              int                `json:"v"`
	Type           string             `json:"type"`
	FullDiskAccess diskFullDiskAccess `json:"fullDiskAccess"`
}
type diskFullDiskAccess struct {
	State             string               `json:"state"`
	Binary            diskPermissionBinary `json:"binary"`
	WaitingForConsent bool                 `json:"waitingForConsent"`
}
type diskPermissionBinary struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

func diskPermissionIdentity(state string) (diskPermissionRecord, error) {
	path, err := os.Executable()
	if err != nil {
		return diskPermissionRecord{}, err
	}
	return diskPermissionRecord{V: 1, Type: "permission", FullDiskAccess: diskFullDiskAccess{State: state, Binary: diskPermissionBinary{Name: filepath.Base(path), Path: path}}}, nil
}

// Only positive protected-path access proves a grant. Missing paths prove
// nothing; denial is not reinterpreted as an empty, readable vault.
func diskFullDiskAccessState(home string, probe func(string, bool) error) string {
	denied := false
	access := func(path string, directory bool) bool {
		err := probe(filepath.Join(home, path), directory)
		denied = denied || errors.Is(err, os.ErrPermission)
		return err == nil
	}
	for _, path := range []string{"Desktop", "Documents", "Downloads"} {
		access(path, true)
	}
	database := access(filepath.Join("Library", "Application Support", "com.apple.TCC", "TCC.db"), false)
	vaults := 0
	for _, path := range []string{"Mail", "Messages", "Safari"} {
		if access(filepath.Join("Library", path), true) {
			vaults++
		}
	}
	if denied {
		return "not_granted"
	}
	if database && vaults >= 2 {
		return "granted"
	}
	return "unknown"
}
