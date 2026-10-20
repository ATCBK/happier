//go:build darwin

package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// Darwin's directory metadata is the OS boundary. Model a firmlink's REALDEVID
// crossing while retaining real file identities, enumeration and allocation.
type diskDarwinContainerDirectory struct {
	diskDirectory
	same, foreign, sameDevice string
}

func (directory diskDarwinContainerDirectory) entries(ctx context.Context) ([]diskEntry, string, error) {
	entries, backend, err := directory.diskDirectory.entries(ctx)
	for index := range entries {
		switch entries[index].path {
		case directory.same:
			entries[index].meta.device = directory.sameDevice
		case directory.foreign:
			entries[index].meta.device = "foreign-container-device"
		}
	}
	return entries, backend, err
}

func TestDiskDarwinCommandProducesSameContainerDeviceAllowance(t *testing.T) {
	root := diskDarwinFixtureRoot(t)
	rootMeta, err := diskReadMetadata(root)
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := diskReadMetadata("/")
	if err != nil {
		t.Fatal(err)
	}
	var fs unix.Statfs_t
	if err := unix.Statfs(root, &fs); err != nil {
		t.Fatal(err)
	}
	if nativeCString(fs.Fstypename[:]) != "apfs" || sealed.device == rootMeta.device {
		t.Skip("requires separate APFS startup System and Data devices")
	}
	same, foreign := filepath.Join(root, "same-container"), filepath.Join(root, "foreign-container")
	for _, path := range []string{same, foreign} {
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(path, "ordinary"), []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	original := diskOpenDirectoryForScan
	diskOpenDirectoryForScan = func(path string) (diskDirectory, error) {
		dir, err := diskOpenRoot(path)
		if err == nil && path == root {
			return diskDarwinContainerDirectory{dir, same, foreign, sealed.device}, nil
		}
		return dir, err
	}
	defer func() { diskOpenDirectoryForScan = original }()
	request, err := json.Marshal(diskScanRequest{Root: root, ScratchDirectory: storageRenameTestRoot(t)})
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := diskScanCommand(nil, bytes.NewReader(append(request, '\n')), &output); err != nil {
		t.Fatal(err)
	}
	files := map[string]bool{}
	var summary diskSummary
	for _, line := range bytes.Split(bytes.TrimSpace(output.Bytes()), []byte{'\n'}) {
		var record diskEntryRecord
		if err := json.Unmarshal(line, &record); err != nil {
			t.Fatal(err)
		}
		if record.Type == "dir-entry" && record.Node.Kind == "file" {
			files[record.Node.ID] = true
		}
		if record.Type == "summary" {
			if err := json.Unmarshal(line, &summary); err != nil {
				t.Fatal(err)
			}
		}
	}
	if !files[filepath.Join(same, "ordinary")] || files[filepath.Join(foreign, "ordinary")] {
		t.Fatalf("startup request did not distinguish APFS container crossing: files=%v skipped=%v", files, summary.Skipped)
	}
	if !reflect.DeepEqual(summary.Skipped, []diskIssue{{foreign, "foreign_device"}}) {
		t.Fatalf("foreign-container refusal lost: %v", summary.Skipped)
	}
}

func TestDiskDarwinStartupRelistTreatsDataFirmlinkAsFolder(t *testing.T) {
	rootMeta, err := diskReadMetadata("/")
	if err != nil {
		t.Fatal(err)
	}
	usersMeta, err := diskReadMetadata("/Users")
	if err != nil {
		t.Fatal(err)
	}
	if rootMeta.device == usersMeta.device {
		t.Skip("requires a startup Data firmlink with a distinct REALDEVID")
	}
	// Direct relist observes the real startup boundary without recursively
	// scanning user data. The ordinary command must produce its own allowance.
	stream := runDiskOwnerRaw(t, "disk-scan", diskScanRequest{Root: "/", RelistOnly: true})
	for _, line := range bytes.Split(bytes.TrimSpace(stream), []byte{'\n'}) {
		var record diskEntryRecord
		if err := json.Unmarshal(line, &record); err != nil {
			t.Fatal(err)
		}
		if record.Type == "dir-entry" && record.Node.ID == "/Users" {
			if record.Node.Kind != "folder" {
				t.Fatalf("startup Data firmlink was treated as foreign: %#v", record.Node)
			}
			return
		}
	}
	t.Fatal("startup relist did not expose /Users")
}

func TestDiskDarwinSnapshotCountInScanSummary(t *testing.T) {
	root := diskDarwinFixtureRoot(t)
	var fs unix.Statfs_t
	if err := unix.Statfs(root, &fs); err != nil {
		t.Fatal(err)
	}
	if unix.ByteSliceToString(fs.Fstypename[:]) != "apfs" {
		t.Skip("requires APFS")
	}
	mount := unix.ByteSliceToString(fs.Mntonname[:])
	output, err := exec.Command("/usr/bin/tmutil", "listlocalsnapshots", mount).Output()
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	if len(lines) == 0 || lines[0] != "Snapshots for disk "+mount+":" {
		t.Fatalf("unexpected tmutil response: %s", output)
	}
	expected := len(lines) - 1
	scratch, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	request, err := json.Marshal(diskScanRequest{Root: root, ScratchDirectory: scratch})
	if err != nil {
		t.Fatal(err)
	}
	var records bytes.Buffer
	if err := diskScanCommand(nil, bytes.NewReader(append(request, '\n')), &records); err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(&records)
	for decoder.More() {
		var record map[string]any
		if err := decoder.Decode(&record); err != nil {
			t.Fatal(err)
		}
		if record["type"] == "summary" {
			if record["apfsLocalSnapshotCount"] != float64(expected) {
				t.Fatalf("snapshot count: got %v, want %d", record["apfsLocalSnapshotCount"], expected)
			}
			return
		}
	}
	t.Fatal("no scan summary")
}

func TestDiskDarwinLocalSnapshotCountUnknownAndObserved(t *testing.T) {
	for _, test := range []struct {
		output string
		count  *int64
	}{
		{"Snapshots for disk /:\n", diskInt64Pointer(0)},
		{"Snapshots for disk /:\ncom.apple.TimeMachine.2026-10-13-100001.local\ncom.apple.TimeMachine.2026-10-13-110001.local\n", diskInt64Pointer(2)},
		{"Snapshots for disk /:\ncom.apple.TimeMachine.2026-10-13-100001.local\ncom.apple.TimeMachine.2026-10-13-100001.local\n", diskInt64Pointer(1)},
		{"Snapshots for disk /other:\n", nil},
		{"", nil},
		{"Snapshots for disk /:\nPermission denied\n", nil},
	} {
		actual := diskDarwinLocalSnapshotCount(test.output, "/")
		if (actual == nil) != (test.count == nil) || actual != nil && *actual != *test.count {
			t.Fatalf("output %q: got %v, want %v", test.output, actual, test.count)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if diskReadLocalSnapshotCount(ctx, diskDarwinFixtureRoot(t)) != nil {
		t.Fatal("cancelled probe invented a count")
	}
}

func TestDiskDarwinBlockedPackageResumesAtomically(t *testing.T) {
	root := diskDarwinFixtureRoot(t)
	app, blocked, remaining := filepath.Join(root, "Product.app"), filepath.Join(root, "Product.app", "Blocked"), filepath.Join(root, "Product.app", "Remaining")
	for _, path := range []string{app, blocked, remaining, filepath.Join(remaining, "nested")} {
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	child := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestDiskCommandProcess$")
	child.Env = append(os.Environ(), "HAPPIER_TEST_DISK_COMMAND=disk-scan", "HAPPIER_TEST_DISK_BLOCK="+blocked)
	input, err := child.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	child.Stderr = os.Stderr
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	encoder := json.NewEncoder(input)
	if err := encoder.Encode(diskScanRequest{Root: root, ScratchDirectory: storageRenameTestRoot(t)}); err != nil {
		t.Fatal(err)
	}
	var summary diskSummary
	frontier := []string{}
	scanner := bufio.NewScanner(output)
	for scanner.Scan() {
		var item diskProgress
		if err := json.Unmarshal(scanner.Bytes(), &item); err != nil {
			t.Fatal(err)
		}
		if item.Type == "progress" && item.CurrentPath == blocked {
			if err := encoder.Encode(map[string]string{"type": "skip", "path": blocked}); err != nil {
				t.Fatal(err)
			}
		}
		if item.Type == "summary" {
			if err := json.Unmarshal(scanner.Bytes(), &summary); err != nil {
				t.Fatal(err)
			}
		}
		if item.Type == "frontier-item" {
			var record struct{ Path string }
			if err := json.Unmarshal(scanner.Bytes(), &record); err != nil {
				t.Fatal(err)
			}
			frontier = append(frontier, record.Path)
		}
	}
	input.Close()
	if err := child.Wait(); err != nil {
		t.Fatal(err)
	}
	if summary.StreamedFrontier {
		summary.PendingFrontier = frontier
	}
	if len(summary.PendingFrontier) != 1 || summary.PendingFrontier[0] != app {
		t.Fatalf("package frontier lost its atomic boundary: %#v", summary)
	}
	request, err := json.Marshal(diskScanRequest{Root: root, ResumeFrom: summary.PendingFrontier, SkippedPaths: []string{blocked}, ScratchDirectory: storageRenameTestRoot(t)})
	if err != nil {
		t.Fatal(err)
	}
	recovery := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestDiskCommandProcess$")
	recovery.Env = child.Env
	recovery.Stdin = bytes.NewReader(append(request, '\n'))
	recovery.Stderr = os.Stderr
	resumed, err := recovery.Output()
	if err != nil {
		t.Fatalf("package recovery reopened skipped blocked worker: %v", err)
	}
	for _, line := range bytes.Split(bytes.TrimSpace(resumed), []byte{'\n'}) {
		var dir diskDirRecord
		if err := json.Unmarshal(line, &dir); err != nil {
			t.Fatal(err)
		}
		if (dir.Type == "dir" || dir.Type == "dir-start") && dir.ID != root && dir.ID != app {
			t.Fatalf("package interruption materialized inner directory: %s; frontier=%v", line, summary.PendingFrontier)
		}
		if dir.Type == "dir-entry" {
			var entry diskEntryRecord
			if err := json.Unmarshal(line, &entry); err != nil {
				t.Fatal(err)
			}
			if entry.Parent != root && entry.Visible {
				t.Fatalf("package interruption materialized inner entry: %s", line)
			}
		}
	}
}

func diskDarwinFixtureRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func TestDiskDarwinPackageClassificationPreservesNonDirectories(t *testing.T) {
	root := diskDarwinFixtureRoot(t)
	for _, name := range []string{"Product.app", "Library.photoslibrary", "Build.xcarchive", "Load.bundle", "Link.framework", "Add.plugin", "Driver.kext", "UPPER.APP", "ordinary"} {
		path := filepath.Join(root, name)
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
		meta, err := diskReadMetadata(path)
		if err != nil {
			t.Fatal(err)
		}
		want := "package"
		if name == "ordinary" {
			want = "folder"
		}
		if meta.kind != want {
			t.Fatalf("%s kind=%s, want %s", name, meta.kind, want)
		}
		dir, err := diskOpenRoot(path)
		if err != nil {
			t.Fatalf("cannot open %s as a directory: %v", name, err)
		}
		if dir.metadata().kind != want {
			t.Fatalf("opened %s kind=%s, want %s", name, dir.metadata().kind, want)
		}
		dir.close()
	}
	if err := os.WriteFile(filepath.Join(root, "file.app"), []byte("not a directory"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "Product.app"), filepath.Join(root, "alias.app")); err != nil {
		t.Fatal(err)
	}
	dir, err := diskOpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	defer dir.close()
	for _, enumerate := range []func(context.Context) ([]diskEntry, error){dir.(*darwinDiskDirectory).entriesBulk, dir.(*darwinDiskDirectory).entriesFallback} {
		entries, err := enumerate(context.Background())
		if errors.Is(err, unix.ENOTSUP) || errors.Is(err, unix.ENOSYS) || errors.Is(err, unix.EINVAL) {
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 11 {
			t.Fatalf("classification fixture entries missing: %#v", entries)
		}
		for _, entry := range entries {
			if entry.err != nil {
				t.Fatal(entry.err)
			}
			want := "package"
			switch entry.name {
			case "ordinary":
				want = "folder"
			case "file.app":
				want = "file"
			case "alias.app":
				want = "symlink"
			}
			if entry.meta.kind != want {
				t.Fatalf("enumerated %s kind=%s, want %s", entry.name, entry.meta.kind, want)
			}
			if entry.name == "Product.app" {
				child, err := dir.openChild(entry)
				if err != nil {
					t.Fatalf("package child not traversable: %v", err)
				}
				child.close()
			}
		}
	}
}

func TestDiskDarwinScanOwnerPackagesAreAtomicAggregates(t *testing.T) {
	root := diskDarwinFixtureRoot(t)
	app := filepath.Join(root, "Product.app")
	resources := filepath.Join(app, "Contents", "Resources", "Inner.bundle")
	if err := os.MkdirAll(resources, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(resources, "private-package-data"), bytes.Repeat([]byte("p"), 8192), 0600); err != nil {
		t.Fatal(err)
	}
	raw := runDiskOwnerRaw(t, "disk-scan", map[string]any{"root": root, "keepMinBytes": 0})
	output := diskCollectScanFixture(t, raw)
	var parent, bundle *diskDirRecord
	completedIDs := map[string]bool{}
	packageFound := false
	summaryFound := false
	for _, line := range bytes.Split(bytes.TrimSpace(output), []byte{'\n'}) {
		var header struct{ Type string }
		if err := json.Unmarshal(line, &header); err != nil {
			t.Fatal(err)
		}
		if header.Type == "summary" {
			var summary diskSummary
			if err := json.Unmarshal(line, &summary); err != nil {
				t.Fatal(err)
			}
			if summary.Termination != "completed" || len(summary.Unreadable) != 0 {
				t.Fatalf("package scan incomplete: %s", line)
			}
			summaryFound = true
		}
		if header.Type != "dir" {
			continue
		}
		var record diskDirRecord
		if err := json.Unmarshal(line, &record); err != nil {
			t.Fatal(err)
		}
		if record.Complete {
			completedIDs[record.ID] = true
		}
		switch record.ID {
		case diskPathID(root):
			parent = &record
		case diskPathID(app):
			bundle = &record
			packageFound = true
		default:
			t.Fatalf("package internal directory materialized: %s", line)
		}
	}
	if !summaryFound || len(completedIDs) != 2 || !packageFound || parent == nil || bundle == nil || !bundle.Complete {
		t.Fatalf("missing atomic package records: %s", output)
	}
	if bundle.AllocatedBytes < 8192 || bundle.LogicalBytes < 8192 || bundle.Items != 5 || len(bundle.Children) != 0 || len(bundle.Files) != 0 {
		t.Fatalf("package aggregate lost or exposed internals: %#v", bundle)
	}
	if len(parent.Children) != 1 || parent.Children[0].Kind != "package" || parent.Children[0].ID != bundle.ID || parent.Children[0].AllocatedBytes != bundle.AllocatedBytes || parent.Children[0].LogicalBytes != bundle.LogicalBytes || parent.Children[0].Items != bundle.Items {
		t.Fatalf("parent package aggregate differs: %#v %#v", parent, bundle)
	}
	physical := map[string]int64{}
	ordinaryFound := false
	for _, line := range bytes.Split(bytes.TrimSpace(raw), []byte{'\n'}) {
		var tag struct{ Type string }
		if err := json.Unmarshal(line, &tag); err != nil {
			t.Fatal(err)
		}
		if tag.Type == "dir-entry" {
			var entry diskEntryRecord
			json.Unmarshal(line, &entry)
			if entry.Parent != root && entry.Visible {
				t.Fatalf("package descendant chart node exposed: %s", line)
			}
			if entry.Node.ID == filepath.Join(resources, "private-package-data") {
				ordinaryFound = true
			}
		}
		if tag.Type == "fact" {
			var record diskFactRecord
			json.Unmarshal(line, &record)
			if diskPathContains(app, record.Fact.PathID) {
				physical[record.Fact.Key] = record.Fact.AllocatedBytes
			}
		}
	}
	var observed int64
	for _, value := range physical {
		observed += value
	}
	if !ordinaryFound || len(physical) != 5 || observed != bundle.AllocatedBytes {
		t.Fatalf("atomic package lost ordinary query or physical ownership: ordinary=%v facts=%#v", ordinaryFound, physical)
	}
}

func TestDiskDarwinBulkFallbackParityAndAllForkAllocation(t *testing.T) {
	root := diskDarwinFixtureRoot(t)
	file := filepath.Join(root, "forks")
	if err := os.WriteFile(file, bytes.Repeat([]byte("d"), 8192), 0600); err != nil {
		t.Fatal(err)
	}
	if err := unix.Setxattr(file, "com.apple.ResourceFork", bytes.Repeat([]byte("r"), 32768), 0); err != nil {
		t.Skipf("resource forks unavailable: %v", err)
	}
	if err := os.Link(file, filepath.Join(root, "linked")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(root, filepath.Join(root, "loop")); err != nil {
		t.Fatal(err)
	}
	dir, err := diskOpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	defer dir.close()
	d := dir.(*darwinDiskDirectory)
	bulk, err := d.entriesBulk(context.Background())
	if errors.Is(err, unix.ENOTSUP) || errors.Is(err, unix.ENOSYS) || errors.Is(err, unix.EINVAL) {
		t.Skipf("bulk unavailable on fixture filesystem: %v", err)
	}
	if err != nil {
		t.Fatal(err)
	}
	fallback, err := d.entriesFallback(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	byName := func(entries []diskEntry) map[string]diskMetadata {
		result := make(map[string]diskMetadata)
		for _, entry := range entries {
			if entry.err != nil {
				t.Fatal(entry.err)
			}
			result[entry.name] = entry.meta
		}
		return result
	}
	a, b := byName(bulk), byName(fallback)
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("bulk/fallback differ:\nbulk: %#v\nfallback: %#v", a, b)
	}
	if a["forks"].allocatedBytes < 40960 || a["forks"].logicalBytes < 40960 {
		t.Fatalf("all-fork bytes missing: %#v", a["forks"])
	}
	if !a["forks"].dataAllocationKnown || a["forks"].dataAllocatedBytes <= 0 || a["forks"].dataAllocatedBytes >= a["forks"].allocatedBytes || a["forks"].dataAllocatedBytes != a["linked"].dataAllocatedBytes {
		t.Fatalf("data-fork allocation missing or conflated with all-fork bytes: %#v", a)
	}
	if a["forks"].identity != a["linked"].identity || a["forks"].nlink != 2 {
		t.Fatalf("hard-link identity/count missing: %#v", a)
	}
	if a["loop"].kind != "symlink" {
		t.Fatalf("symlink followed: %#v", a["loop"])
	}
}

func TestDiskDarwinDirectoryDescriptorsSurviveAncestorRenameAndRejectSwap(t *testing.T) {
	root := diskDarwinFixtureRoot(t)
	childPath := filepath.Join(root, "child")
	if err := os.Mkdir(childPath, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "data"), []byte("a"), 0600); err != nil {
		t.Fatal(err)
	}
	dir, err := diskOpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	defer dir.close()
	entries, _, err := dir.entries(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var child diskEntry
	for _, entry := range entries {
		if entry.name == "child" {
			child = entry
		}
	}
	if err := os.Rename(childPath, filepath.Join(root, "old")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "old"), childPath); err != nil {
		t.Fatal(err)
	}
	if opened, err := dir.openChild(child); err == nil {
		opened.close()
		t.Fatal("followed swapped symlink")
	}
	if err := os.Rename(root, root+"-renamed"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Rename(root+"-renamed", root) })
	entries, _, err = dir.entries(context.Background())
	if err != nil || len(entries) != 3 {
		t.Fatalf("descriptor-relative enumeration failed after rename: %v %#v", err, entries)
	}
}

func TestDiskDarwinCloudMetadataNeverCountsAllocation(t *testing.T) {
	stat := unix.Stat_t{Dev: 5, Ino: 17, Mode: unix.S_IFDIR | 0700, Blocks: 8192, Size: 1024, Flags: unix.SF_DATALESS}
	meta := darwinDiskMetadataFromStat(stat, false)
	meta = darwinDiskClassifyPackage("Cloud.app", meta)
	if !meta.cloudOnly || meta.allocatedBytes != 0 {
		t.Fatalf("dataless placeholder counted as local data: %#v", meta)
	}
	if meta.kind != "folder" {
		t.Fatalf("dataless placeholder reclassified as a package: %#v", meta)
	}
	d := &darwinDiskDirectory{fd: -1}
	if opened, err := d.openChild(diskEntry{name: "cloud", meta: meta}); err == nil {
		opened.close()
		t.Fatal("dataless directory was opened")
	}
}

func TestDiskDarwinRootRejectsSymlinkAncestorsAndCancellation(t *testing.T) {
	root := diskDarwinFixtureRoot(t)
	real := filepath.Join(root, "real")
	if err := os.MkdirAll(filepath.Join(real, "child"), 0700); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(root, "alias")
	if err := os.Symlink(real, alias); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{alias, filepath.Join(alias, "child")} {
		if dir, err := diskOpenRoot(path); err == nil {
			dir.close()
			t.Fatalf("symlink path opened: %s", path)
		}
	}
	dir, err := diskOpenRoot(real)
	if err != nil {
		t.Fatal(err)
	}
	defer dir.close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := dir.entries(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled directory enumerated: %v", err)
	}
}

func TestDiskDarwinPackedPermissionFailureRetainsName(t *testing.T) {
	// An error entry contains only RETURNED_ATTRS, ERROR and NAME.
	buffer := make([]byte, 40)
	binary.LittleEndian.PutUint32(buffer[0:4], 40)
	binary.LittleEndian.PutUint32(buffer[4:8], 0xa0000001)
	binary.LittleEndian.PutUint32(buffer[24:28], uint32(unix.EPERM))
	binary.LittleEndian.PutUint32(buffer[28:32], 8)
	binary.LittleEndian.PutUint32(buffer[32:36], 4)
	copy(buffer[36:], []byte("bad\x00"))
	attrs, err := parseDarwinDiskAttrs(buffer)
	if err != nil {
		t.Fatal(err)
	}
	if attrs.name != "bad" || !errors.Is(attrs.err, unix.EPERM) || attrs.identityKnown || attrs.allocationKnown {
		t.Fatalf("permission failure became an ordinary item: %#v", attrs)
	}
}

func TestDiskDarwinPackedAttrsPreserveRealDeviceCloneAndCloudFlag(t *testing.T) {
	// Kernel ABI: length, returned bitmaps, common attrs, file attrs, extended attrs,
	// then the variable name. Every scalar is packed with four-byte alignment.
	buffer := make([]byte, 132)
	binary.LittleEndian.PutUint32(buffer[0:4], uint32(len(buffer)))
	binary.LittleEndian.PutUint32(buffer[4:8], 0xa204040b)
	binary.LittleEndian.PutUint32(buffer[16:20], 7)
	binary.LittleEndian.PutUint32(buffer[20:24], 0x1348)
	binary.LittleEndian.PutUint32(buffer[24:28], 0)  // entry errno precedes name
	binary.LittleEndian.PutUint32(buffer[28:32], 96) // name offset from attrreference
	binary.LittleEndian.PutUint32(buffer[32:36], 6)
	binary.LittleEndian.PutUint32(buffer[36:40], 10)
	binary.LittleEndian.PutUint32(buffer[40:44], 1) // VREG
	binary.LittleEndian.PutUint64(buffer[44:52], 100)
	binary.LittleEndian.PutUint32(buffer[60:64], unix.SF_DATALESS)
	binary.LittleEndian.PutUint64(buffer[64:72], 17)
	binary.LittleEndian.PutUint32(buffer[72:76], 2)
	binary.LittleEndian.PutUint64(buffer[76:84], 1000)
	binary.LittleEndian.PutUint64(buffer[84:92], 4096)
	binary.LittleEndian.PutUint64(buffer[92:100], 512)
	binary.LittleEndian.PutUint32(buffer[100:104], 99)
	binary.LittleEndian.PutUint64(buffer[104:112], 123)
	binary.LittleEndian.PutUint64(buffer[112:120], 1)
	binary.LittleEndian.PutUint32(buffer[120:124], 3)
	copy(buffer[124:], []byte("cloud\x00"))
	cloud, err := parseDarwinDiskAttrs(buffer)
	if err != nil {
		t.Fatal(err)
	}
	if cloud.name != "cloud" || !cloud.meta.cloudOnly || cloud.meta.allocatedBytes != 0 || cloud.meta.identity != "99:17" || cloud.meta.logicalBytes != 1000 {
		t.Fatalf("packed cloud attrs lost: %#v", cloud)
	}
	if cloud.meta.dataAllocationKnown {
		t.Fatalf("missing data-fork attribute became known: %#v", cloud.meta)
	}
	binary.LittleEndian.PutUint32(buffer[0:4], 120)
	if _, err := parseDarwinDiskAttrs(buffer); err == nil {
		t.Fatal("truncated extended attributes accepted")
	}
	// A smaller vector below exercises extended-only packing without a name.
	buffer = make([]byte, 56)
	binary.LittleEndian.PutUint32(buffer[0:4], uint32(len(buffer)))
	binary.LittleEndian.PutUint32(buffer[4:8], 0x80000000)
	binary.LittleEndian.PutUint32(buffer[20:24], 0x1348)
	binary.LittleEndian.PutUint64(buffer[24:32], 512)  // private allocation
	binary.LittleEndian.PutUint32(buffer[32:36], 99)   // real device
	binary.LittleEndian.PutUint64(buffer[36:44], 123)  // clone id
	binary.LittleEndian.PutUint64(buffer[44:52], 0x41) // may share and shares all blocks
	binary.LittleEndian.PutUint32(buffer[52:56], 3)    // clone refcount
	attrs, err := parseDarwinDiskAttrs(buffer)
	if err != nil {
		t.Fatal(err)
	}
	if attrs.meta.device != "99" || attrs.meta.cloneID != "123" || attrs.meta.cloneRefCount != 3 || !attrs.meta.mayShareBlocks || !attrs.meta.sharesAllBlocks {
		t.Fatalf("clone/real-device attrs lost: %#v", attrs.meta)
	}
	binary.LittleEndian.PutUint64(buffer[44:52], 3) // MAY_SHARE_BLOCKS | NO_XATTRS, not a full clone
	attrs, err = parseDarwinDiskAttrs(buffer)
	if err != nil {
		t.Fatal(err)
	}
	if !attrs.meta.mayShareBlocks || attrs.meta.sharesAllBlocks {
		t.Fatalf("no-xattrs flag confused with full-clone evidence: %#v", attrs.meta)
	}
}

func TestDiskDarwinPackedAttrsSeparateDataAndAllForkAllocation(t *testing.T) {
	// Full returned common/file/extended bitmap; DATAALLOCSIZE follows all-fork
	// ALLOCSIZE and precedes common-extended attributes in the packed ABI.
	buffer := make([]byte, 140)
	binary.LittleEndian.PutUint32(buffer[0:4], uint32(len(buffer)))
	binary.LittleEndian.PutUint32(buffer[4:8], 0xa204040b)
	binary.LittleEndian.PutUint32(buffer[16:20], 0x407)
	binary.LittleEndian.PutUint32(buffer[20:24], 0x1348)
	binary.LittleEndian.PutUint32(buffer[28:32], 104) // name at byte132, reference at byte28
	binary.LittleEndian.PutUint32(buffer[32:36], 6)
	binary.LittleEndian.PutUint32(buffer[36:40], 10)
	binary.LittleEndian.PutUint32(buffer[40:44], 1) // VREG
	binary.LittleEndian.PutUint64(buffer[44:52], 100)
	binary.LittleEndian.PutUint64(buffer[64:72], 17)
	binary.LittleEndian.PutUint32(buffer[72:76], 1)
	binary.LittleEndian.PutUint64(buffer[76:84], 40960) // all-fork logical size
	binary.LittleEndian.PutUint64(buffer[84:92], 40960) // all-fork allocation
	binary.LittleEndian.PutUint64(buffer[92:100], 8192) // data-fork allocation only
	binary.LittleEndian.PutUint64(buffer[100:108], 0)   // native private-size evidence
	binary.LittleEndian.PutUint32(buffer[108:112], 99)
	binary.LittleEndian.PutUint64(buffer[112:120], 123)
	binary.LittleEndian.PutUint64(buffer[120:128], 0x41)
	binary.LittleEndian.PutUint32(buffer[128:132], 2)
	copy(buffer[132:], []byte("forks\x00"))
	attrs, err := parseDarwinDiskAttrs(buffer)
	if err != nil {
		t.Fatal(err)
	}
	if attrs.name != "forks" || attrs.meta.identity != "99:17" || !attrs.allocationKnown || attrs.meta.allocatedBytes != 40960 || !attrs.meta.dataAllocationKnown || attrs.meta.dataAllocatedBytes != 8192 || !attrs.meta.sharesAllBlocks || !attrs.meta.privateBytesKnown || attrs.meta.privateBytes != 0 {
		t.Fatalf("data-stream clone metadata lost non-data fork allocation: %#v", attrs)
	}
	enriched := darwinDiskMergeAttrs(diskMetadata{kind: "file"}, attrs)
	if !enriched.dataAllocationKnown || enriched.dataAllocatedBytes != 8192 || enriched.allocatedBytes != 40960 {
		t.Fatalf("data-fork evidence lost during metadata enrichment: %#v", enriched)
	}
}

func TestDiskDarwinAPFSCloneMetadata(t *testing.T) {
	root := diskDarwinFixtureRoot(t)
	source, clone := filepath.Join(root, "source"), filepath.Join(root, "clone")
	if err := os.WriteFile(source, bytes.Repeat([]byte("c"), 1024*1024), 0600); err != nil {
		t.Fatal(err)
	}
	if err := unix.Clonefile(source, clone, 0); err != nil {
		t.Skipf("clone filesystem unavailable: %v", err)
	}
	a, err := diskReadMetadata(source)
	if err != nil {
		t.Fatal(err)
	}
	b, err := diskReadMetadata(clone)
	if err != nil {
		t.Fatal(err)
	}
	if a.cloneID == "" || b.cloneID == "" {
		t.Skip("this macOS/APFS version does not expose clone mapping")
	}
	if a.device != b.device || a.cloneID != b.cloneID || a.cloneRefCount == 0 || !a.mayShareBlocks {
		t.Fatalf("clone identity missing: %#v %#v", a, b)
	}
}

func TestDiskDarwinStartupRootSkipSet(t *testing.T) {
	for _, path := range []string{"/.nofollow", "/.resolve", "/.file", "/.vol", "/dev", "/Volumes", "/System/Volumes"} {
		if skip, _ := diskShouldSkip(path, "/", diskMetadata{}); !skip {
			t.Errorf("startup path was not skipped: %s", path)
		}
	}
	if skip, _ := diskShouldSkip("/Users", "/", diskMetadata{}); skip {
		t.Fatal("user files excluded")
	}
	if skip, _ := diskShouldSkip("/Volumes/data", "/Volumes/data", diskMetadata{}); skip {
		t.Fatal("explicit volume root excluded")
	}
}

func TestDiskScanOwnerUnreadableSubtreeAtLeast(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses permission boundary")
	}
	root := diskDarwinFixtureRoot(t)
	child := filepath.Join(root, "denied")
	if err := os.Mkdir(child, 0700); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := os.Chmod(child, 0700); err != nil {
			t.Errorf("restore fixture permissions: %v", err)
		}
	}()
	if err := os.Chmod(child, 0000); err != nil {
		t.Fatal(err)
	}
	var final diskDirRecord
	var summary diskSummary
	output := runDiskOwner(t, "disk-scan", map[string]any{"root": root, "keepMinBytes": 0})
	for _, line := range bytes.Split(bytes.TrimSpace(output), []byte{'\n'}) {
		var header struct{ Type string }
		if err := json.Unmarshal(line, &header); err != nil {
			t.Fatal(err)
		}
		switch header.Type {
		case "dir":
			var record diskDirRecord
			if err := json.Unmarshal(line, &record); err != nil {
				t.Fatal(err)
			}
			if record.ID == diskPathID(root) {
				final = record
			}
		case "summary":
			if err := json.Unmarshal(line, &summary); err != nil {
				t.Fatal(err)
			}
		}
	}
	if summary.UnreadableCounts["permission"] != 1 || len(summary.Unreadable) != 1 || summary.Unreadable[0].Path != child {
		t.Fatalf("permission failure missing or miscounted: %s", output)
	}
	if !final.Enumerated || final.Complete || !final.Flags.AtLeast || len(final.Children) != 1 || final.Children[0].ID != diskPathID(child) || !final.Children[0].Flags.AtLeast {
		t.Fatalf("unreadable subtree presented as fully measured: %#v", final)
	}
}
