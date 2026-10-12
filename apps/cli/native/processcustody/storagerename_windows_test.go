//go:build windows

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStorageRenameOwnerWindowsExtendedPaths(t *testing.T) {
	root := t.TempDir()
	parent := filepath.Join(root, strings.Repeat("long-path-", 20), strings.Repeat("nested-", 20))
	if err := os.MkdirAll(parent, 0700); err != nil {
		t.Fatal(err)
	}
	source, target := filepath.Join(parent, "source"), filepath.Join(parent, "target")
	if err := os.WriteFile(source, []byte("intact"), 0600); err != nil {
		t.Fatal(err)
	}
	if result := storageRenameTestRun(t, `\\?\`+source, `\\?\`+target); result.Status != "renamed" {
		t.Fatalf("extended-path rename: %#v", result)
	}
	data, err := os.ReadFile(target)
	if err != nil || string(data) != "intact" {
		t.Fatalf("destination: %q %v", data, err)
	}
}
