package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDiskFullDiskAccessPositiveEvidence(t *testing.T) {
	home := t.TempDir()
	database := filepath.Join(home, "Library", "Application Support", "com.apple.TCC", "TCC.db")
	for _, path := range []string{filepath.Dir(database), filepath.Join(home, "Library", "Mail"), filepath.Join(home, "Library", "Messages")} {
		if err := os.MkdirAll(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(database, nil, 0600); err != nil {
		t.Fatal(err)
	}
	// This models only the OS access boundary, with real fixture opens beneath it.
	probe := func(path string, directory bool) error {
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		return file.Close()
	}
	if state := diskFullDiskAccessState(home, probe); state != "granted" {
		t.Fatalf("positive database+two vault proofs ignored: %s", state)
	}
	if err := os.Remove(filepath.Join(home, "Library", "Messages")); err != nil {
		t.Fatal(err)
	}
	if state := diskFullDiskAccessState(home, probe); state != "unknown" {
		t.Fatalf("one readable vault is not a grant: %s", state)
	}
	if state := diskFullDiskAccessState(home, func(string, bool) error { return os.ErrNotExist }); state != "unknown" {
		t.Fatalf("nothing probeable is not a grant: %s", state)
	}
	if state := diskFullDiskAccessState(home, func(string, bool) error { return os.ErrPermission }); state != "not_granted" {
		t.Fatalf("denial is not unknown/granted: %s", state)
	}
}
