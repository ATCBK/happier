//go:build darwin

package main

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"unsafe"

	"golang.org/x/sys/unix"
)

func diskScanAllowedDevices(root string) ([]string, error) {
	var fs unix.Statfs_t
	if unix.Statfs(root, &fs) != nil {
		// The walk owns unreadable-root reporting.
		return nil, nil
	}
	container := darwinVitalsAPFSContainer(fs)
	if container == "" {
		return nil, nil
	}
	mounts, err := readDarwinVitalsMounts()
	if err != nil {
		return nil, err
	}
	devices := []string{}
	for _, mount := range mounts {
		if mount.Flags&unix.MNT_LOCAL == 0 || darwinVitalsAPFSContainer(mount) != container {
			continue
		}
		// Use the same REALDEVID-aware attributes as directory enumeration, not
		// an fsid or a guessed relationship between BSD device names and dev_t.
		meta, err := diskReadMetadata(nativeCString(mount.Mntonname[:]))
		if err == nil && !diskAllowedDevice(devices, meta.device) {
			devices = append(devices, meta.device)
		}
	}
	return devices, nil
}

// tmutil's read-only public list reports local Time Machine snapshots, not bytes.
// A failed/unknown observation remains absent instead of claiming measured zero.
func diskReadLocalSnapshotCount(ctx context.Context, root string) *int64 {
	var fs unix.Statfs_t
	if unix.Statfs(root, &fs) != nil || unix.ByteSliceToString(fs.Fstypename[:]) != "apfs" {
		return nil
	}
	mount := unix.ByteSliceToString(fs.Mntonname[:])
	output, err := exec.CommandContext(ctx, "/usr/bin/tmutil", "listlocalsnapshots", mount).Output()
	if err != nil {
		return nil
	}
	return diskDarwinLocalSnapshotCount(string(output), mount)
}

func diskDarwinLocalSnapshotCount(output, mount string) *int64 {
	lines := strings.Split(strings.TrimSpace(output), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "Snapshots for disk "+mount+":" {
		return nil
	}
	names := make(map[string]bool)
	for _, line := range lines[1:] {
		name := strings.TrimSpace(line)
		if name == "" {
			continue
		}
		if !strings.HasPrefix(name, "com.apple.TimeMachine.") || strings.ContainsAny(name, " \t\r") {
			return nil
		}
		names[name] = true
	}
	count := int64(len(names))
	return &count
}

// Darwin's packed getattrlist ABI is defined by bsd/sys/attr.h and
// bsd/vfs/vfs_attrlist.c. x/sys exports the syscall numbers and Syscall6, which
// reaches the kernel without cgo on both supported Darwin architectures.
const (
	darwinAttrName           = uint32(0x00000001)
	darwinAttrDevice         = uint32(0x00000002)
	darwinAttrType           = uint32(0x00000008)
	darwinAttrMtime          = uint32(0x00000400)
	darwinAttrFlags          = uint32(0x00040000)
	darwinAttrFileID         = uint32(0x02000000)
	darwinAttrError          = uint32(0x20000000)
	darwinAttrReturned       = uint32(0x80000000)
	darwinAttrPrivateSize    = uint32(0x00000008)
	darwinAttrRealDevice     = uint32(0x00000040)
	darwinAttrCloneID        = uint32(0x00000100)
	darwinAttrExtFlags       = uint32(0x00000200)
	darwinAttrCloneRefCount  = uint32(0x00001000)
	darwinAttrDataAllocation = uint32(0x00000400) // ATTR_FILE_DATAALLOCSIZE
	darwinFSOptNoFollow      = uintptr(0x1)
	darwinFSOptExtended      = uintptr(0x20)
	darwinEFMayShareBlocks   = uint64(0x1)
	darwinEFSharesAllBlocks  = uint64(0x40) // bsd/sys/stat.h: EF_SHARES_ALL_BLOCKS
	// A transport batch, not a directory/entry limit. An arbitrarily large
	// directory is consumed over as many batches as the kernel returns.
	darwinDiskBatchBytes = 64 * 1024
)

type darwinDiskAttrList struct {
	bitmapCount                               uint16
	reserved                                  uint16
	common, volume, directory, file, extended uint32
}

func darwinDiskRequestedAttrs() darwinDiskAttrList {
	return darwinDiskAttrList{
		bitmapCount: 5,
		common:      darwinAttrReturned | darwinAttrName | darwinAttrDevice | darwinAttrType | darwinAttrMtime | darwinAttrFlags | darwinAttrFileID | darwinAttrError,
		directory:   1 | 4 | 8 | 0x20,                     // nlink, mount status, allocation, logical bytes
		file:        1 | 2 | 4 | darwinAttrDataAllocation, // nlink, all-fork logical/allocation, data-fork allocation
		extended:    darwinAttrPrivateSize | darwinAttrRealDevice | darwinAttrCloneID | darwinAttrExtFlags | darwinAttrCloneRefCount,
	}
}

type darwinDiskAttrs struct {
	name             string
	meta             diskMetadata
	err              error
	allocationKnown  bool
	identityKnown    bool
	inode            uint64
	commonFlagsKnown bool
}

// The returned bitmaps describe the fields actually packed, so unsupported
// attributes cannot shift subsequent offsets or silently become zero facts.
func parseDarwinDiskAttrs(record []byte) (darwinDiskAttrs, error) {
	var result darwinDiskAttrs
	if len(record) < 24 {
		return result, fmt.Errorf("truncated Darwin attribute header")
	}
	length := int(binary.LittleEndian.Uint32(record[:4]))
	if length < 24 || length > len(record) {
		return result, fmt.Errorf("invalid Darwin attribute record length")
	}
	record = record[:length]
	common := binary.LittleEndian.Uint32(record[4:8])
	volume := binary.LittleEndian.Uint32(record[8:12])
	directory := binary.LittleEndian.Uint32(record[12:16])
	file := binary.LittleEndian.Uint32(record[16:20])
	extended := binary.LittleEndian.Uint32(record[20:24])
	requested := darwinDiskRequestedAttrs()
	if common&darwinAttrReturned == 0 || common & ^requested.common != 0 || volume != 0 || directory & ^requested.directory != 0 || file & ^requested.file != 0 || extended & ^requested.extended != 0 {
		return result, fmt.Errorf("unexpected Darwin returned attribute bitmap")
	}
	offset := 24
	take := func(size int) ([]byte, error) {
		if size > len(record)-offset {
			return nil, fmt.Errorf("truncated Darwin attribute value")
		}
		value := record[offset : offset+size]
		offset += size
		return value, nil
	}
	var inode uint64
	var device uint32
	var nameStart, nameEnd int
	for _, field := range []struct {
		bit  uint32
		size int
	}{
		{darwinAttrError, 4}, {darwinAttrName, 8}, {darwinAttrDevice, 4}, {darwinAttrType, 4}, {darwinAttrMtime, 16}, {darwinAttrFlags, 4}, {darwinAttrFileID, 8},
	} {
		if common&field.bit == 0 {
			continue
		}
		fieldOffset := offset
		value, err := take(field.size)
		if err != nil {
			return result, err
		}
		switch field.bit {
		case darwinAttrName:
			nameStart = fieldOffset + int(int32(binary.LittleEndian.Uint32(value[:4])))
			nameLength := int(binary.LittleEndian.Uint32(value[4:8]))
			if nameStart < 0 || nameStart > len(record) || nameLength <= 0 || nameLength > len(record)-nameStart {
				return result, fmt.Errorf("invalid Darwin name attribute reference")
			}
			nameEnd = nameStart + nameLength
		case darwinAttrDevice:
			device = binary.LittleEndian.Uint32(value)
		case darwinAttrType:
			switch binary.LittleEndian.Uint32(value) {
			case 1:
				result.meta.kind = "file"
			case 2:
				result.meta.kind = "folder"
			case 5:
				result.meta.kind = "symlink"
			default:
				result.meta.kind = "other"
			}
		case darwinAttrMtime:
			result.meta.mtimeMs = int64(binary.LittleEndian.Uint64(value[:8]))*1000 + int64(binary.LittleEndian.Uint64(value[8:]))/1000000
		case darwinAttrFlags:
			result.commonFlagsKnown = true
			result.meta.cloudOnly = binary.LittleEndian.Uint32(value)&unix.SF_DATALESS != 0
		case darwinAttrFileID:
			inode = binary.LittleEndian.Uint64(value)
		case darwinAttrError:
			if code := binary.LittleEndian.Uint32(value); code != 0 {
				result.err = unix.Errno(code)
			}
		}
	}
	for _, group := range []struct {
		bits      uint32
		directory bool
	}{{directory, true}, {file, false}} {
		for _, bit := range []uint32{1, 2, 4, 8, 0x20, darwinAttrDataAllocation} {
			if group.bits&bit == 0 {
				continue
			}
			size := 4
			if (group.directory && (bit == 8 || bit == 0x20)) || (!group.directory && (bit == 2 || bit == 4 || bit == darwinAttrDataAllocation)) {
				size = 8
			}
			value, err := take(size)
			if err != nil {
				return result, err
			}
			switch {
			case bit == 1:
				result.meta.nlink = uint64(binary.LittleEndian.Uint32(value))
			case (group.directory && bit == 8) || (!group.directory && bit == 4):
				result.meta.allocatedBytes = int64(binary.LittleEndian.Uint64(value))
				result.allocationKnown = true
			case (group.directory && bit == 0x20) || (!group.directory && bit == 2):
				result.meta.logicalBytes = int64(binary.LittleEndian.Uint64(value))
			case !group.directory && bit == darwinAttrDataAllocation:
				result.meta.dataAllocatedBytes = int64(binary.LittleEndian.Uint64(value))
				result.meta.dataAllocationKnown = true
			}
		}
	}
	for _, field := range []struct {
		bit  uint32
		size int
	}{
		{darwinAttrPrivateSize, 8}, {darwinAttrRealDevice, 4}, {darwinAttrCloneID, 8}, {darwinAttrExtFlags, 8}, {darwinAttrCloneRefCount, 4},
	} {
		if extended&field.bit == 0 {
			continue
		}
		value, err := take(field.size)
		if err != nil {
			return result, err
		}
		switch field.bit {
		case darwinAttrPrivateSize:
			result.meta.privateBytes = int64(binary.LittleEndian.Uint64(value))
			result.meta.privateBytesKnown = true
		case darwinAttrRealDevice:
			device = binary.LittleEndian.Uint32(value)
		case darwinAttrCloneID:
			if id := binary.LittleEndian.Uint64(value); id != 0 {
				result.meta.cloneID = strconv.FormatUint(id, 10)
			}
		case darwinAttrExtFlags:
			result.meta.extFlagsKnown = true
			flags := binary.LittleEndian.Uint64(value)
			result.meta.sharesAllBlocks = flags&darwinEFSharesAllBlocks != 0
			result.meta.mayShareBlocks = flags&darwinEFMayShareBlocks != 0 || result.meta.sharesAllBlocks
		case darwinAttrCloneRefCount:
			result.meta.cloneRefCount = uint64(binary.LittleEndian.Uint32(value))
		}
	}
	if common&darwinAttrName != 0 {
		if nameStart < offset || record[nameEnd-1] != 0 {
			return result, fmt.Errorf("invalid Darwin packed name")
		}
		result.name = string(record[nameStart : nameEnd-1])
		if strings.IndexByte(result.name, 0) >= 0 || strings.Contains(result.name, "/") {
			return result, fmt.Errorf("invalid Darwin entry name")
		}
	}
	result.meta.device = strconv.FormatUint(uint64(device), 10)
	result.inode = inode
	result.identityKnown = common&darwinAttrFileID != 0 && (common&darwinAttrDevice != 0 || extended&darwinAttrRealDevice != 0)
	if result.identityKnown {
		result.meta.identity = result.meta.device + ":" + strconv.FormatUint(inode, 10)
	}
	if result.meta.allocatedBytes < 0 || result.meta.logicalBytes < 0 || result.meta.privateBytes < 0 || result.meta.dataAllocatedBytes < 0 {
		return result, fmt.Errorf("negative Darwin allocation")
	}
	if result.meta.cloudOnly {
		result.meta.allocatedBytes = 0
		result.meta.dataAllocatedBytes = 0
	}
	return result, nil
}

var darwinDiskBuffers = sync.Pool{New: func() any { return make([]byte, darwinDiskBatchBytes) }}

type darwinDiskDirectory struct {
	fd   int
	path string
	meta diskMetadata
	apfs bool
}

func (d *darwinDiskDirectory) metadata() diskMetadata { return d.meta }
func (d *darwinDiskDirectory) close() error           { return unix.Close(d.fd) }

func diskSetBackgroundPriority() error {
	// PRIO_DARWIN_PROCESS / PRIO_DARWIN_BG from bsd/sys/resource.h applies
	// background CPU and I/O priority to this one-shot helper process.
	return unix.Setpriority(4, 0, 0x1000)
}

func darwinDiskMetadataFromStat(stat unix.Stat_t, apfs bool) diskMetadata {
	device := strconv.FormatUint(uint64(uint32(stat.Dev)), 10)
	kind := "other"
	switch stat.Mode & unix.S_IFMT {
	case unix.S_IFREG:
		kind = "file"
	case unix.S_IFDIR:
		kind = "folder"
	case unix.S_IFLNK:
		kind = "symlink"
	}
	cloud := stat.Flags&unix.SF_DATALESS != 0
	allocated := stat.Blocks * 512
	if cloud {
		allocated = 0
	}
	return diskMetadata{identity: device + ":" + strconv.FormatUint(stat.Ino, 10), device: device, kind: kind, allocatedBytes: allocated, logicalBytes: stat.Size, nlink: uint64(stat.Nlink), mtimeMs: stat.Mtim.Sec*1000 + stat.Mtim.Nsec/1000000, cloudOnly: cloud, sharedExtentsUnmeasured: apfs && kind == "file" && !cloud}
}

func darwinDiskClassifyPackage(path string, meta diskMetadata) diskMetadata {
	if meta.kind != "folder" || meta.cloudOnly {
		return meta
	}
	// Apple's Bundle Programming Guide identifies these standard bundle
	// extensions; the storage contract additionally treats Photos libraries and
	// Xcode archives as atomic package directories.
	switch strings.ToLower(filepath.Ext(path)) {
	case ".app", ".bundle", ".framework", ".plugin", ".kext", ".photoslibrary", ".xcarchive":
		meta.kind = "package"
	}
	return meta
}

func darwinDiskAttrAt(fd int, name string, buffer []byte) (darwinDiskAttrs, error) {
	pointer, err := unix.BytePtrFromString(name)
	if err != nil {
		return darwinDiskAttrs{}, err
	}
	attrs := darwinDiskRequestedAttrs()
	_, _, errno := unix.Syscall6(unix.SYS_GETATTRLISTAT, uintptr(fd), uintptr(unsafe.Pointer(pointer)), uintptr(unsafe.Pointer(&attrs)), uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)), darwinFSOptNoFollow|darwinFSOptExtended)
	runtime.KeepAlive(pointer)
	runtime.KeepAlive(buffer)
	runtime.KeepAlive(&attrs)
	if errno != 0 {
		return darwinDiskAttrs{}, errno
	}
	return parseDarwinDiskAttrs(buffer)
}

func darwinDiskReadAt(fd int, name string, apfs bool, buffer []byte) (diskMetadata, error) {
	var stat unix.Stat_t
	if err := unix.Fstatat(fd, name, &stat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return diskMetadata{}, err
	}
	meta := darwinDiskMetadataFromStat(stat, apfs)
	// Dataless objects need only the no-follow stat above; no further metadata
	// request or file open is needed to report them as cloud-only.
	if meta.cloudOnly {
		return meta, nil
	}
	attrs, err := darwinDiskAttrAt(fd, name, buffer)
	if err != nil {
		if errors.Is(err, unix.ENOTSUP) || errors.Is(err, unix.ENOSYS) || errors.Is(err, unix.EINVAL) {
			return darwinDiskClassifyPackage(name, meta), nil
		}
		return meta, err
	}
	if attrs.err != nil {
		return meta, attrs.err
	}
	// Firmlinks may project a synthetic st_dev; REALDEVID is intentionally the
	// underlying volume. Compare the inode here and use the attribute identity
	// for the before/after directory-open check below.
	if attrs.identityKnown && attrs.inode != stat.Ino {
		return diskMetadata{}, fmt.Errorf("disk entry changed during metadata query")
	}
	return darwinDiskClassifyPackage(name, darwinDiskMergeAttrs(meta, attrs)), nil
}

func darwinDiskMergeAttrs(meta diskMetadata, attrs darwinDiskAttrs) diskMetadata {
	if attrs.identityKnown {
		meta.identity = attrs.meta.identity
		meta.device = attrs.meta.device
	}
	if attrs.allocationKnown {
		meta.allocatedBytes = attrs.meta.allocatedBytes
		meta.logicalBytes = attrs.meta.logicalBytes
	}
	if attrs.meta.nlink > 0 {
		meta.nlink = attrs.meta.nlink
	}
	meta.cloudOnly = meta.cloudOnly || attrs.meta.cloudOnly
	meta.cloneID = attrs.meta.cloneID
	meta.cloneRefCount = attrs.meta.cloneRefCount
	meta.mayShareBlocks = attrs.meta.mayShareBlocks
	meta.sharesAllBlocks = attrs.meta.sharesAllBlocks
	meta.privateBytes = attrs.meta.privateBytes
	meta.privateBytesKnown = attrs.meta.privateBytesKnown
	meta.dataAllocatedBytes = attrs.meta.dataAllocatedBytes
	meta.dataAllocationKnown = attrs.meta.dataAllocationKnown
	meta.extFlagsKnown = attrs.meta.extFlagsKnown
	if attrs.meta.extFlagsKnown {
		meta.sharedExtentsUnmeasured = false
	}
	if meta.cloudOnly {
		meta.allocatedBytes = 0
		meta.dataAllocatedBytes = 0
	}
	return meta
}

// Hold every parent descriptor while resolving the next component. O_NOFOLLOW
// rejects root aliases and ancestor symlink swaps before enumeration begins.
func darwinDiskOpenParent(path string) (int, string, string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return -1, "", "", err
	}
	absolute = diskNormalizePath(absolute)
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, "", "", err
	}
	if absolute == "/" {
		return fd, ".", absolute, nil
	}
	parts := strings.Split(strings.TrimPrefix(absolute, "/"), "/")
	for _, part := range parts[:len(parts)-1] {
		var before unix.Stat_t
		if statErr := unix.Fstatat(fd, part, &before, unix.AT_SYMLINK_NOFOLLOW); statErr != nil {
			_ = unix.Close(fd)
			return -1, "", "", statErr
		}
		if before.Mode&unix.S_IFMT != unix.S_IFDIR || before.Flags&unix.SF_DATALESS != 0 {
			_ = unix.Close(fd)
			return -1, "", "", fmt.Errorf("disk ancestor is not a local directory")
		}
		next, openErr := unix.Openat(fd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		_ = unix.Close(fd)
		if openErr != nil {
			return -1, "", "", openErr
		}
		var after unix.Stat_t
		if statErr := unix.Fstat(next, &after); statErr != nil {
			_ = unix.Close(next)
			return -1, "", "", statErr
		}
		if before.Dev != after.Dev || before.Ino != after.Ino || after.Flags&unix.SF_DATALESS != 0 {
			_ = unix.Close(next)
			return -1, "", "", fmt.Errorf("disk ancestor changed while opening")
		}
		fd = next
	}
	return fd, parts[len(parts)-1], absolute, nil
}

func darwinDiskStripLookupPrefix(path string) string {
	for _, prefix := range []string{"/.nofollow", "/.resolve"} {
		if path == prefix {
			return "/"
		}
		if strings.HasPrefix(path, prefix+"/") {
			return strings.TrimPrefix(path, prefix)
		}
	}
	return path
}

func diskNormalizePath(path string) string {
	return darwinDiskStripLookupPrefix(filepath.Clean(path))
}

func diskReadMetadata(path string, _ ...map[string]diskMetadata) (diskMetadata, error) {
	fd, name, _, err := darwinDiskOpenParent(path)
	if err != nil {
		return diskMetadata{}, err
	}
	defer unix.Close(fd)
	var fs unix.Statfs_t
	if err := unix.Fstatfs(fd, &fs); err != nil {
		return diskMetadata{}, err
	}
	buffer := darwinDiskBuffers.Get().([]byte)
	defer darwinDiskBuffers.Put(buffer)
	return darwinDiskReadAt(fd, name, unix.ByteSliceToString(fs.Fstypename[:]) == "apfs", buffer)
}

func diskOpenRoot(path string) (diskDirectory, error) {
	parent, name, absolute, err := darwinDiskOpenParent(path)
	if err != nil {
		return nil, err
	}
	defer unix.Close(parent)
	buffer := darwinDiskBuffers.Get().([]byte)
	defer darwinDiskBuffers.Put(buffer)
	meta, err := darwinDiskReadAt(parent, name, false, buffer)
	if err != nil {
		return nil, err
	}
	if (meta.kind != "folder" && meta.kind != "package") || meta.cloudOnly {
		return nil, fmt.Errorf("disk root is not a local directory")
	}
	fd, err := unix.Openat(parent, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	dir, err := darwinDiskDirectoryFromFD(fd, absolute)
	if err != nil {
		_ = unix.Close(fd)
		return nil, err
	}
	if dir.meta.identity != meta.identity {
		_ = unix.Close(fd)
		return nil, fmt.Errorf("disk root changed before opening")
	}
	return dir, nil
}

func darwinDiskDirectoryFromFD(fd int, path string) (*darwinDiskDirectory, error) {
	var stat unix.Stat_t
	var fs unix.Statfs_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return nil, err
	}
	if err := unix.Fstatfs(fd, &fs); err != nil {
		return nil, err
	}
	apfs := unix.ByteSliceToString(fs.Fstypename[:]) == "apfs"
	meta := darwinDiskMetadataFromStat(stat, apfs)
	buffer := darwinDiskBuffers.Get().([]byte)
	defer darwinDiskBuffers.Put(buffer)
	attrs, err := darwinDiskAttrAt(fd, ".", buffer)
	if err != nil {
		if !errors.Is(err, unix.ENOTSUP) && !errors.Is(err, unix.ENOSYS) && !errors.Is(err, unix.EINVAL) {
			return nil, err
		}
	} else {
		if attrs.err != nil {
			return nil, attrs.err
		}
		meta = darwinDiskMergeAttrs(meta, attrs)
	}
	return &darwinDiskDirectory{fd: fd, path: path, meta: darwinDiskClassifyPackage(path, meta), apfs: apfs}, nil
}

func (d *darwinDiskDirectory) openChild(entry diskEntry) (diskDirectory, error) {
	if entry.meta.cloudOnly || (entry.meta.kind != "folder" && entry.meta.kind != "package") || entry.name == "" || entry.name == "." || entry.name == ".." || strings.Contains(entry.name, "/") {
		return nil, fmt.Errorf("disk child is not a local directory")
	}
	buffer := darwinDiskBuffers.Get().([]byte)
	defer darwinDiskBuffers.Put(buffer)
	current, err := darwinDiskReadAt(d.fd, entry.name, d.apfs, buffer)
	if err != nil {
		return nil, err
	}
	if current.cloudOnly || (current.kind != "folder" && current.kind != "package") || current.identity != entry.meta.identity {
		return nil, fmt.Errorf("disk child changed before opening")
	}
	fd, err := unix.Openat(d.fd, entry.name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	child, err := darwinDiskDirectoryFromFD(fd, filepath.Join(d.path, entry.name))
	if err != nil {
		_ = unix.Close(fd)
		return nil, err
	}
	if child.meta.cloudOnly || child.meta.identity != entry.meta.identity {
		_ = unix.Close(fd)
		return nil, fmt.Errorf("disk child changed while opening")
	}
	return child, nil
}

func (d *darwinDiskDirectory) entries(ctx context.Context) ([]diskEntry, string, error) {
	entries := []diskEntry{}
	backend, err := d.entryBatches(ctx, func(batch []diskEntry) error { entries = append(entries, batch...); return nil })
	return entries, backend, err
}
func (d *darwinDiskDirectory) entryBatches(ctx context.Context, visit func([]diskEntry) error) (string, error) {
	emitted := false
	err := d.entriesBulkVisit(ctx, func(batch []diskEntry) error { emitted = true; return visit(batch) })
	if err == nil {
		return "getattrlistbulk", nil
	}
	if emitted || (!errors.Is(err, unix.ENOTSUP) && !errors.Is(err, unix.ENOSYS) && !errors.Is(err, unix.EINVAL)) {
		return "getattrlistbulk", err
	}
	return "readdir-fstatat", d.entriesFallbackVisit(ctx, visit)
}

func (d *darwinDiskDirectory) entriesBulk(ctx context.Context) ([]diskEntry, error) {
	var entries []diskEntry
	err := d.entriesBulkVisit(ctx, func(batch []diskEntry) error { entries = append(entries, batch...); return nil })
	return entries, err
}
func (d *darwinDiskDirectory) entriesBulkVisit(ctx context.Context, visit func([]diskEntry) error) error {
	batch := diskEntryBuffer{visit: visit}
	fd, err := unix.Openat(d.fd, ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	buffer := darwinDiskBuffers.Get().([]byte)
	defer darwinDiskBuffers.Put(buffer)
	metadataBuffer := darwinDiskBuffers.Get().([]byte)
	defer darwinDiskBuffers.Put(metadataBuffer)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		attrs := darwinDiskRequestedAttrs()
		count, _, errno := unix.Syscall6(unix.SYS_GETATTRLISTBULK, uintptr(fd), uintptr(unsafe.Pointer(&attrs)), uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)), darwinFSOptNoFollow|darwinFSOptExtended, 0)
		runtime.KeepAlive(&attrs)
		runtime.KeepAlive(buffer)
		if errno != 0 {
			return errno
		}
		if count == 0 {
			return nil
		}
		offset := 0
		for i := uintptr(0); i < count; i++ {
			if len(buffer)-offset < 4 {
				return fmt.Errorf("truncated Darwin directory batch")
			}
			length := int(binary.LittleEndian.Uint32(buffer[offset : offset+4]))
			if length < 24 || length > len(buffer)-offset {
				return fmt.Errorf("invalid Darwin directory batch length")
			}
			parsed, err := parseDarwinDiskAttrs(buffer[offset : offset+length])
			if err != nil {
				return err
			}
			offset += length
			if parsed.name == "" || parsed.name == "." || parsed.name == ".." {
				continue
			}
			entry := diskEntry{name: parsed.name, path: filepath.Join(d.path, parsed.name), meta: parsed.meta, err: parsed.err}
			if entry.err == nil && (!parsed.identityKnown || !parsed.allocationKnown || !parsed.commonFlagsKnown || parsed.meta.nlink == 0 || parsed.meta.kind == "") {
				entry.meta, entry.err = darwinDiskReadAt(d.fd, entry.name, d.apfs, metadataBuffer)
			} else if entry.err == nil {
				entry.meta.sharedExtentsUnmeasured = d.apfs && entry.meta.kind == "file" && !parsed.meta.extFlagsKnown && !entry.meta.cloudOnly
			}
			if entry.err == nil {
				entry.meta = darwinDiskClassifyPackage(entry.name, entry.meta)
			}
			if err := batch.append(entry); err != nil {
				return err
			}
		}
		if err := batch.flush(); err != nil {
			return err
		}
	}
}

func (d *darwinDiskDirectory) entriesFallback(ctx context.Context) ([]diskEntry, error) {
	var entries []diskEntry
	err := d.entriesFallbackVisit(ctx, func(batch []diskEntry) error { entries = append(entries, batch...); return nil })
	return entries, err
}
func (d *darwinDiskDirectory) entriesFallbackVisit(ctx context.Context, visit func([]diskEntry) error) error {
	batch := diskEntryBuffer{visit: visit}
	fd, err := unix.Openat(d.fd, ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	file := os.NewFile(uintptr(fd), d.path)
	if file == nil {
		_ = unix.Close(fd)
		return fmt.Errorf("disk directory descriptor unavailable")
	}
	defer file.Close()
	buffer := darwinDiskBuffers.Get().([]byte)
	defer darwinDiskBuffers.Put(buffer)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		// Read only entry names: DirEntry.Info would query by the old path after
		// an ancestor rename. All metadata remains relative to the held fd.
		names, readErr := file.Readdirnames(256)
		for _, name := range names {
			if err := ctx.Err(); err != nil {
				return err
			}
			meta, statErr := darwinDiskReadAt(d.fd, name, d.apfs, buffer)
			if err := batch.append(diskEntry{name: name, path: filepath.Join(d.path, name), meta: meta, err: statErr}); err != nil {
				return err
			}
		}
		if err := batch.flush(); err != nil {
			return err
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return nil
			}
			return readErr
		}
	}
}

func diskMeasureSharedExtents(path string, meta diskMetadata) (int64, int64, error) {
	if meta.cloudOnly {
		return 0, 0, nil
	}
	if meta.privateBytesKnown {
		return meta.privateBytes, meta.allocatedBytes, nil
	}
	if !meta.mayShareBlocks && !meta.sharedExtentsUnmeasured {
		return meta.allocatedBytes, meta.allocatedBytes, nil
	}
	parent, name, _, err := darwinDiskOpenParent(path)
	if err != nil {
		return 0, meta.allocatedBytes, err
	}
	defer unix.Close(parent)
	buffer := darwinDiskBuffers.Get().([]byte)
	defer darwinDiskBuffers.Put(buffer)
	attrs, err := darwinDiskAttrAt(parent, name, buffer)
	if err != nil {
		return 0, meta.allocatedBytes, err
	}
	if attrs.err != nil {
		return 0, meta.allocatedBytes, attrs.err
	}
	if !attrs.identityKnown || attrs.meta.identity != meta.identity {
		return 0, meta.allocatedBytes, fmt.Errorf("disk item changed before clone measurement")
	}
	if attrs.meta.privateBytesKnown {
		return attrs.meta.privateBytes, meta.allocatedBytes, nil
	}
	return 0, meta.allocatedBytes, nil
}

func diskShouldSkip(path string, root string, meta diskMetadata) (bool, string) {
	path = filepath.Clean(path)
	root = diskNormalizePath(root)
	if path == root {
		return false, ""
	}
	if root == "/" {
		for _, excluded := range []string{"/.nofollow", "/.resolve", "/.file", "/.vol", "/dev", "/Volumes", "/System/Volumes"} {
			if path == excluded || strings.HasPrefix(path, excluded+"/") {
				return true, "startup-system-mount"
			}
		}
	}
	return false, ""
}
