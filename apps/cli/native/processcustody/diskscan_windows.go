//go:build windows

package main

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	diskWindowsRecallOnOpen       = uint32(0x00040000)
	diskWindowsRecallOnDataAccess = uint32(0x00400000)
	// This is a reusable enumeration buffer, not a limit on directory entries.
	diskWindowsDirectoryBufferBytes = 64 * 1024
	diskWindowsFullDirectoryInfo    = 2
)

type diskWindowsDirectory struct {
	handle windows.Handle
	path   string
	meta   diskMetadata
	refs   bool
	buffer []byte
}

func diskReadLocalSnapshotCount(context.Context, string) *int64 { return nil }

type diskWindowsStandardInfo struct {
	AllocationSize int64
	EndOfFile      int64
	NumberOfLinks  uint32
	DeletePending  byte
	Directory      byte
	Padding        [2]byte
}

type diskWindowsBasicInfo struct {
	CreationTime, LastAccessTime, LastWriteTime, ChangeTime int64
	Attributes, Padding                                     uint32
}

type diskWindowsCompressionInfo struct {
	CompressedFileSize int64
	CompressionFormat  uint16
	CompressionUnit    byte
	ChunkShift         byte
	ClusterShift       byte
	Reserved           [3]byte
}

func diskWindowsCloud(attributes uint32) bool {
	return attributes&(windows.FILE_ATTRIBUTE_OFFLINE|diskWindowsRecallOnOpen|diskWindowsRecallOnDataAccess) != 0
}
func diskNormalizePath(path string) string { return filepath.Clean(path) }

func diskWindowsMetadata(attributes, tag uint32, device string, id []byte, allocated, logical, modified int64, refs bool) diskMetadata {
	kind := "file"
	if attributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0 {
		kind = "folder"
	}
	if attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		kind = "symlink"
		if tag == windows.IO_REPARSE_TAG_MOUNT_POINT {
			kind = "mount"
		}
	}
	cloud := diskWindowsCloud(attributes)
	if cloud {
		kind = "cloud-only"
		allocated = 0
	}
	identity := ""
	for _, part := range id {
		if part != 0 {
			identity = device + ":" + hex.EncodeToString(id)
			break
		}
	}
	return diskMetadata{
		identity: identity, device: device, kind: kind, allocatedBytes: allocated,
		logicalBytes: logical, mtimeMs: modified, cloudOnly: cloud,
		sharedExtentsUnmeasured: refs && kind == "file",
	}
}

func diskWindowsFiletime(milliseconds int64) int64 {
	return (milliseconds - 116444736000000000) / 10000
}

// FILE_ID_EXTD_DIR_INFO's variable UTF-16 name starts at byte 88.
// https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_extd_dir_info
func diskWindowsParseDirectory(buffer []byte, path, device string, refs bool) ([]diskEntry, error) {
	var entries []diskEntry
	for offset := 0; ; {
		if len(buffer)-offset < 88 {
			return nil, fmt.Errorf("truncated extended directory record")
		}
		record := buffer[offset:]
		next := int(binary.LittleEndian.Uint32(record))
		nameBytes := int(binary.LittleEndian.Uint32(record[60:]))
		if nameBytes%2 != 0 || nameBytes > len(record)-88 {
			return nil, fmt.Errorf("invalid extended directory name length")
		}
		if next != 0 && (next%8 != 0 || next < 88+nameBytes || next > len(record)-88) {
			return nil, fmt.Errorf("invalid extended directory offset")
		}
		name, err := diskWindowsDecodeName(record[88 : 88+nameBytes])
		if err != nil {
			return nil, err
		}
		if name != "." && name != ".." {
			meta := diskWindowsMetadata(binary.LittleEndian.Uint32(record[56:]), binary.LittleEndian.Uint32(record[68:]), device, record[72:88], int64(binary.LittleEndian.Uint64(record[48:])), int64(binary.LittleEndian.Uint64(record[40:])), diskWindowsFiletime(int64(binary.LittleEndian.Uint64(record[24:]))), refs)
			entries = append(entries, diskEntry{name: name, path: filepath.Join(path, name), meta: meta})
		}
		if next == 0 {
			return entries, nil
		}
		offset += next
	}
}

func diskWindowsDecodeName(encoded []byte) (string, error) {
	words := make([]uint16, len(encoded)/2)
	for index := range words {
		words[index] = binary.LittleEndian.Uint16(encoded[index*2:])
	}
	name, err := decodeWorkspaceConfinedWindowsDirectoryName(words)
	if err != nil {
		return "", err
	}
	if name != "." && name != ".." {
		components, domainErr := validateWorkspaceConfinedRelativePath(name)
		if domainErr != nil || len(components) != 1 {
			return "", fmt.Errorf("unsafe disk directory name")
		}
	}
	return name, nil
}

func diskWindowsOpen(parent windows.Handle, name string, directory bool) (windows.Handle, error) {
	unicodeName, err := windows.NewNTUnicodeString(name)
	if err != nil {
		return 0, err
	}
	attributes := windows.OBJECT_ATTRIBUTES{Length: uint32(unsafe.Sizeof(windows.OBJECT_ATTRIBUTES{})), RootDirectory: parent, ObjectName: unicodeName, Attributes: windows.OBJ_CASE_INSENSITIVE}
	access := uint32(windows.FILE_READ_ATTRIBUTES | windows.SYNCHRONIZE)
	options := uint32(windows.FILE_OPEN_REPARSE_POINT | windows.FILE_OPEN_NO_RECALL | windows.FILE_SYNCHRONOUS_IO_NONALERT)
	if directory {
		// NTFS rejects FILE_OPEN_NO_RECALL with FILE_DIRECTORY_FILE. Keep the
		// no-recall guarantee and verify the directory type from the held handle.
		access |= windows.FILE_LIST_DIRECTORY | windows.FILE_TRAVERSE
	}
	var handle windows.Handle
	var status windows.IO_STATUS_BLOCK
	err = windows.NtCreateFile(&handle, access, &attributes, &status, nil, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, windows.FILE_OPEN, options, 0, 0)
	if status, ok := err.(windows.NTStatus); ok {
		return 0, fmt.Errorf("NtCreateFile disk directory=%t: %w", directory, status.Errno())
	}
	return handle, err
}

func diskWindowsHandleMetadata(handle windows.Handle, refs bool, knownFiles ...map[string]diskMetadata) (diskMetadata, error) {
	var info windows.ByHandleFileInformation
	cacheEnabled := len(knownFiles) > 0 && knownFiles[0] != nil
	if cacheEnabled {
		// Unlike BY_HANDLE_FILE_INFORMATION, FILE_BASIC_INFO does not return
		// NumberOfLinks. Ordinary-file cache hits only recheck attributes/ID.
		var basic diskWindowsBasicInfo
		if err := windows.GetFileInformationByHandleEx(handle, windows.FileBasicInfo, (*byte)(unsafe.Pointer(&basic)), uint32(unsafe.Sizeof(basic))); err != nil {
			return diskMetadata{}, fmt.Errorf("GetFileInformationByHandleEx FileBasicInfo: %w", err)
		}
		info.FileAttributes = basic.Attributes
		info.LastWriteTime = windows.Filetime{LowDateTime: uint32(basic.LastWriteTime), HighDateTime: uint32(uint64(basic.LastWriteTime) >> 32)}
	} else {
		if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
			return diskMetadata{}, fmt.Errorf("GetFileInformationByHandle disk metadata: %w", err)
		}
	}
	var tagInfo struct {
		Attributes uint32
		Tag        uint32
	}
	if err := windows.GetFileInformationByHandleEx(handle, windows.FileAttributeTagInfo, (*byte)(unsafe.Pointer(&tagInfo)), uint32(unsafe.Sizeof(tagInfo))); err != nil && info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return diskMetadata{}, err
	}
	var idInfo workspaceConfinedFileIDInfo
	if err := windows.GetFileInformationByHandleEx(handle, windows.FileIdInfo, (*byte)(unsafe.Pointer(&idInfo)), uint32(unsafe.Sizeof(idInfo))); err != nil {
		// Older/FAT filesystems provide a 64-bit ID through the older query.
		// That legacy identity fallback also returns an incidental link count;
		// only FileStandardInfo supplies the invocation's authoritative count.
		if cacheEnabled {
			var legacy windows.ByHandleFileInformation
			if err := windows.GetFileInformationByHandle(handle, &legacy); err != nil {
				return diskMetadata{}, err
			}
			info.VolumeSerialNumber, info.FileIndexHigh, info.FileIndexLow = legacy.VolumeSerialNumber, legacy.FileIndexHigh, legacy.FileIndexLow
		}
		idInfo.VolumeSerialNumber = uint64(info.VolumeSerialNumber)
		binary.LittleEndian.PutUint64(idInfo.FileID[:], uint64(info.FileIndexHigh)<<32|uint64(info.FileIndexLow))
	}
	meta := diskWindowsMetadata(info.FileAttributes, tagInfo.Tag, strconv.FormatUint(idInfo.VolumeSerialNumber, 10), idInfo.FileID[:], 0, 0, info.LastWriteTime.Nanoseconds()/1000000, refs)
	var fileFacts map[string]diskMetadata
	if len(knownFiles) > 0 && meta.kind == "file" && !meta.cloudOnly && meta.identity != "" {
		fileFacts = knownFiles[0]
		if known, ok := fileFacts[meta.identity]; ok {
			if known.metadataReadError != nil {
				return diskMetadata{}, known.metadataReadError
			}
			// Identity and ordinary-file type were verified on this held handle.
			// FileStandardInfo (including NumberOfLinks) is invocation-local:
			// selecting another hardlink must not query those facts again.
			meta.allocatedBytes, meta.logicalBytes = known.allocatedBytes, known.logicalBytes
			meta.nlink, meta.nlinkAttempted = known.nlink, true
			return meta, nil
		}
	}
	rememberFailure := func(err error) {
		if fileFacts != nil {
			meta.nlinkAttempted, meta.metadataReadError = true, err
			fileFacts[meta.identity] = meta
		}
	}
	var standard diskWindowsStandardInfo
	if err := windows.GetFileInformationByHandleEx(handle, windows.FileStandardInfo, (*byte)(unsafe.Pointer(&standard)), uint32(unsafe.Sizeof(standard))); err != nil {
		err = fmt.Errorf("GetFileInformationByHandleEx FileStandardInfo: %w", err)
		rememberFailure(err)
		return diskMetadata{}, err
	}
	allocated := standard.AllocationSize
	if info.FileAttributes&(windows.FILE_ATTRIBUTE_COMPRESSED|windows.FILE_ATTRIBUTE_SPARSE_FILE) != 0 && info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
		var compression diskWindowsCompressionInfo
		if err := windows.GetFileInformationByHandleEx(handle, windows.FileCompressionInfo, (*byte)(unsafe.Pointer(&compression)), uint32(unsafe.Sizeof(compression))); err != nil {
			rememberFailure(err)
			return diskMetadata{}, err
		}
		allocated = compression.CompressedFileSize
	}
	meta.allocatedBytes, meta.logicalBytes = allocated, standard.EndOfFile
	meta.nlink = uint64(standard.NumberOfLinks)
	meta.nlinkAttempted = true
	if fileFacts != nil && meta.nlink != 1 {
		fileFacts[meta.identity] = meta
	}
	return meta, nil
}

func diskWindowsDirectoryForHandle(handle windows.Handle, path string) (*diskWindowsDirectory, error) {
	meta, err := diskWindowsHandleMetadata(handle, false)
	if err != nil {
		return nil, err
	}
	if meta.kind != "folder" || meta.cloudOnly {
		return nil, fmt.Errorf("disk path is not an ordinary directory")
	}
	if meta.identity == "" {
		meta.identity = meta.device + ":path:" + strings.ToLower(path)
		meta.nlink = 0
	}
	var fsName [32]uint16
	refs := windows.GetVolumeInformationByHandle(handle, nil, 0, nil, nil, nil, &fsName[0], uint32(len(fsName))) == nil && strings.EqualFold(windows.UTF16ToString(fsName[:]), "ReFS")
	return &diskWindowsDirectory{handle: handle, path: path, meta: meta, refs: refs, buffer: make([]byte, diskWindowsDirectoryBufferBytes)}, nil
}

// Normalize through the existing Windows path owner, then walk each component
// relative to a held handle. A single full-path open would follow junctions in
// ancestors even with FILE_OPEN_REPARSE_POINT set for the leaf.
func diskWindowsOpenVolume(path string) (*diskWindowsDirectory, []string, error) {
	cleaned, _, domainErr := workspaceConfinedNTAbsolutePath(path)
	if domainErr != nil {
		return nil, nil, fmt.Errorf("invalid disk path: %s", domainErr.code)
	}
	volume := filepath.VolumeName(cleaned)
	volumeRoot := volume + `\`
	_, ntVolume, domainErr := workspaceConfinedNTAbsolutePath(volumeRoot)
	if domainErr != nil {
		return nil, nil, fmt.Errorf("invalid disk volume")
	}
	handle, err := diskWindowsOpen(0, ntVolume, true)
	if err != nil {
		return nil, nil, err
	}
	directory, err := diskWindowsDirectoryForHandle(handle, volumeRoot)
	if err != nil {
		windows.CloseHandle(handle)
		return nil, nil, err
	}
	components := strings.FieldsFunc(strings.TrimPrefix(cleaned, volume), func(r rune) bool { return r == '\\' || r == '/' })
	return directory, components, nil
}

func diskOpenRoot(path string) (diskDirectory, error) {
	directory, components, err := diskWindowsOpenVolume(path)
	if err != nil {
		return nil, err
	}
	for _, name := range components {
		entry, err := directory.findEntry(name)
		if err != nil {
			directory.close()
			return nil, err
		}
		child, err := directory.openChild(entry)
		directory.close()
		if err != nil {
			return nil, err
		}
		directory = child.(*diskWindowsDirectory)
	}
	return directory, nil
}

func diskReadMetadata(path string, knownFiles ...map[string]diskMetadata) (diskMetadata, error) {
	directory, components, err := diskWindowsOpenVolume(path)
	if err != nil {
		return diskMetadata{}, err
	}
	if len(components) == 0 {
		defer directory.close()
		return directory.meta, nil
	}
	for index, name := range components {
		entry, err := directory.findEntry(name)
		if err != nil {
			directory.close()
			return diskMetadata{}, err
		}
		if index == len(components)-1 {
			defer directory.close()
			return directory.readEntryMetadata(entry, knownFiles...)
		}
		child, err := directory.openChild(entry)
		directory.close()
		if err != nil {
			return diskMetadata{}, err
		}
		directory = child.(*diskWindowsDirectory)
	}
	return diskMetadata{}, fmt.Errorf("disk path has no final component")
}

func (directory *diskWindowsDirectory) metadata() diskMetadata { return directory.meta }
func (directory *diskWindowsDirectory) close() error           { return windows.CloseHandle(directory.handle) }

func (directory *diskWindowsDirectory) openChild(entry diskEntry) (diskDirectory, error) {
	if entry.meta.cloudOnly || entry.meta.kind != "folder" {
		return nil, fmt.Errorf("disk child is not an ordinary directory")
	}
	components, domainErr := validateWorkspaceConfinedRelativePath(entry.name)
	if domainErr != nil || len(components) != 1 {
		return nil, fmt.Errorf("invalid disk child name")
	}
	// Re-read before opening: a directory can have become a cloud placeholder.
	current, err := directory.findEntry(entry.name)
	if err != nil {
		return nil, err
	}
	if current.meta.cloudOnly || current.meta.kind != "folder" {
		return nil, fmt.Errorf("disk child changed to a reparse point or placeholder")
	}
	handle, err := diskWindowsOpen(directory.handle, entry.name, true)
	if err != nil {
		return nil, err
	}
	child, err := diskWindowsDirectoryForHandle(handle, entry.path)
	if err != nil {
		windows.CloseHandle(handle)
		return nil, err
	}
	if entry.meta.identity != "" && child.meta.identity != entry.meta.identity {
		child.close()
		return nil, fmt.Errorf("disk child identity changed")
	}
	return child, nil
}

func (directory *diskWindowsDirectory) entries(ctx context.Context) ([]diskEntry, string, error) {
	return directory.entriesWithFileFacts(ctx, nil, nil)
}

func (directory *diskWindowsDirectory) entryBatches(ctx context.Context, visit func([]diskEntry) error) (string, error) {
	emitted := false
	err := directory.entriesBulkVisit(ctx, func(batch []diskEntry) error {
		// A filesystem may return no IDs without rejecting the bulk class.
		// Refresh only those metadata leaves using the same held parent, rather
		// than restarting a previously emitted directory and duplicating names.
		for i := range batch {
			if batch[i].meta.identity == "" && !batch[i].meta.cloudOnly {
				batch[i].meta, batch[i].err = directory.readEntryMetadata(batch[i])
			}
		}
		emitted = true
		return visit(batch)
	})
	if err == nil {
		return "windows-file-id-extd", nil
	}
	if emitted || (!errors.Is(err, windows.ERROR_INVALID_PARAMETER) && !errors.Is(err, windows.ERROR_NOT_SUPPORTED) && !errors.Is(err, windows.ERROR_INVALID_FUNCTION) && !errors.Is(err, windows.ERROR_CALL_NOT_IMPLEMENTED)) {
		return "windows-file-id-extd", err
	}
	return "windows-fallback", directory.entriesFallbackVisit(ctx, visit)
}

func (directory *diskWindowsDirectory) entriesWithFileFacts(ctx context.Context, knownFiles map[string]diskMetadata, factsMu *sync.Mutex) ([]diskEntry, string, error) {
	fallback := func() ([]diskEntry, error) {
		// Fallback metadata and bulk-worker metadata share the invocation's
		// ordinary-ID facts, including failed attempts. Scan has neither map
		// nor lock and retains the existing fallback metadata path.
		if factsMu != nil {
			factsMu.Lock()
			defer factsMu.Unlock()
		}
		return directory.entriesFallback(ctx, knownFiles)
	}
	entries, err := directory.entriesBulk(ctx)
	if err == nil {
		// Some filesystems return zero IDs instead of rejecting the class.
		for _, entry := range entries {
			if entry.meta.identity == "" && !entry.meta.cloudOnly {
				entries, err = fallback()
				return entries, "windows-fallback", err
			}
		}
		return entries, "windows-file-id-extd", nil
	}
	if !errors.Is(err, windows.ERROR_INVALID_PARAMETER) && !errors.Is(err, windows.ERROR_NOT_SUPPORTED) && !errors.Is(err, windows.ERROR_INVALID_FUNCTION) && !errors.Is(err, windows.ERROR_CALL_NOT_IMPLEMENTED) {
		return nil, "windows-file-id-extd", err
	}
	entries, err = fallback()
	return entries, "windows-fallback", err
}

func (directory *diskWindowsDirectory) entriesBulk(ctx context.Context) ([]diskEntry, error) {
	var entries []diskEntry
	err := directory.entriesBulkVisit(ctx, func(batch []diskEntry) error { entries = append(entries, batch...); return nil })
	return entries, err
}
func (directory *diskWindowsDirectory) entriesBulkVisit(ctx context.Context, visit func([]diskEntry) error) error {
	class := uint32(windows.FileIdExtdDirectoryRestartInfo)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := windows.GetFileInformationByHandleEx(directory.handle, class, &directory.buffer[0], uint32(len(directory.buffer)))
		if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
			return nil
		}
		if err != nil {
			return err
		}
		batch, err := diskWindowsParseDirectory(directory.buffer, directory.path, directory.meta.device, directory.refs)
		if err != nil {
			return err
		}
		if err := visit(batch); err != nil {
			return err
		}
		class = windows.FileIdExtdDirectoryInfo
	}
}

// The fallback uses the same held directory and NT directory query, rather than
// ReadDir(path), which could traverse a concurrently swapped ancestor.
func (directory *diskWindowsDirectory) queryFull(name string, restart bool) ([]diskEntry, error) {
	var pattern *windows.NTUnicodeString
	var err error
	if name != "" {
		pattern, err = windows.NewNTUnicodeString(name)
		if err != nil {
			return nil, err
		}
	}
	var statusBlock windows.IO_STATUS_BLOCK
	restartFlag := uintptr(0)
	if restart {
		restartFlag = 1
	}
	statusValue, _, _ := workspaceConfinedNtQueryDirectoryFile.Call(uintptr(directory.handle), 0, 0, 0, uintptr(unsafe.Pointer(&statusBlock)), uintptr(unsafe.Pointer(&directory.buffer[0])), uintptr(len(directory.buffer)), diskWindowsFullDirectoryInfo, 0, uintptr(unsafe.Pointer(pattern)), restartFlag)
	status := windows.NTStatus(statusValue)
	if status == windows.STATUS_NO_MORE_FILES || status == windows.STATUS_NO_SUCH_FILE {
		return nil, windows.ERROR_NO_MORE_FILES
	}
	if status != 0 {
		return nil, status.Errno()
	}
	used := int(statusBlock.Information)
	if used < 68 || used > len(directory.buffer) {
		return nil, fmt.Errorf("invalid fallback directory result")
	}
	var entries []diskEntry
	for offset := 0; ; {
		if used-offset < 68 {
			return nil, fmt.Errorf("truncated fallback directory record")
		}
		record := directory.buffer[offset:used]
		next := int(binary.LittleEndian.Uint32(record))
		nameBytes := int(binary.LittleEndian.Uint32(record[60:]))
		if nameBytes%2 != 0 || nameBytes > len(record)-68 || (next != 0 && (next%8 != 0 || next < 68+nameBytes || next > len(record)-68)) {
			return nil, fmt.Errorf("invalid fallback directory record")
		}
		entryName, err := diskWindowsDecodeName(record[68 : 68+nameBytes])
		if err != nil {
			return nil, err
		}
		if entryName != "." && entryName != ".." {
			meta := diskWindowsMetadata(binary.LittleEndian.Uint32(record[56:]), binary.LittleEndian.Uint32(record[64:]), directory.meta.device, nil, int64(binary.LittleEndian.Uint64(record[48:])), int64(binary.LittleEndian.Uint64(record[40:])), diskWindowsFiletime(int64(binary.LittleEndian.Uint64(record[24:]))), directory.refs)
			entries = append(entries, diskEntry{name: entryName, path: filepath.Join(directory.path, entryName), meta: meta})
		}
		if next == 0 {
			return entries, nil
		}
		offset += next
	}
}

func (directory *diskWindowsDirectory) findEntry(name string) (diskEntry, error) {
	// An independent attribute-only directory handle keeps filtered queries from
	// changing the cursor/filter of the main directory enumeration.
	// Native NT names do not normalize "."; an empty relative name reopens
	// the held directory itself without resolving its former path again.
	handle, err := diskWindowsOpen(directory.handle, "", true)
	if err != nil {
		return diskEntry{}, err
	}
	defer windows.CloseHandle(handle)
	probe := &diskWindowsDirectory{handle: handle, path: directory.path, meta: directory.meta, refs: directory.refs, buffer: directory.buffer}
	entries, err := probe.queryFull(name, true)
	if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
		return diskEntry{}, windows.ERROR_FILE_NOT_FOUND
	}
	if err != nil {
		return diskEntry{}, err
	}
	for _, entry := range entries {
		if strings.EqualFold(entry.name, name) {
			return entry, nil
		}
	}
	return diskEntry{}, windows.ERROR_FILE_NOT_FOUND
}

func (directory *diskWindowsDirectory) readEntryMetadata(entry diskEntry, knownFiles ...map[string]diskMetadata) (diskMetadata, error) {
	if entry.meta.cloudOnly {
		return entry.meta, nil
	}
	if entry.meta.identity != "" {
		// Bulk entries can have changed since enumeration. The held-parent,
		// name-filtered query checks cloud state without opening the leaf.
		current, err := directory.findEntry(entry.name)
		if err != nil {
			return diskMetadata{}, err
		}
		if current.meta.cloudOnly || current.meta.kind != entry.meta.kind {
			return current.meta, nil
		}
	}
	handle, err := diskWindowsOpen(directory.handle, entry.name, false)
	if err != nil {
		return diskMetadata{}, err
	}
	defer windows.CloseHandle(handle)
	if entry.meta.kind != "file" {
		knownFiles = nil
	}
	meta, err := diskWindowsHandleMetadata(handle, directory.refs, knownFiles...)
	if err != nil {
		return diskMetadata{}, err
	}
	if meta.identity == "" {
		// With no file ID the filesystem cannot prove deduplication or nlink;
		// retain the item distinctly and do not claim exclusive reclamation.
		meta.identity = meta.device + ":path:" + strings.ToLower(entry.path)
		meta.nlink = 0
	}
	return meta, nil
}

func (directory *diskWindowsDirectory) entriesFallback(ctx context.Context, knownFiles ...map[string]diskMetadata) ([]diskEntry, error) {
	var entries []diskEntry
	err := directory.entriesFallbackVisit(ctx, func(batch []diskEntry) error { entries = append(entries, batch...); return nil }, knownFiles...)
	return entries, err
}
func (directory *diskWindowsDirectory) entriesFallbackVisit(ctx context.Context, visit func([]diskEntry) error, knownFiles ...map[string]diskMetadata) error {
	restart := true
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		batch, err := directory.queryFull("", restart)
		restart = false
		if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
			return nil
		}
		if err != nil {
			return err
		}
		for i := range batch {
			if err := ctx.Err(); err != nil {
				return err
			}
			batch[i].meta, batch[i].err = directory.readEntryMetadata(batch[i], knownFiles...)
		}
		if err := visit(batch); err != nil {
			return err
		}
	}
}

func diskSetBackgroundPriority() error {
	return windows.SetPriorityClass(windows.CurrentProcess(), 0x00100000) // PROCESS_MODE_BACKGROUND_BEGIN
}

func diskMeasureSharedExtents(path string, meta diskMetadata) (int64, int64, error) {
	if meta.sharedExtentsUnmeasured {
		return 0, meta.allocatedBytes, nil
	}
	return meta.allocatedBytes, meta.allocatedBytes, nil
}

func diskShouldSkip(path string, root string, meta diskMetadata) (bool, string) {
	if meta.cloudOnly {
		return true, "cloud-only"
	}
	if meta.kind == "mount" {
		return true, "mount"
	}
	if meta.kind == "symlink" {
		return true, "reparse-point"
	}
	name := filepath.Base(path)
	if strings.EqualFold(name, "System Volume Information") || strings.EqualFold(name, "WindowsApps") {
		return true, "os_private"
	}
	if strings.EqualFold(filepath.Base(filepath.Dir(path)), "$Recycle.Bin") {
		user, err := windows.GetCurrentProcessToken().GetTokenUser()
		if err != nil || !strings.EqualFold(name, user.User.Sid.String()) {
			return true, "os_private"
		}
	}
	return false, ""
}
