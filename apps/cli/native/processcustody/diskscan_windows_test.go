//go:build windows

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
	"unicode/utf16"

	"golang.org/x/sys/windows"
)

func TestDiskWindowsRejectsBytePaths(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	target := filepath.Join(root, "target")
	if err := os.WriteFile(source, []byte("preserved"), 0600); err != nil {
		t.Fatal(err)
	}
	encoded := "bytes:" + base64.StdEncoding.EncodeToString([]byte(source))
	for command, request := range map[string]any{"disk-measure": diskMeasureRequest{Paths: []string{encoded}}, "storage-rename": storageRenameRequest{SourcePath: encoded, TargetPath: target}} {
		input, err := json.Marshal(request)
		if err != nil {
			t.Fatal(err)
		}
		child := exec.Command(os.Args[0], "-test.run=^TestDiskCommandProcess$")
		child.Env = append(os.Environ(), "HAPPIER_TEST_DISK_COMMAND="+command)
		child.Stdin = bytes.NewReader(append(input, '\n'))
		var diagnostic bytes.Buffer
		child.Stderr = &diagnostic
		output, err := child.Output()
		var exit *exec.ExitError
		if !errors.As(err, &exit) || exit.ExitCode() != 5 || len(output) != 0 {
			t.Fatalf("Windows byte input was not refused before effect: %s %s %v", output, diagnostic.String(), err)
		}
	}
	data, err := os.ReadFile(source)
	if err != nil || string(data) != "preserved" {
		t.Fatalf("byte rejection changed source: %q %v", data, err)
	}
	if _, err := os.Lstat(target); !os.IsNotExist(err) {
		t.Fatalf("byte rejection created target: %v", err)
	}
}

func diskWindowsTestRecord(name string, attributes uint32, tag uint32, fileID byte) []byte {
	words := utf16.Encode([]rune(name))
	buffer := make([]byte, 88+len(words)*2)
	binary.LittleEndian.PutUint64(buffer[24:], 116444736000000000+1700000000000*10000)
	binary.LittleEndian.PutUint64(buffer[40:], 9*1024*1024)
	binary.LittleEndian.PutUint64(buffer[48:], 4096)
	binary.LittleEndian.PutUint32(buffer[56:], attributes)
	binary.LittleEndian.PutUint32(buffer[60:], uint32(len(words)*2))
	binary.LittleEndian.PutUint32(buffer[68:], tag)
	buffer[72] = fileID
	for index, word := range words {
		binary.LittleEndian.PutUint16(buffer[88+index*2:], word)
	}
	// FILE_ID_EXTD_DIR_INFO ends its fixed fields at byte 88, not sizeof
	// a C structure whose one-character filename includes trailing padding.
	return buffer
}

func TestDiskWindowsBulkMetadataPreservesAllocationAndPlaceholderLeaves(t *testing.T) {
	for _, attributes := range []uint32{windows.FILE_ATTRIBUTE_OFFLINE, diskWindowsRecallOnOpen, diskWindowsRecallOnDataAccess} {
		record := diskWindowsTestRecord("cloud", attributes|windows.FILE_ATTRIBUTE_DIRECTORY, 0, 2)
		entries, err := diskWindowsParseDirectory(record, `C:\fixture`, "42", false)
		if err != nil || len(entries) != 1 {
			t.Fatalf("placeholder parse: %v, %v", entries, err)
		}
		if !entries[0].meta.cloudOnly || entries[0].meta.kind != "cloud-only" || entries[0].meta.allocatedBytes != 0 {
			t.Fatalf("placeholder can be descended or counted: %+v", entries[0].meta)
		}
	}
	entries, err := diskWindowsParseDirectory(diskWindowsTestRecord("sparse", 0, 0, 3), `C:\fixture`, "42", true)
	if err != nil || len(entries) != 1 {
		t.Fatalf("regular parse: %v", err)
	}
	meta := entries[0].meta
	if meta.logicalBytes != 9*1024*1024 || meta.allocatedBytes != 4096 || meta.nlink != 0 || meta.identity == "" || !meta.sharedExtentsUnmeasured {
		t.Fatalf("allocation/link certainty lost: %+v", meta)
	}
	entries, err = diskWindowsParseDirectory(diskWindowsTestRecord("mounted", windows.FILE_ATTRIBUTE_REPARSE_POINT|windows.FILE_ATTRIBUTE_DIRECTORY, windows.IO_REPARSE_TAG_MOUNT_POINT, 4), `C:\fixture`, "42", false)
	if err != nil || entries[0].meta.kind != "mount" {
		t.Fatalf("volume/junction is not a leaf: %v, %v", entries, err)
	}
}

func TestDiskWindowsBulkRejectsInvalidOffsetsAndNames(t *testing.T) {
	record := diskWindowsTestRecord("file", 0, 0, 1)
	for _, offset := range []uint32{1, 8, uint32(len(record) + 8)} {
		broken := append([]byte(nil), record...)
		binary.LittleEndian.PutUint32(broken, offset)
		if _, err := diskWindowsParseDirectory(broken, `C:\fixture`, "42", false); err == nil {
			t.Fatalf("accepted offset %d", offset)
		}
	}
	for _, name := range []string{`../escape`, `a\b`, `a:b`} {
		if _, err := diskWindowsParseDirectory(diskWindowsTestRecord(name, 0, 0, 1), `C:\fixture`, "42", false); err == nil {
			t.Fatalf("accepted unsafe name %q", name)
		}
	}
	broken := append([]byte(nil), record...)
	binary.LittleEndian.PutUint32(broken[60:], 3)
	if _, err := diskWindowsParseDirectory(broken, `C:\fixture`, "42", false); err == nil {
		t.Fatal("accepted odd UTF-16 byte count")
	}
}

func TestDiskWindowsBulkFallbackParityAndHardlinks(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "ordinary")
	if err := os.WriteFile(file, make([]byte, 8192), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(file, filepath.Join(root, "linked")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "folder"), 0700); err != nil {
		t.Fatal(err)
	}
	directory, err := diskOpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	defer directory.close()
	windowsDirectory := directory.(*diskWindowsDirectory)
	bulk, err := windowsDirectory.entriesBulk(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	fallback, err := windowsDirectory.entriesFallback(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// Bulk deliberately has unknown nlink; fallback reads true link counts.
	for index := range fallback {
		fallback[index].meta.nlink = 0
		fallback[index].meta.nlinkAttempted = false
	}
	sort.Slice(bulk, func(i, j int) bool { return bulk[i].name < bulk[j].name })
	sort.Slice(fallback, func(i, j int) bool { return fallback[i].name < fallback[j].name })
	if !reflect.DeepEqual(bulk, fallback) {
		t.Fatalf("bulk/fallback differ:\nbulk=%+v\nfallback=%+v", bulk, fallback)
	}
	meta, err := diskReadMetadata(file)
	if err != nil || meta.nlink != 2 || meta.allocatedBytes == 0 {
		t.Fatalf("hardlink metadata: %+v, %v", meta, err)
	}
	linked, err := diskReadMetadata(filepath.Join(root, "linked"))
	if err != nil || linked.identity != meta.identity {
		t.Fatalf("hardlinks have different identities: %+v, %+v, %v", meta, linked, err)
	}
}

func TestDiskWindowsSparseAllocationAndLongPath(t *testing.T) {
	root := t.TempDir()
	for len(root) < 300 {
		root = filepath.Join(root, "long-component")
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "sparse")
	_, ntPath, domainErr := workspaceConfinedNTAbsolutePath(file)
	if domainErr != nil {
		t.Fatal(domainErr.code)
	}
	name, err := windows.UTF16PtrFromString(`\\?\` + strings.TrimPrefix(ntPath, `\??\`))
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_WRITE, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.CREATE_NEW, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	var returned uint32
	err = windows.DeviceIoControl(handle, 0x000900c4, nil, 0, nil, 0, &returned, nil) // FSCTL_SET_SPARSE
	_ = windows.CloseHandle(handle)
	if err != nil {
		t.Skipf("filesystem cannot create sparse fixture: %v", err)
	}
	if err := os.Truncate(file, 8*1024*1024); err != nil {
		t.Fatal(err)
	}
	meta, err := diskReadMetadata(file)
	if err != nil || meta.logicalBytes != 8*1024*1024 || meta.allocatedBytes >= meta.logicalBytes {
		t.Fatalf("sparse allocation counted apparent bytes: %+v, %v", meta, err)
	}
	directory, err := diskOpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	defer directory.close()
	entries, _, err := directory.entries(context.Background())
	if err != nil || len(entries) != 1 || entries[0].meta.allocatedBytes != meta.allocatedBytes {
		t.Fatalf("long-path directory differs: %v, %v", entries, err)
	}
}

func TestDiskWindowsDoesNotTraverseSymlinksOrSwappedChild(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Mkdir(filepath.Join(outside, "nested"), 0700); err != nil {
		t.Fatal(err)
	}
	child := filepath.Join(root, "child")
	if err := os.Mkdir(child, 0700); err != nil {
		t.Fatal(err)
	}
	directory, err := diskOpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	defer directory.close()
	entries, _, err := directory.entries(context.Background())
	if err != nil || len(entries) != 1 {
		t.Fatalf("fixture enumerate: %v, %v", entries, err)
	}
	if err := os.Remove(child); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, child); err != nil {
		t.Skipf("directory symlink privilege unavailable: %v", err)
	}
	if opened, err := directory.openChild(entries[0]); err == nil {
		opened.close()
		t.Fatal("followed a child replaced with a reparse point")
	}
	if opened, err := diskOpenRoot(filepath.Join(child, "nested")); err == nil {
		opened.close()
		t.Fatal("followed a symlink ancestor")
	}
	meta, err := diskReadMetadata(child)
	if err != nil || (meta.kind != "symlink" && meta.kind != "mount") {
		t.Fatalf("leaf symlink must remain a leaf: %+v, %v", meta, err)
	}
}

func TestDiskWindowsPlaceholderMetadataNeverOpensTheFile(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "offline")
	if err := os.WriteFile(file, []byte("unavailable data"), 0600); err != nil {
		t.Fatal(err)
	}
	name, err := windows.UTF16PtrFromString(file)
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetFileAttributes(name, windows.FILE_ATTRIBUTE_OFFLINE); err != nil {
		t.Skipf("filesystem cannot set offline fixture: %v", err)
	}
	// An exclusive handle makes any attempted metadata open fail. Directory
	// metadata must still allow the scanner to classify and skip the placeholder.
	handle, err := windows.CreateFile(name, windows.FILE_READ_ATTRIBUTES, 0, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_OPEN_NO_RECALL, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(handle)
	meta, err := diskReadMetadata(file)
	if err != nil || !meta.cloudOnly || meta.allocatedBytes != 0 {
		t.Fatalf("placeholder was opened or counted: %+v, %v", meta, err)
	}
	directory, err := diskOpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	defer directory.close()
	entries, err := directory.(*diskWindowsDirectory).entriesFallback(context.Background())
	if err != nil || len(entries) != 1 || entries[0].err != nil || !entries[0].meta.cloudOnly {
		t.Fatalf("fallback opened the placeholder: %+v, %v", entries, err)
	}
	var measured diskMeasureResult
	if err := json.Unmarshal(runDiskOwner(t, "disk-measure", map[string]any{"paths": []string{root}}), &measured); err != nil {
		t.Fatal(err)
	}
	if measured.TotalAllocatedBytes != 0 || measured.TotalExclusiveBytes != 0 || len(measured.PerPath) != 1 || measured.PerPath[0].AtLeast {
		t.Fatalf("aggregation opened or counted the exclusive-handle placeholder: %+v", measured)
	}
}

func TestDiskWindowsMeasureOwnerSingletonAndExternalHardlink(t *testing.T) {
	fixture := t.TempDir()
	selected, outside := filepath.Join(fixture, "selected"), filepath.Join(fixture, "outside")
	for _, path := range []string{selected, outside} {
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	file := filepath.Join(selected, "ordinary")
	if err := os.WriteFile(file, bytes.Repeat([]byte("x"), 8192), 0600); err != nil {
		t.Fatal(err)
	}
	meta, err := diskReadMetadata(file)
	if err != nil || meta.nlink != 1 || meta.allocatedBytes <= 0 {
		t.Fatalf("singleton fixture metadata: %+v, %v", meta, err)
	}
	measure := func(t *testing.T, paths ...string) diskMeasureResult {
		t.Helper()
		var result diskMeasureResult
		if err := json.Unmarshal(runDiskOwner(t, "disk-measure", map[string]any{"paths": paths}), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	t.Run("singleton", func(t *testing.T) {
		result := measure(t, selected)
		if result.TotalAllocatedBytes != meta.allocatedBytes || result.TotalExclusiveBytes != meta.allocatedBytes || len(result.PerPath) != 1 || result.PerPath[0].AtLeast {
			t.Fatalf("ordinary singleton was not proven reclaimable: %+v", result)
		}
	})
	if err := os.Link(file, filepath.Join(outside, "linked")); err != nil {
		t.Fatal(err)
	}
	t.Run("unselected-external-link", func(t *testing.T) {
		result := measure(t, selected)
		if result.TotalAllocatedBytes != meta.allocatedBytes || result.TotalExclusiveBytes != 0 || len(result.PerPath) != 1 || result.PerPath[0].AtLeast {
			t.Fatalf("external link was reclaimable or left unknown: %+v", result)
		}
	})
	t.Run("complete-link-union", func(t *testing.T) {
		result := measure(t, selected, outside)
		if result.TotalAllocatedBytes != meta.allocatedBytes || result.TotalExclusiveBytes != meta.allocatedBytes || len(result.PerPath) != 2 || result.PerPath[0].AtLeast || result.PerPath[1].AtLeast {
			t.Fatalf("complete hardlink union lost reclaimable allocation: %+v", result)
		}
	})
}

func TestDiskWindowsRootMetadataReusesDistinctFileFacts(t *testing.T) {
	root := t.TempDir()
	firstPath, secondPath := filepath.Join(root, "first"), filepath.Join(root, "second")
	if err := os.WriteFile(firstPath, bytes.Repeat([]byte("x"), 8192), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(firstPath, secondPath); err != nil {
		t.Fatal(err)
	}
	knownFiles := map[string]diskMetadata{}
	first, err := diskReadMetadata(firstPath, knownFiles)
	if err != nil || first.nlink != 2 || first.allocatedBytes <= 0 {
		t.Fatalf("first alias metadata: %+v, %v", first, err)
	}
	t.Run("direct-alias-union", func(t *testing.T) {
		var result diskMeasureResult
		if err := json.Unmarshal(runDiskOwner(t, "disk-measure", map[string]any{"paths": []string{firstPath, secondPath}}), &result); err != nil {
			t.Fatal(err)
		}
		if result.TotalAllocatedBytes != first.allocatedBytes || result.TotalExclusiveBytes != first.allocatedBytes || len(result.PerPath) != 2 || result.PerPath[0].AtLeast || result.PerPath[1].AtLeast {
			t.Fatalf("two direct alias roots lost complete-link allocation: %+v", result)
		}
	})
	// Change the real OS fact between aliases: a duplicate FileStandardInfo
	// query would observe three links instead of reusing this invocation's
	// first distinct-file-ID fact. This is not a mocked call-count assertion.
	thirdPath := filepath.Join(t.TempDir(), "external")
	if err := os.Link(firstPath, thirdPath); err != nil {
		t.Fatal(err)
	}
	current, err := diskReadMetadata(secondPath)
	if err != nil || current.nlink != 3 || current.identity != first.identity {
		t.Fatalf("independent OS fact did not change: %+v, %v", current, err)
	}
	second, err := diskReadMetadata(secondPath, knownFiles)
	if err != nil || second.identity != first.identity || second.nlink != first.nlink || second.allocatedBytes != first.allocatedBytes || second.logicalBytes != first.logicalBytes {
		t.Fatalf("second root queried distinct-file facts again: first=%+v second=%+v err=%v", first, second, err)
	}
	t.Run("fallback-uses-shared-root-facts", func(t *testing.T) {
		directory, err := diskOpenRoot(root)
		if err != nil {
			t.Fatal(err)
		}
		defer directory.close()
		entries, err := directory.(*diskWindowsDirectory).entriesFallback(context.Background(), knownFiles)
		if err != nil || len(entries) != 2 {
			t.Fatalf("fallback fixture enumeration: %+v, %v", entries, err)
		}
		for _, entry := range entries {
			if entry.err != nil || entry.meta.identity != first.identity || entry.meta.nlink != first.nlink || entry.meta.allocatedBytes != first.allocatedBytes {
				t.Fatalf("fallback queried distinct-file facts again: first=%+v entry=%+v entryMeta=%+v", first, entry, entry.meta)
			}
		}
	})
	t.Run("cached-file-becomes-cloud", func(t *testing.T) {
		name, err := windows.UTF16PtrFromString(secondPath)
		if err != nil {
			t.Fatal(err)
		}
		if err := windows.SetFileAttributes(name, windows.FILE_ATTRIBUTE_OFFLINE); err != nil {
			t.Fatal(err)
		}
		handle, err := windows.CreateFile(name, windows.FILE_READ_ATTRIBUTES, 0, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_OPEN_NO_RECALL, 0)
		if err != nil {
			t.Fatal(err)
		}
		defer windows.CloseHandle(handle)
		cloud, err := diskReadMetadata(secondPath, knownFiles)
		if err != nil || !cloud.cloudOnly || cloud.kind != "cloud-only" || cloud.allocatedBytes != 0 {
			t.Fatalf("cached facts overrode cloud attributes or opened the leaf: %+v, %v", cloud, err)
		}
	})
}

func TestDiskWindowsMeasureRejectsChangedObservation(t *testing.T) {
	for _, change := range []string{"cloud", "identity", "type"} {
		t.Run(change, func(t *testing.T) {
			root := t.TempDir()
			file := filepath.Join(root, "ordinary")
			if err := os.WriteFile(file, bytes.Repeat([]byte("x"), 8192), 0600); err != nil {
				t.Fatal(err)
			}
			walk, err := diskWalk(context.Background(), []string{root}, false, diskScanRequest{})
			if err != nil {
				t.Fatal(err)
			}
			if change == "cloud" {
				name, err := windows.UTF16PtrFromString(file)
				if err != nil {
					t.Fatal(err)
				}
				if err := windows.SetFileAttributes(name, windows.FILE_ATTRIBUTE_OFFLINE); err != nil {
					t.Fatal(err)
				}
				// Any attempted leaf open after the cloud transition must fail.
				handle, err := windows.CreateFile(name, windows.FILE_READ_ATTRIBUTES, 0, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_OPEN_NO_RECALL, 0)
				if err != nil {
					t.Fatal(err)
				}
				defer windows.CloseHandle(handle)
			} else {
				// Retain the old inode outside the selected root so replacement
				// cannot immediately recycle its file ID.
				if err := os.Rename(file, filepath.Join(t.TempDir(), "old")); err != nil {
					t.Fatal(err)
				}
				if change == "type" {
					err = os.Mkdir(file, 0700)
				} else {
					err = os.WriteFile(file, []byte("replacement"), 0600)
				}
				if err != nil {
					t.Fatal(err)
				}
			}
			result := diskAggregateMeasure(walk, []string{root}, diskMeasureRequest{Paths: []string{root}})
			if result.TotalExclusiveBytes != 0 || len(result.PerPath) != 1 || !result.PerPath[0].AtLeast {
				t.Fatalf("changed %s observation promised exclusive bytes: %+v", change, result)
			}
		})
	}
}

// This opt-in benchmark measures real platform work, not boundary mocks.
// Run with -test.run=^$ -test.bench=^BenchmarkDiskWindowsMeasureCost$ -test.benchtime=1x.
func BenchmarkDiskWindowsMeasureCost(b *testing.B) {
	root := os.Getenv("HAPPIER_TEST_DISK_COST_ROOT")
	if root == "" {
		b.Skip("set HAPPIER_TEST_DISK_COST_ROOT to an existing NTFS tree or owned-fixture")
	}
	b.StopTimer()
	fixture := root == "owned-fixture"
	if fixture {
		root = b.TempDir()
		for index := 0; index < 1024; index++ {
			if err := os.WriteFile(filepath.Join(root, fmt.Sprintf("ordinary-%04d", index)), bytes.Repeat([]byte("x"), 4096), 0600); err != nil {
				b.Fatal(err)
			}
		}
	}
	for iteration := 0; iteration < b.N; iteration++ {
		b.StartTimer()
		start := time.Now()
		result, err := diskMeasure(context.Background(), diskMeasureRequest{Paths: []string{root}})
		totalElapsed := time.Since(start)
		b.StopTimer()
		if err != nil {
			b.Fatal(err)
		}
		inventoryStart := time.Now()
		walk, err := diskWalk(context.Background(), []string{root}, false, diskScanRequest{})
		if err != nil {
			b.Fatal(err)
		}
		inventoryElapsed := time.Since(inventoryStart)
		ordinary, failures := 0, 0
		var rootMeta diskMetadata
		groups := map[string][]diskEntry{}
		for _, observation := range walk.observations {
			if observation.path == root {
				rootMeta = observation.meta
			}
			if observation.meta.kind != "file" || observation.meta.cloudOnly {
				continue
			}
			ordinary++
			parent := filepath.Dir(observation.path)
			groups[parent] = append(groups[parent], diskEntry{name: filepath.Base(observation.path), path: observation.path, meta: observation.meta})
		}
		parents := make([]string, 0, len(groups))
		for parent := range groups {
			parents = append(parents, parent)
		}
		sort.Strings(parents)
		mode := os.Getenv("HAPPIER_TEST_DISK_COST_QUERY_MODE")
		if mode == "" {
			mode = "full-ancestry"
		}
		knownFiles := map[string]diskMetadata{}
		queryStart := time.Now()
		for _, parent := range parents {
			var directory diskDirectory
			if mode == "held-parent" {
				directory, err = diskOpenRoot(parent)
				if err != nil {
					failures += len(groups[parent])
					continue
				}
			} else if mode != "full-ancestry" {
				b.Fatalf("unknown query mode %q", mode)
			}
			for _, entry := range groups[parent] {
				if directory != nil {
					_, err = directory.(*diskWindowsDirectory).readEntryMetadata(entry, knownFiles)
				} else {
					_, err = diskReadMetadata(entry.path)
				}
				if err != nil {
					failures++
				}
			}
			if directory != nil {
				if err := directory.close(); err != nil {
					b.Fatal(err)
				}
			}
		}
		queryElapsed := time.Since(queryStart)
		metrics := map[string]any{
			"phase": os.Getenv("HAPPIER_TEST_DISK_COST_PHASE"), "root": root, "ownedFixture": fixture,
			"rootIdentity": rootMeta.identity, "device": rootMeta.device,
			"nodes": walk.summary.Items, "distinctOrdinaryIDs": ordinary, "queryFailures": failures,
			"queryMode": mode, "inventoryWalkMs": float64(inventoryElapsed.Microseconds()) / 1000,
			"totalWallMs": float64(totalElapsed.Microseconds()) / 1000, "queryOnlyMs": float64(queryElapsed.Microseconds()) / 1000,
			"totalAllocatedBytes": result.TotalAllocatedBytes, "totalExclusiveBytes": result.TotalExclusiveBytes,
			"measurementAtLeast": result.PerPath[0].AtLeast,
			"unreadableCounts":   walk.summary.UnreadableCounts, "backendByDirCounts": walk.summary.BackendByDirCounts,
		}
		encoded, err := json.Marshal(metrics)
		if err != nil {
			b.Fatal(err)
		}
		b.Log(string(encoded))
	}
}

func TestDiskWindowsEnumeratesMoreThanOneBuffer(t *testing.T) {
	root := t.TempDir()
	for index := 0; index < 700; index++ {
		if err := os.WriteFile(filepath.Join(root, fmt.Sprintf("entry-%04d", index)), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	directory, err := diskOpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	defer directory.close()
	for _, enumerate := range []func(context.Context) ([]diskEntry, error){directory.(*diskWindowsDirectory).entriesBulk, func(ctx context.Context) ([]diskEntry, error) {
		return directory.(*diskWindowsDirectory).entriesFallback(ctx)
	}} {
		entries, err := enumerate(context.Background())
		if err != nil || len(entries) != 700 {
			t.Fatalf("enumeration stopped at one buffer: %d, %v", len(entries), err)
		}
		seen := make(map[string]bool)
		for _, entry := range entries {
			seen[entry.name] = true
		}
		if len(seen) != 700 {
			t.Fatalf("enumeration repeated a buffer: %d unique entries", len(seen))
		}
	}
}

func TestDiskWindowsCancelledEnumerationAndPrivateDirectories(t *testing.T) {
	root := t.TempDir()
	directory, err := diskOpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	defer directory.close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := directory.entries(ctx); err != context.Canceled {
		t.Fatalf("cancelled enumeration did not return cancellation: %v", err)
	}
	for _, name := range []string{"System Volume Information", "WindowsApps"} {
		skip, reason := diskShouldSkip(filepath.Join(root, name), root, diskMetadata{kind: "folder"})
		if !skip || reason != "os_private" {
			t.Fatalf("private directory treated as empty/readable: %s, %t, %s", name, skip, reason)
		}
	}
}

func TestDiskWindowsScanOwnerUnreadableSubtreeAtLeast(t *testing.T) {
	root := t.TempDir()
	child := filepath.Join(root, "denied")
	if err := os.Mkdir(child, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(child, "unreadable"), []byte("must not be counted"), 0600); err != nil {
		t.Fatal(err)
	}
	original, err := windows.GetNamedSecurityInfo(child, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	originalACL, _, err := original.DACL()
	if err != nil {
		t.Fatal(err)
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	deniedACL, err := windows.ACLFromEntries([]windows.EXPLICIT_ACCESS{{
		AccessPermissions: windows.FILE_GENERIC_READ | windows.FILE_GENERIC_EXECUTE,
		AccessMode:        windows.DENY_ACCESS,
		Trustee: windows.TRUSTEE{
			TrusteeForm:  windows.TRUSTEE_IS_SID,
			TrusteeType:  windows.TRUSTEE_IS_USER,
			TrusteeValue: windows.TrusteeValueFromSID(user.User.Sid),
		},
	}}, originalACL)
	if err != nil {
		t.Fatal(err)
	}
	// Restore only this test-owned child's original DACL, including when an
	// assertion or privilege check exits early, before TempDir cleanup runs.
	defer func() {
		if err := windows.SetNamedSecurityInfo(child, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION, nil, nil, originalACL, nil); err != nil {
			t.Errorf("restore owned fixture DACL: %v", err)
		}
	}()
	if err := windows.SetNamedSecurityInfo(child, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION, nil, nil, deniedACL, nil); err != nil {
		if errors.Is(err, windows.ERROR_ACCESS_DENIED) || errors.Is(err, windows.ERROR_NOT_SUPPORTED) {
			t.Skipf("owned directory ACL fixture unavailable: %v", err)
		}
		t.Fatal(err)
	}
	if _, err := os.ReadDir(child); !errors.Is(err, os.ErrPermission) {
		if err == nil {
			t.Skip("current principal bypasses the owned directory's deny ACL")
		}
		t.Fatalf("ACL fixture failed to establish permission boundary: %v", err)
	}
	output := runDiskOwner(t, "disk-scan", map[string]any{"root": root, "keepMinBytes": 0})
	var final diskDirRecord
	var summary diskSummary
	for _, line := range bytes.Split(bytes.TrimSpace(output), []byte{'\n'}) {
		var record struct{ Type string }
		if err := json.Unmarshal(line, &record); err != nil {
			t.Fatal(err)
		}
		switch record.Type {
		case "dir":
			var dir diskDirRecord
			if err := json.Unmarshal(line, &dir); err != nil {
				t.Fatal(err)
			}
			if dir.ID == root {
				final = dir
			}
		case "summary":
			if err := json.Unmarshal(line, &summary); err != nil {
				t.Fatal(err)
			}
		}
	}
	if summary.Termination != "completed" || summary.UnreadableCounts["permission"] != 1 || len(summary.Unreadable) != 1 || summary.Unreadable[0].Path != child {
		t.Fatalf("owned permission failure missing: %s", output)
	}
	if !final.Enumerated || final.Complete || !final.Flags.AtLeast || len(final.Children) != 1 || final.Children[0].Name != "denied" || !final.Children[0].Flags.AtLeast {
		t.Fatalf("unreadable child presented as complete: %+v", final)
	}
}
