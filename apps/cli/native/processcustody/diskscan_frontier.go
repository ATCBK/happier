package main

import (
	"encoding/binary"
	"encoding/json"
	"io"
	"os"
)

// Discovery order is parent-before-child. Reverse iteration gives a bounded
// terminal postorder without sorting/retaining all completed directory headers.
type diskPathSpool struct {
	file *os.File
	end  int64
}

func diskNewPathSpool(directory, name string) (*diskPathSpool, error) {
	file, err := diskScratchFile(directory, name)
	if err != nil {
		return nil, err
	}
	return &diskPathSpool{file: file}, nil
}
func (spool *diskPathSpool) append(path string) error {
	data := make([]byte, len(path)+8)
	binary.LittleEndian.PutUint32(data[:4], uint32(len(path)))
	copy(data[4:], path)
	binary.LittleEndian.PutUint32(data[len(data)-4:], uint32(len(path)))
	if _, err := spool.file.WriteAt(data, spool.end); err != nil {
		return err
	}
	spool.end += int64(len(data))
	return nil
}
func (spool *diskPathSpool) visit(reverse bool, visit func(string) error) error {
	var size [4]byte
	if reverse {
		for offset := spool.end; offset > 0; {
			if _, err := spool.file.ReadAt(size[:], offset-4); err != nil {
				return err
			}
			length := int64(binary.LittleEndian.Uint32(size[:]))
			data := make([]byte, length)
			if _, err := spool.file.ReadAt(data, offset-length-4); err != nil {
				return err
			}
			offset -= length + 8
			if err := visit(string(data)); err != nil {
				return err
			}
		}
	} else {
		for offset := int64(0); offset < spool.end; {
			if _, err := spool.file.ReadAt(size[:], offset); err != nil {
				return err
			}
			length := int64(binary.LittleEndian.Uint32(size[:]))
			data := make([]byte, length)
			if _, err := spool.file.ReadAt(data, offset+4); err != nil {
				return err
			}
			offset += length + 8
			if err := visit(string(data)); err != nil {
				return err
			}
		}
	}
	return nil
}
func (spool *diskPathSpool) close() { spool.file.Close() }

type diskQueuedPath struct {
	Path     string
	Tier     int
	Priority int64
}
type diskFrontierSpool struct {
	slots, records *os.File
	count          uint64
	end            int64
}

func diskNewFrontierSpool(directory string) (*diskFrontierSpool, error) {
	slots, err := diskScratchFile(directory, "frontier-slots")
	if err != nil {
		return nil, err
	}
	records, err := diskScratchFile(directory, "frontier-records")
	if err != nil {
		slots.Close()
		return nil, err
	}
	return &diskFrontierSpool{slots: slots, records: records}, nil
}
func (spool *diskFrontierSpool) close() { spool.slots.Close(); spool.records.Close() }
func (spool *diskFrontierSpool) read(offset uint64) (diskQueuedPath, error) {
	var length [4]byte
	if _, err := spool.records.ReadAt(length[:], int64(offset)); err != nil {
		return diskQueuedPath{}, err
	}
	data := make([]byte, int(binary.LittleEndian.Uint32(length[:])))
	if _, err := spool.records.ReadAt(data, int64(offset)+4); err != nil {
		return diskQueuedPath{}, err
	}
	var record diskQueuedPath
	err := json.Unmarshal(data, &record)
	return record, err
}
func (spool *diskFrontierSpool) less(left, right uint64) (bool, error) {
	a, err := spool.read(left)
	if err != nil {
		return false, err
	}
	b, err := spool.read(right)
	if err != nil {
		return false, err
	}
	if a.Tier != b.Tier {
		return a.Tier < b.Tier, nil
	}
	if a.Priority != b.Priority {
		return a.Priority < b.Priority, nil
	}
	// Path IDs can encode invalid UTF-8. Ownership/ordering compares raw bytes,
	// not base64 text; this is the same lexical rule as physical allocation.
	x, err := diskPathFromID(a.Path)
	if err != nil {
		return false, err
	}
	y, err := diskPathFromID(b.Path)
	return x < y, err
}
func (spool *diskFrontierSpool) push(record diskQueuedPath) error {
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	var length [4]byte
	binary.LittleEndian.PutUint32(length[:], uint32(len(data)))
	position := uint64(spool.end)
	if _, err = spool.records.WriteAt(length[:], spool.end); err != nil {
		return err
	}
	if _, err = spool.records.WriteAt(data, spool.end+4); err != nil {
		return err
	}
	spool.end += int64(len(data) + 4)
	slot := spool.count
	spool.count++
	if err = spool.slots.Truncate(int64(spool.count * 8)); err != nil {
		return err
	}
	for slot > 0 {
		parent := (slot - 1) / 2
		existing, err := diskSlot(spool.slots, parent)
		if err != nil {
			return err
		}
		less, err := spool.less(position, existing)
		if err != nil {
			return err
		}
		if !less {
			break
		}
		if err = diskSetSlot(spool.slots, slot, existing); err != nil {
			return err
		}
		slot = parent
	}
	return diskSetSlot(spool.slots, slot, position)
}
func (spool *diskFrontierSpool) pop() (diskQueuedPath, error) {
	if spool.count == 0 {
		return diskQueuedPath{}, io.EOF
	}
	offset, err := diskSlot(spool.slots, 0)
	if err != nil {
		return diskQueuedPath{}, err
	}
	record, err := spool.read(offset)
	if err != nil {
		return record, err
	}
	spool.count--
	if spool.count == 0 {
		return record, nil
	}
	last, err := diskSlot(spool.slots, spool.count)
	if err != nil {
		return record, err
	}
	slot := uint64(0)
	for {
		child := slot*2 + 1
		if child >= spool.count {
			break
		}
		left, err := diskSlot(spool.slots, child)
		if err != nil {
			return record, err
		}
		if child+1 < spool.count {
			right, err := diskSlot(spool.slots, child+1)
			if err != nil {
				return record, err
			}
			less, err := spool.less(right, left)
			if err != nil {
				return record, err
			}
			if less {
				child++
				left = right
			}
		}
		less, err := spool.less(left, last)
		if err != nil {
			return record, err
		}
		if !less {
			break
		}
		if err = diskSetSlot(spool.slots, slot, left); err != nil {
			return record, err
		}
		slot = child
	}
	return record, diskSetSlot(spool.slots, slot, last)
}

type diskStoredDirectory struct {
	Record                               diskDirRecord
	Facts                                []diskAllocationFact
	Identity, Device, Kind, AtomicParent string
	SelfAllocated                        int64
	RangeHead, RangeTail                 int64
	Pending                              int
	EnumerationDone, Published           bool
	EnumerationError                     bool
}
type diskDirectorySpool struct {
	headers *diskWinnerSpool
	ranges  *os.File
	end     int64
}

func diskNewDirectorySpool(directory string) (*diskDirectorySpool, error) {
	headers, err := diskNewWinnerSpool(directory, "directory-headers")
	if err != nil {
		return nil, err
	}
	ranges, err := diskScratchFile(directory, "directory-ranges")
	if err != nil {
		headers.close()
		return nil, err
	}
	return &diskDirectorySpool{headers: headers, ranges: ranges, end: 1}, nil
}
func (spool *diskDirectorySpool) close() { spool.headers.close(); spool.ranges.Close() }
func (spool *diskDirectorySpool) set(directory *diskStreamDirectory) error {
	record := directory.record
	stored := diskStoredDirectory{Record: record, Facts: directory.facts, Identity: record.meta.identity, Device: record.meta.device, Kind: record.meta.kind, AtomicParent: diskPathID(record.atomicParent), SelfAllocated: record.meta.allocatedBytes, RangeHead: directory.rangeHead, RangeTail: directory.rangeTail, Pending: directory.pending, EnumerationDone: directory.enumerationDone, Published: directory.published, EnumerationError: directory.enumerationError}
	data, err := json.Marshal(stored)
	if err != nil {
		return err
	}
	return spool.headers.set(record.rawPath, string(data))
}
func (spool *diskDirectorySpool) get(path string) (*diskStreamDirectory, error) {
	data, found, err := spool.headers.get(path)
	if err != nil || !found {
		return nil, err
	}
	var stored diskStoredDirectory
	if err = json.Unmarshal([]byte(data), &stored); err != nil {
		return nil, err
	}
	stored.Record.rawPath = path
	stored.Record.atomicParent, err = diskPathFromID(stored.AtomicParent)
	if err != nil {
		return nil, err
	}
	stored.Record.meta = diskMetadata{identity: stored.Identity, device: stored.Device, kind: stored.Kind, allocatedBytes: stored.SelfAllocated, logicalBytes: stored.Record.OwnLogicalBytes}
	return &diskStreamDirectory{record: stored.Record, facts: stored.Facts, rangeHead: stored.RangeHead, rangeTail: stored.RangeTail, pending: stored.Pending, enumerationDone: stored.EnumerationDone, published: stored.Published, enumerationError: stored.EnumerationError}, nil
}
func (spool *diskDirectorySpool) appendRange(directory *diskStreamDirectory, span diskSpoolRange) error {
	if span.end == span.start {
		return nil
	}
	var data [24]byte
	binary.LittleEndian.PutUint64(data[8:16], uint64(span.start))
	binary.LittleEndian.PutUint64(data[16:24], uint64(span.end))
	offset := spool.end
	if _, err := spool.ranges.WriteAt(data[:], offset); err != nil {
		return err
	}
	spool.end += 24
	if directory.rangeTail != 0 {
		var next [8]byte
		binary.LittleEndian.PutUint64(next[:], uint64(offset))
		if _, err := spool.ranges.WriteAt(next[:], directory.rangeTail); err != nil {
			return err
		}
	} else {
		directory.rangeHead = offset
	}
	directory.rangeTail = offset
	return nil
}
func (spool *diskDirectorySpool) visit(entries *diskEntrySpool, directory *diskStreamDirectory, visit func(diskNode) error) error {
	for offset := directory.rangeHead; offset != 0; {
		var data [24]byte
		if _, err := spool.ranges.ReadAt(data[:], offset); err != nil {
			return err
		}
		span := diskSpoolRange{int64(binary.LittleEndian.Uint64(data[8:16])), int64(binary.LittleEndian.Uint64(data[16:24]))}
		if err := entries.visit([]diskSpoolRange{span}, visit); err != nil {
			return err
		}
		offset = int64(binary.LittleEndian.Uint64(data[:8]))
	}
	return nil
}
