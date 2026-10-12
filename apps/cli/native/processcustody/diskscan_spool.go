package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// These files are invocation-local scratch, not an index. The process host owns
// their directory and removes it after actual child close, including SIGKILL.
// Hashes select a slot only: full keys are always compared, so collisions cannot
// lose a physical component or change deterministic raw-byte lexical ownership.
type diskWinnerSpool struct {
	directory       string
	table, records  *os.File
	capacity, count uint64
	end             int64
	prefix          string
}
type diskWinner struct {
	Key, Path string
	Bytes     int64
}

func diskScratchFile(directory, name string) (*os.File, error) {
	return os.OpenFile(filepath.Join(directory, name), os.O_RDWR|os.O_CREATE|os.O_EXCL, 0600)
}
func diskNewWinnerSpool(directory string, names ...string) (*diskWinnerSpool, error) {
	prefix := "allocation"
	if len(names) > 0 {
		prefix = names[0]
	}
	records, err := diskScratchFile(directory, prefix+"-records")
	if err != nil {
		return nil, err
	}
	spool := &diskWinnerSpool{directory: directory, records: records, end: 1, prefix: prefix}
	if err = spool.grow(); err != nil {
		records.Close()
		return nil, err
	}
	return spool, nil
}
func diskKeyHash(key string) uint64 {
	var value uint64 = 14695981039346656037
	for i := 0; i < len(key); i++ {
		value ^= uint64(key[i])
		value *= 1099511628211
	}
	return value
}
func (spool *diskWinnerSpool) close() { spool.table.Close(); spool.records.Close() }
func diskSlot(file *os.File, slot uint64) (uint64, error) {
	var data [8]byte
	_, err := file.ReadAt(data[:], int64(slot*8))
	return binary.LittleEndian.Uint64(data[:]), err
}
func diskSetSlot(file *os.File, slot, value uint64) error {
	var data [8]byte
	binary.LittleEndian.PutUint64(data[:], value)
	_, err := file.WriteAt(data[:], int64(slot*8))
	return err
}
func (spool *diskWinnerSpool) read(offset uint64) (diskWinner, error) {
	var header [16]byte
	if _, err := spool.records.ReadAt(header[:], int64(offset)); err != nil {
		return diskWinner{}, err
	}
	keySize, pathSize := int(binary.LittleEndian.Uint32(header[:4])), int(binary.LittleEndian.Uint32(header[4:8]))
	data := make([]byte, keySize+pathSize)
	if _, err := spool.records.ReadAt(data, int64(offset)+16); err != nil {
		return diskWinner{}, err
	}
	return diskWinner{string(data[:keySize]), string(data[keySize:]), int64(binary.LittleEndian.Uint64(header[8:]))}, nil
}
func (spool *diskWinnerSpool) append(winner diskWinner) (uint64, error) {
	data := make([]byte, 16+len(winner.Key)+len(winner.Path))
	binary.LittleEndian.PutUint32(data[:4], uint32(len(winner.Key)))
	binary.LittleEndian.PutUint32(data[4:8], uint32(len(winner.Path)))
	binary.LittleEndian.PutUint64(data[8:16], uint64(winner.Bytes))
	copy(data[16:], winner.Key)
	copy(data[16+len(winner.Key):], winner.Path)
	offset := spool.end
	_, err := spool.records.WriteAt(data, offset)
	if err != nil {
		return 0, err
	}
	spool.end += int64(len(data))
	return uint64(offset), nil
}
func (spool *diskWinnerSpool) find(key string) (uint64, uint64, diskWinner, error) {
	slot := diskKeyHash(key) & (spool.capacity - 1)
	for {
		offset, err := diskSlot(spool.table, slot)
		if err != nil {
			return 0, 0, diskWinner{}, err
		}
		if offset == 0 {
			return slot, 0, diskWinner{}, nil
		}
		winner, err := spool.read(offset)
		if err != nil {
			return 0, 0, diskWinner{}, err
		}
		if winner.Key == key {
			return slot, offset, winner, nil
		}
		slot = (slot + 1) & (spool.capacity - 1)
	}
}
func (spool *diskWinnerSpool) grow() error {
	capacity := spool.capacity * 2
	if capacity == 0 {
		capacity = 1024
	}
	file, err := diskScratchFile(spool.directory, fmt.Sprintf("%s-slots-%d", spool.prefix, capacity))
	if err != nil {
		return err
	}
	if err = file.Truncate(int64(capacity * 8)); err != nil {
		file.Close()
		return err
	}
	if spool.table != nil {
		for slot := uint64(0); slot < spool.capacity; slot++ {
			offset, err := diskSlot(spool.table, slot)
			if err != nil {
				file.Close()
				return err
			}
			if offset == 0 {
				continue
			}
			winner, err := spool.read(offset)
			if err != nil {
				file.Close()
				return err
			}
			destination := diskKeyHash(winner.Key) & (capacity - 1)
			for {
				existing, err := diskSlot(file, destination)
				if err != nil {
					file.Close()
					return err
				}
				if existing == 0 {
					break
				}
				destination = (destination + 1) & (capacity - 1)
			}
			if err = diskSetSlot(file, destination, offset); err != nil {
				file.Close()
				return err
			}
		}
		spool.table.Close()
	}
	spool.table, spool.capacity = file, capacity
	return nil
}

// observe returns whether this is a new component and the change to union size.
func (spool *diskWinnerSpool) observe(key, path string, bytes int64) (bool, int64, error) {
	if (spool.count+1)*4 >= spool.capacity*3 {
		if err := spool.grow(); err != nil {
			return false, 0, err
		}
	}
	slot, offset, winner, err := spool.find(key)
	if err != nil {
		return false, 0, err
	}
	if offset != 0 && path >= winner.Path {
		return false, 0, nil
	}
	newOffset, err := spool.append(diskWinner{key, path, bytes})
	if err != nil {
		return false, 0, err
	}
	if err = diskSetSlot(spool.table, slot, newOffset); err != nil {
		return false, 0, err
	}
	if offset == 0 {
		spool.count++
		return true, bytes, nil
	}
	return false, bytes - winner.Bytes, nil
}
func (spool *diskWinnerSpool) owns(fact diskAllocationFact, path string) (bool, error) {
	_, offset, winner, err := spool.find(fact.Key)
	return offset == 0 || winner.Path == path, err
}
func (spool *diskWinnerSpool) get(key string) (string, bool, error) {
	_, offset, record, err := spool.find(key)
	return record.Path, offset != 0, err
}
func (spool *diskWinnerSpool) set(key, value string) error {
	if (spool.count+1)*4 >= spool.capacity*3 {
		if err := spool.grow(); err != nil {
			return err
		}
	}
	slot, old, _, err := spool.find(key)
	if err != nil {
		return err
	}
	offset, err := spool.append(diskWinner{Key: key, Path: value})
	if err != nil {
		return err
	}
	if old == 0 {
		spool.count++
	}
	return diskSetSlot(spool.table, slot, offset)
}

type diskSpoolRange struct{ start, end int64 }
type diskStoredNode struct {
	Node     diskNode         `json:"node"`
	Retained *diskStoredPrior `json:"retained,omitempty"`
}
type diskStoredPrior struct {
	AllocatedBytes, LogicalBytes, Items int64
	Flags                               diskFlags
	AgeGroups                           diskAgeGroups
}
type diskEntrySpool struct {
	file   *os.File
	writer *bufio.Writer
	end    int64
}

func diskNewEntrySpool(directory string) (*diskEntrySpool, error) {
	file, err := diskScratchFile(directory, "directory-entries")
	if err != nil {
		return nil, err
	}
	return &diskEntrySpool{file: file, writer: bufio.NewWriterSize(file, 64*1024)}, nil
}
func (spool *diskEntrySpool) append(node diskNode) error {
	stored := diskStoredNode{Node: node}
	if prior := node.retained; prior != nil {
		stored.Retained = &diskStoredPrior{prior.allocatedBytes, prior.logicalBytes, prior.items, prior.flags, prior.ageGroups}
	}
	data, err := json.Marshal(stored)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if _, err = spool.writer.Write(data); err != nil {
		return err
	}
	spool.end += int64(len(data))
	return nil
}
func (spool *diskEntrySpool) visit(ranges []diskSpoolRange, visit func(diskNode) error) error {
	if err := spool.writer.Flush(); err != nil {
		return err
	}
	for _, span := range ranges {
		decoder := json.NewDecoder(io.NewSectionReader(spool.file, span.start, span.end-span.start))
		for {
			var stored diskStoredNode
			if err := decoder.Decode(&stored); errors.Is(err, io.EOF) {
				break
			} else if err != nil {
				return err
			}
			path, err := diskPathFromID(stored.Node.ID)
			if err != nil {
				return err
			}
			stored.Node.rawPath = path
			if prior := stored.Retained; prior != nil {
				stored.Node.retained = &diskPriorChild{allocatedBytes: prior.AllocatedBytes, logicalBytes: prior.LogicalBytes, items: prior.Items, flags: prior.Flags, ageGroups: prior.AgeGroups}
			}
			if err = visit(stored.Node); err != nil {
				return err
			}
		}
	}
	return nil
}
func (spool *diskEntrySpool) close() { spool.writer.Flush(); spool.file.Close() }
