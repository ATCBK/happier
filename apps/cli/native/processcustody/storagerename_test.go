package main

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

type storageRenameTestResult struct {
	V      int    `json:"v"`
	Status string `json:"status"`
	Code   string `json:"code,omitempty"`
}

func TestStorageRenameOwnerExactBytePaths(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("NTFS paths use Unicode rather than raw POSIX bytes")
	}
	root := storageRenameTestRoot(t)
	raw, twin, target := filepath.Join(root, string([]byte{0xff})), filepath.Join(root, "�"), filepath.Join(root, string([]byte{0xfe}))
	if err := os.WriteFile(raw, []byte("raw"), 0600); err != nil {
		t.Skipf("filesystem does not accept byte path: %v", err)
	}
	if err := os.WriteFile(twin, []byte("twin"), 0600); err != nil {
		t.Fatal(err)
	}
	if result := storageRenameTestRun(t, diskPathID(raw), diskPathID(target)); result.Status != "renamed" {
		t.Fatalf("byte rename failed: %#v", result)
	}
	data, err := os.ReadFile(target)
	if err != nil || string(data) != "raw" {
		t.Fatalf("byte target: %q %v", data, err)
	}
	data, err = os.ReadFile(twin)
	if err != nil || string(data) != "twin" {
		t.Fatalf("replacement twin changed: %q %v", data, err)
	}
}

func storageRenameTestRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func storageRenameTestCommand(t *testing.T, source, target string) *exec.Cmd {
	t.Helper()
	request, err := json.Marshal(map[string]string{"sourcePath": source, "targetPath": target})
	if err != nil {
		t.Fatal(err)
	}
	child := exec.Command(os.Args[0], "-test.run=^TestDiskCommandProcess$")
	child.Env = append(os.Environ(), "HAPPIER_TEST_DISK_COMMAND=storage-rename")
	child.Stdin = bytes.NewReader(request)
	return child
}

func storageRenameTestRun(t *testing.T, source, target string) storageRenameTestResult {
	t.Helper()
	child := storageRenameTestCommand(t, source, target)
	var stderr bytes.Buffer
	child.Stderr = &stderr
	output, err := child.Output()
	if err != nil {
		t.Fatalf("storage rename failed: %v; stderr=%s", err, stderr.String())
	}
	var result storageRenameTestResult
	if err := json.Unmarshal(output, &result); err != nil {
		t.Fatal(err)
	}
	if result.V != 1 {
		t.Fatalf("invalid response: %s", output)
	}
	return result
}

func TestStorageRenameOwnerNoReplace(t *testing.T) {
	for _, kind := range []string{"file", "directory", "symlink"} {
		t.Run(kind, func(t *testing.T) {
			root := storageRenameTestRoot(t)
			source, target := filepath.Join(root, "source"), filepath.Join(root, "target")
			switch kind {
			case "file":
				if err := os.WriteFile(source, []byte("source"), 0600); err != nil {
					t.Fatal(err)
				}
			case "directory":
				if err := os.Mkdir(source, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(source, "bytes"), []byte("source"), 0600); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				if err := os.Symlink("missing-leaf", source); err != nil {
					t.Skipf("symlink fixture unavailable: %v", err)
				}
			}
			// Existing destination bytes must survive the refused operation.
			if err := os.WriteFile(target, []byte("retained"), 0600); err != nil {
				t.Fatal(err)
			}
			if result := storageRenameTestRun(t, source, target); result.Status != "failed" || result.Code != "destination_occupied" {
				t.Fatalf("occupied result: %#v", result)
			}
			retained, err := os.ReadFile(target)
			if err != nil || string(retained) != "retained" {
				t.Fatalf("destination overwritten: %s %v", retained, err)
			}
			if _, err := os.Lstat(source); err != nil {
				t.Fatalf("source changed on refusal: %v", err)
			}
			if err := os.Remove(target); err != nil {
				t.Fatal(err)
			}
			if result := storageRenameTestRun(t, source, target); result.Status != "renamed" {
				t.Fatalf("rename failed: %#v", result)
			}
			if _, err := os.Lstat(source); !os.IsNotExist(err) {
				t.Fatalf("source remains: %v", err)
			}
			if kind == "symlink" {
				link, err := os.Readlink(target)
				if err != nil || link != "missing-leaf" {
					t.Fatalf("leaf followed: %q %v", link, err)
				}
			} else {
				file := target
				if kind == "directory" {
					file = filepath.Join(target, "bytes")
				}
				data, err := os.ReadFile(file)
				if err != nil || string(data) != "source" {
					t.Fatalf("bytes changed: %q %v", data, err)
				}
			}
		})
	}
}

func TestStorageRenameOwnerOccupiedDirectoryAndDanglingLeaf(t *testing.T) {
	for _, kind := range []string{"directory", "dangling-symlink"} {
		t.Run(kind, func(t *testing.T) {
			root := storageRenameTestRoot(t)
			source, target := filepath.Join(root, "source"), filepath.Join(root, "target")
			if err := os.WriteFile(source, []byte("source"), 0600); err != nil {
				t.Fatal(err)
			}
			if kind == "directory" {
				if err := os.Mkdir(target, 0700); err != nil {
					t.Fatal(err)
				}
			} else if err := os.Symlink("missing", target); err != nil {
				t.Skipf("symlink fixture unavailable: %v", err)
			}
			if result := storageRenameTestRun(t, source, target); result.Code != "destination_occupied" {
				t.Fatalf("occupied result: %#v", result)
			}
			if _, err := os.Lstat(source); err != nil {
				t.Fatalf("source disappeared: %v", err)
			}
			info, err := os.Lstat(target)
			if err != nil || (kind == "directory" && !info.IsDir()) || (kind == "dangling-symlink" && info.Mode()&os.ModeSymlink == 0) {
				t.Fatalf("destination changed: %v %v", info, err)
			}
		})
	}
}

func TestStorageRenameOwnerConcurrentDestination(t *testing.T) {
	root := storageRenameTestRoot(t)
	target := filepath.Join(root, "target")
	sources := []string{filepath.Join(root, "one"), filepath.Join(root, "two")}
	children := make([]*exec.Cmd, 2)
	outputs := make([]bytes.Buffer, 2)
	for i, source := range sources {
		if err := os.WriteFile(source, []byte(filepath.Base(source)), 0600); err != nil {
			t.Fatal(err)
		}
		children[i] = storageRenameTestCommand(t, source, target)
		children[i].Stdout = &outputs[i]
		children[i].Stderr = os.Stderr
		if err := children[i].Start(); err != nil {
			t.Fatal(err)
		}
	}
	winner := -1
	for i, child := range children {
		if err := child.Wait(); err != nil {
			t.Fatal(err)
		}
		var result storageRenameTestResult
		if err := json.Unmarshal(outputs[i].Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if result.Status == "renamed" {
			if winner >= 0 {
				t.Fatal("both concurrent renames succeeded")
			}
			winner = i
		} else if result.Code != "destination_occupied" {
			t.Fatalf("unexpected failure: %#v", result)
		}
	}
	if winner < 0 {
		t.Fatal("neither rename succeeded")
	}
	data, err := os.ReadFile(target)
	if err != nil || string(data) != filepath.Base(sources[winner]) {
		t.Fatalf("winner overwritten: %q %v", data, err)
	}
	if _, err := os.Lstat(sources[1-winner]); err != nil {
		t.Fatalf("loser source lost: %v", err)
	}
}

func TestStorageRenameOwnerRefusesSymlinkParents(t *testing.T) {
	for _, side := range []string{"source", "target"} {
		t.Run(side, func(t *testing.T) {
			root := storageRenameTestRoot(t)
			outside := filepath.Join(root, "outside")
			if err := os.Mkdir(outside, 0700); err != nil {
				t.Fatal(err)
			}
			alias := filepath.Join(root, "alias")
			if err := os.Symlink(outside, alias); err != nil {
				t.Skipf("symlink fixture unavailable: %v", err)
			}
			source, target := filepath.Join(root, "source"), filepath.Join(root, "target")
			actualSource := source
			if side == "source" {
				source = filepath.Join(alias, "source")
				actualSource = filepath.Join(outside, "source")
			} else {
				target = filepath.Join(alias, "target")
			}
			if err := os.WriteFile(actualSource, []byte("retained"), 0600); err != nil {
				t.Fatal(err)
			}
			if result := storageRenameTestRun(t, source, target); result.Status != "failed" {
				t.Fatalf("symlink parent accepted: %#v", result)
			}
			data, err := os.ReadFile(actualSource)
			if err != nil || string(data) != "retained" {
				t.Fatalf("source touched: %q %v", data, err)
			}
			if _, err := os.Lstat(target); !os.IsNotExist(err) {
				t.Fatalf("destination touched: %v", err)
			}
		})
	}
}

func TestStorageRenameOwnerRejectsChangedSourceIdentity(t *testing.T) {
	root := storageRenameTestRoot(t)
	source, target := filepath.Join(root, "source"), filepath.Join(root, "target")
	if err := os.WriteFile(source, []byte("retained"), 0600); err != nil {
		t.Fatal(err)
	}
	request, err := json.Marshal(map[string]any{"sourcePath": source, "targetPath": target, "expectedIdentity": map[string]string{"dev": "0", "ino": "0"}})
	if err != nil {
		t.Fatal(err)
	}
	child := storageRenameTestCommand(t, source, target)
	child.Stdin = bytes.NewReader(request)
	output, err := child.CombinedOutput()
	if err != nil {
		t.Fatalf("identity request rejected by parser: %v %s", err, output)
	}
	var result storageRenameTestResult
	if err := json.Unmarshal(output, &result); err != nil {
		t.Fatal(err)
	}
	if result.Code != "changed_since_review" {
		t.Fatalf("changed identity accepted: %#v", result)
	}
	if _, err := os.Lstat(source); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(target); !os.IsNotExist(err) {
		t.Fatalf("destination touched: %v", err)
	}
}
