//go:build linux

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

func TestDiskMeasureMixedExtentResultsPreserveUnknown(t *testing.T) {
	root := t.TempDir()
	walk := diskWalkResult{observations: map[string]*diskObservation{}, incomplete: map[string]bool{}}
	paths := []string{filepath.Join(root, "first"), filepath.Join(root, "second")}
	metadata := make([]diskMetadata, len(paths))
	for index, path := range paths {
		if err := os.WriteFile(path, bytes.Repeat([]byte{1}, 8192), 0600); err != nil {
			t.Fatal(err)
		}
		meta, err := diskReadMetadata(path)
		if err != nil {
			t.Fatal(err)
		}
		// These are the canonical facts emitted for filesystems whose sharing
		// cannot be established from directory metadata alone.
		meta.sharedExtentsUnmeasured = true
		metadata[index] = meta
		diskObserve(&walk, root, path, meta)
	}
	missing, live := 0, 1
	if diskObservationKey(metadata[missing]) > diskObservationKey(metadata[live]) {
		missing, live = live, missing
	}
	if _, _, err := diskMeasureSharedExtents(paths[live], metadata[live]); err != nil {
		t.Skipf("real FIEMAP unavailable: %v", err)
	}
	// The earlier observation disappears at the real OS boundary; the later
	// observation still has a successful FIEMAP result.
	if err := os.Remove(paths[missing]); err != nil {
		t.Fatal(err)
	}
	result := diskAggregateMeasure(walk, []string{root}, diskMeasureRequest{MeasureSharedExtents: true})
	if !result.PerPath[0].AtLeast || !result.PerPath[0].SharedExtentsUnmeasured {
		t.Fatalf("later successful extent probe erased earlier uncertainty: %#v", result.PerPath[0])
	}
}

func TestDiskMeasureOwnerMatchesIndependentDU(t *testing.T) {
	root := t.TempDir()
	nested := filepath.Join(root, "nested")
	if err := os.Mkdir(nested, 0700); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(root, "file"), filepath.Join(nested, "other")} {
		if err := os.WriteFile(path, bytes.Repeat([]byte{1}, 15000), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Link(filepath.Join(root, "file"), filepath.Join(nested, "linked")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(root, filepath.Join(nested, "loop")); err != nil {
		t.Fatal(err)
	}
	sparse, err := os.Create(filepath.Join(root, "sparse"))
	if err != nil {
		t.Fatal(err)
	}
	if err = sparse.Truncate(64 * 1024 * 1024); err != nil {
		t.Fatal(err)
	}
	sparse.Close()
	output, err := exec.Command("du", "-s", "--block-size=1", root).Output()
	if err != nil {
		t.Skipf("independent du unavailable: %v", err)
	}
	expected, err := strconv.ParseInt(strings.Fields(string(output))[0], 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		TotalAllocatedBytes int64
		TotalExclusiveBytes int64
	}
	if err = json.Unmarshal(runDiskOwner(t, "disk-measure", map[string]any{"paths": []string{root}}), &result); err != nil {
		t.Fatal(err)
	}
	if result.TotalAllocatedBytes != expected || result.TotalExclusiveBytes != expected {
		t.Fatalf("allocation differs from independent du %d: %#v", expected, result)
	}
}

func TestDiskScanOwnerUnreadableSubtreeAtLeast(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses permission boundary")
	}
	root := t.TempDir()
	child := filepath.Join(root, "denied")
	if err := os.Mkdir(child, 0000); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(child, 0700)
	var final diskDirRecord
	var summary diskSummary
	output := runDiskOwner(t, "disk-scan", map[string]any{"root": root, "keepMinBytes": 0})
	for _, line := range bytes.Split(bytes.TrimSpace(output), []byte{'\n'}) {
		var record struct{ Type string }
		json.Unmarshal(line, &record)
		if record.Type == "dir" {
			var dir diskDirRecord
			json.Unmarshal(line, &dir)
			if dir.ID == root {
				final = dir
			}
		}
		if record.Type == "summary" {
			json.Unmarshal(line, &summary)
		}
	}
	if summary.UnreadableCounts["permission"] != 1 || len(summary.Unreadable) != 1 {
		t.Fatalf("permission failure missing: %s", output)
	}
	if !final.Enumerated || final.Complete || !final.Flags.AtLeast || len(final.Children) != 1 || !final.Children[0].Flags.AtLeast {
		t.Fatalf("unreadable child was presented as complete: %#v", final)
	}
}

func TestDiskScanOwnerDisappearingDirectoriesAreIOBoundaries(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 8; i++ {
		if err := os.Mkdir(filepath.Join(root, strconv.Itoa(i)), 0700); err != nil {
			t.Fatal(err)
		}
	}
	var final diskDirRecord
	var summary diskSummary
	removed := 0
	control := &diskControl{skipped: map[string]bool{}, changed: make(chan struct{}, 1)}
	err := diskScanStream(context.Background(), control, diskScanRequest{Root: root, DrawableNodes: 203, ScratchDirectory: t.TempDir()}, func(value any) error {
		switch record := value.(type) {
		case diskEntryRecord:
			if record.Parent == root && record.ReplaceFacts && record.Node.Kind == "folder" {
				// A genuine filesystem race: discovery precedes worker admission.
				// No native enumerator or metadata logic is replaced.
				if err := os.Remove(record.Node.ID); err != nil {
					return err
				}
				removed++
			}
		case diskDirRecord:
			if record.ID == root && record.Type == "dir" {
				final = record
			}
		case diskSummary:
			summary = record
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if removed != 8 || summary.UnreadableCounts["io"] != 8 || summary.Termination != "completed" {
		t.Fatalf("disappearing directories did not report real io boundaries: removed=%d summary=%+v", removed, summary)
	}
	if final.Complete || !final.Flags.AtLeast || len(summary.Unreadable) != 1 {
		t.Fatalf("missing subtree was presented as complete or examples became unbounded: final=%+v summary=%+v", final, summary)
	}
}

func TestDiskScanOwnerMountBoundary(t *testing.T) {
	root := t.TempDir()
	mount := filepath.Join(root, "volume")
	if err := os.Mkdir(mount, 0700); err != nil {
		t.Fatal(err)
	}
	if err := unix.Mount("tmpfs", mount, "tmpfs", 0, ""); err != nil {
		t.Skipf("tmpfs fixture requires mount capability: %v", err)
	}
	defer unix.Unmount(mount, 0)
	if err := os.WriteFile(filepath.Join(mount, "foreign"), []byte("must not enter"), 0600); err != nil {
		t.Fatal(err)
	}
	output := runDiskOwner(t, "disk-scan", map[string]any{"root": root, "keepMinBytes": 0})
	found := false
	for _, line := range bytes.Split(bytes.TrimSpace(output), []byte{'\n'}) {
		var dir diskDirRecord
		if json.Unmarshal(line, &dir) != nil || dir.Type != "dir" {
			continue
		}
		if dir.ID == mount {
			t.Fatalf("entered another volume: %s", line)
		}
		for _, node := range dir.Children {
			if node.ID == mount {
				found = true
				if node.Kind != "mount" || node.AllocatedBytes != 0 {
					t.Fatalf("mount isn't a leaf: %#v", node)
				}
			}
		}
	}
	if !found {
		t.Fatalf("mount leaf missing: %s", output)
	}
}

func TestDiskScanOwnerPreservesDistinctByteNames(t *testing.T) {
	root := t.TempDir()
	names := []string{"file-\xff", "file-\xfe"}
	for _, name := range names {
		if err := os.WriteFile(filepath.Join(root, name), []byte("data"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	output := runDiskOwner(t, "disk-scan", map[string]any{"root": root, "keepMinBytes": 0})
	ids := map[string]bool{}
	rawNames := map[string]bool{}
	for _, line := range bytes.Split(bytes.TrimSpace(output), []byte{'\n'}) {
		var record diskDirRecord
		if json.Unmarshal(line, &record) != nil || record.Type != "dir" || !record.Complete || record.ID != root {
			continue
		}
		for _, node := range record.Children {
			ids[node.ID] = true
			name, err := base64.StdEncoding.DecodeString(node.NameBytes)
			if err != nil {
				t.Fatal(err)
			}
			rawNames[string(name)] = true
		}
	}
	if len(ids) != 2 || !rawNames[names[0]] || !rawNames[names[1]] {
		t.Fatalf("byte names collided or failed to round-trip: %s", output)
	}
}
