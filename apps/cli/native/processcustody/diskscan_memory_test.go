package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"runtime/pprof"
	"strconv"
	"testing"
	"time"
)

// This subprocess harness exercises the actual command/streaming encoder while
// discarding scan output. Only memory totals and symbol-only heap profiles leave
// the process; no private scan names are logged or collected by the fixture.
func TestDiskScanMemoryHelper(t *testing.T) {
	root := os.Getenv("HAPPIER_TEST_DISK_MEMORY_ROOT")
	if root == "" {
		return
	}
	request, err := json.Marshal(diskScanRequest{Root: root, DrawableNodes: 203, ScratchDirectory: storageRenameTestRoot(t)})
	if err != nil {
		t.Fatal(err)
	}
	writer := &diskMemoryWriter{profile: os.Getenv("HAPPIER_TEST_DISK_HEAP_PROFILE")}
	started := time.Now()
	err = diskScanCommand(nil, bytes.NewReader(append(request, '\n')), writer)
	writer.sample()
	if err != nil {
		t.Fatal("native memory fixture scan failed")
	}
	if writer.directories == 0 {
		t.Fatal("native memory fixture root was not enumerated")
	}
	if err := writer.writeProfile(); err != nil {
		t.Fatal("native memory fixture profile failed")
	}
	if err := json.NewEncoder(os.Stdout).Encode(struct {
		HeapBytes, SysBytes uint64
		DirectoryRecords    int
		WallMs              int64
	}{writer.peakHeap, writer.peakSys, writer.directories, time.Since(started).Milliseconds()}); err != nil {
		t.Fatal(err)
	}
}

type diskMemoryWriter struct {
	profile           string
	peakHeap, peakSys uint64
	writes            int
	directories       int
	lastProfile       time.Time
}

func (writer *diskMemoryWriter) sample() {
	// The scaling fixture distinguishes retained state from GC scheduling noise;
	// actual home profiling keeps the normal runtime and peak allocation metric.
	if os.Getenv("HAPPIER_TEST_DISK_HEAP_RETAINED") != "" {
		runtime.GC()
	}
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	if memory.HeapAlloc > writer.peakHeap {
		writer.peakHeap = memory.HeapAlloc
	}
	if memory.Sys > writer.peakSys {
		writer.peakSys = memory.Sys
	}
}

func (writer *diskMemoryWriter) Write(output []byte) (int, error) {
	writer.writes++
	if bytes.Contains(output, []byte(`"type":"dir"`)) {
		writer.directories++
	}
	if writer.writes%256 == 0 || bytes.Contains(output, []byte(`"type":"progress"`)) {
		writer.sample()
		// Test-only profiling cadence, not a scan budget, timeout, or watchdog.
		if writer.profile != "" && time.Since(writer.lastProfile) >= 30*time.Second {
			if err := writer.writeProfile(); err != nil {
				return 0, err
			}
		}
	}
	return io.Discard.Write(output)
}

func (writer *diskMemoryWriter) writeProfile() error {
	if writer.profile == "" {
		return nil
	}
	file, err := os.Create(writer.profile)
	if err != nil {
		return err
	}
	defer file.Close()
	writer.lastProfile = time.Now()
	return pprof.WriteHeapProfile(file)
}

func diskMemoryRun(t *testing.T, root string) uint64 {
	t.Helper()
	executable := os.Args[0]
	if prior := os.Getenv("HAPPIER_TEST_DISK_MEMORY_EXECUTABLE"); prior != "" {
		executable = prior
	}
	process := exec.Command(executable, "-test.run=^TestDiskScanMemoryHelper$")
	process.Env = append(os.Environ(), "HAPPIER_TEST_DISK_MEMORY_ROOT="+root, "HAPPIER_TEST_DISK_HEAP_RETAINED=1")
	var diagnostic bytes.Buffer
	process.Stderr = &diagnostic
	output, err := process.Output()
	if err != nil {
		t.Fatalf("native memory helper failed: %v; %s", err, diagnostic.String())
	}
	var measured struct{ HeapBytes uint64 }
	if err := json.NewDecoder(bytes.NewReader(output)).Decode(&measured); err != nil {
		t.Fatalf("native memory helper emitted invalid totals: %v", err)
	}
	return measured.HeapBytes
}

func TestDiskScanOwnerStreamMemoryScaling(t *testing.T) {
	makeTree := func(files, branches int) string {
		root := storageRenameTestRoot(t)
		for branch := 0; branch < branches; branch++ {
			path := filepath.Join(root, string(rune('a'+branch)), "nested")
			if err := os.MkdirAll(path, 0700); err != nil {
				t.Fatal(err)
			}
			for leaf := 0; leaf < files/branches; leaf++ {
				path := filepath.Join(path, strconv.Itoa(leaf))
				if err := os.WriteFile(path, nil, 0600); err != nil {
					t.Fatal(err)
				}
			}
		}
		return root
	}
	for _, branches := range []int{20, 1} {
		t.Run(strconv.Itoa(branches), func(t *testing.T) {
			small := diskMemoryRun(t, makeTree(2000, branches))
			large := diskMemoryRun(t, makeTree(20000, branches))
			t.Logf("retained helper heap: small=%d large=%d ratio=%.2f", small, large, float64(large)/float64(small))
			// Fixed directory fanout/depth: ten times the streamed metadata
			// must not retain ten times the scan, including one wide folder.
			if large > small*3 {
				t.Fatalf("streamed helper retained file-count-proportional heap: small=%d large=%d ratio=%.2f", small, large, float64(large)/float64(small))
			}
		})
	}
}

func TestDiskScanOwnerDirectoryFrontierMemoryScaling(t *testing.T) {
	makeTree := func(directories int) string {
		root := storageRenameTestRoot(t)
		for i := 0; i < directories; i++ {
			if err := os.MkdirAll(filepath.Join(root, strconv.Itoa(i), "nested"), 0700); err != nil {
				t.Fatal(err)
			}
		}
		return root
	}
	small := diskMemoryRun(t, makeTree(2000))
	large := diskMemoryRun(t, makeTree(20000))
	t.Logf("directory frontier retained heap: small=%d large=%d ratio=%.2f", small, large, float64(large)/float64(small))
	if large > small*3 {
		t.Fatalf("helper retained whole directory frontier/headers: small=%d large=%d ratio=%.2f", small, large, float64(large)/float64(small))
	}
}

func TestDiskScanOwnerDoesNotScanOwnedScratch(t *testing.T) {
	root := storageRenameTestRoot(t)
	scratch := filepath.Join(root, "owned-scratch")
	if err := os.Mkdir(scratch, 0700); err != nil {
		t.Fatal(err)
	}
	request, _ := json.Marshal(diskScanRequest{Root: root, ScratchDirectory: scratch, DrawableNodes: 203})
	var stream bytes.Buffer
	if err := diskScanCommand(nil, bytes.NewReader(append(request, '\n')), &stream); err != nil {
		t.Fatal(err)
	}
	var boundary bool
	var final diskDirRecord
	for _, line := range bytes.Split(bytes.TrimSpace(stream.Bytes()), []byte{'\n'}) {
		var record struct {
			Type, ID string
			Skipped  []diskIssue
		}
		if err := json.Unmarshal(line, &record); err != nil {
			t.Fatal(err)
		}
		if record.Type == "dir-start" && record.ID == scratch {
			t.Fatal("helper recursively enumerated its growing scratch")
		}
		if record.Type == "dir" && record.ID == root {
			json.Unmarshal(line, &final)
		}
		for _, skip := range record.Skipped {
			if skip.Path == scratch && skip.Reason == "scan_scratch" {
				boundary = true
			}
		}
	}
	if !boundary || final.Complete || !final.Enumerated || !final.Flags.AtLeast {
		t.Fatal("owned scratch exclusion hid incomplete root coverage")
	}
}

// The native directory adapter is the genuine OS metadata boundary. A same-
// device bind alias reports the exact held scratch identity under another name;
// this fixture supplies that OS fact without requiring privileged mounts.
type diskScratchAliasDirectory struct {
	diskDirectory
	alias   string
	scratch diskMetadata
}

func (directory diskScratchAliasDirectory) entries(ctx context.Context) ([]diskEntry, string, error) {
	entries, backend, err := directory.diskDirectory.entries(ctx)
	for i := range entries {
		if entries[i].path == directory.alias {
			entries[i].meta.identity = directory.scratch.identity
			entries[i].meta.device = directory.scratch.device
		}
	}
	return entries, backend, err
}
func TestDiskScanOwnerScratchPhysicalAlias(t *testing.T) {
	root := storageRenameTestRoot(t)
	scratch, alias := filepath.Join(root, "owned-scratch"), filepath.Join(root, "admitted-alias")
	for _, path := range []string{scratch, alias} {
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	meta, err := diskReadMetadata(scratch)
	if err != nil {
		t.Fatal(err)
	}
	opener := diskOpenDirectoryForScan
	t.Cleanup(func() { diskOpenDirectoryForScan = opener })
	diskOpenDirectoryForScan = func(path string) (diskDirectory, error) {
		directory, err := opener(path)
		if err == nil && path == root {
			return diskScratchAliasDirectory{directory, alias, meta}, nil
		}
		return directory, err
	}
	request, _ := json.Marshal(diskScanRequest{Root: root, ScratchDirectory: scratch, DrawableNodes: 203})
	var output bytes.Buffer
	if err := diskScanCommand(nil, bytes.NewReader(append(request, '\n')), &output); err != nil {
		t.Fatal(err)
	}
	var seenBoundary bool
	for _, line := range bytes.Split(bytes.TrimSpace(output.Bytes()), []byte{'\n'}) {
		var record struct {
			Type, ID string
			Skipped  []diskIssue
		}
		if err := json.Unmarshal(line, &record); err != nil {
			t.Fatal(err)
		}
		if record.Type == "dir-start" && record.ID == alias {
			t.Fatal("scan entered its own physical scratch through an admitted alias")
		}
		for _, skip := range record.Skipped {
			if skip.Path == alias && skip.Reason == "scan_scratch" {
				seenBoundary = true
			}
		}
	}
	if !seenBoundary {
		t.Fatal("physical scratch alias was not an honest skipped boundary")
	}
}
