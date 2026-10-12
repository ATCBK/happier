//go:build windows

package main

import (
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"os"
	"strings"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

func censusWindowsOwnerJobName(tag string) string {
	return `Local\happier-owner-` + base64.RawURLEncoding.EncodeToString([]byte(tag))
}

func readCensusWindowsMemory(handle windows.Handle, address uintptr, size int) ([]byte, error) {
	if address == 0 || size <= 0 || uintptr(size) > ^uintptr(0)-address {
		return nil, fmt.Errorf("invalid remote memory range")
	}
	buffer := make([]byte, size)
	var read uintptr
	if err := windows.ReadProcessMemory(handle, address, &buffer[0], uintptr(size), &read); err != nil {
		return nil, err
	}
	if read != uintptr(size) {
		return nil, fmt.Errorf("short remote memory read")
	}
	return buffer, nil
}

func readCensusWindowsPointer(handle windows.Handle, address uintptr, width int) (uintptr, error) {
	buffer, err := readCensusWindowsMemory(handle, address, width)
	if err != nil {
		return 0, err
	}
	if width == 4 {
		return uintptr(binary.LittleEndian.Uint32(buffer)), nil
	}
	if width == 8 {
		return uintptr(binary.LittleEndian.Uint64(buffer)), nil
	}
	return 0, fmt.Errorf("unsupported process pointer width")
}

// PEB ProcessParameters is the documented winternl 32/64-bit field. The
// RTL_USER_PROCESS_PARAMETERS Environment pointer follows CommandLine:
// phnt/include/ntrtl.h inspected 2026-10-10, Windows 10.0.26200 native probes.
// https://learn.microsoft.com/en-us/windows/win32/api/winternl/ns-winternl-peb
// https://github.com/winsiderss/systeminformer/blob/master/phnt/include/ntrtl.h
// No remote pointer is dereferenced locally. Unsupported/unreadable/racing
// layouts are missing evidence, never an empty marker or a different principal.
func censusWindowsEnvironment(pid int, principal *censusPrincipal) (string, map[string]string, error) {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_INFORMATION|windows.PROCESS_VM_READ, false, uint32(pid))
	if err != nil {
		return "", nil, err
	}
	defer windows.CloseHandle(handle)
	actual, err := censusWindowsPrincipal(handle)
	own, ownErr := censusWindowsPrincipal(windows.CurrentProcess())
	if err != nil || ownErr != nil || actual == nil || principal == nil || own == nil || actual.Value != own.Value || actual.Value != principal.Value {
		return "", nil, fmt.Errorf("environment principal is not the current principal")
	}
	width := int(unsafe.Sizeof(uintptr(0)))
	if width == 4 {
		var ownWOW64, targetWOW64 bool
		if err := windows.IsWow64Process(windows.CurrentProcess(), &ownWOW64); err != nil {
			return "", nil, err
		}
		if err := windows.IsWow64Process(handle, &targetWOW64); err != nil {
			return "", nil, err
		}
		if ownWOW64 && !targetWOW64 {
			return "", nil, fmt.Errorf("32-bit reader cannot inspect 64-bit environment")
		}
	}
	var information windows.PROCESS_BASIC_INFORMATION
	if err := windows.NtQueryInformationProcess(handle, 0, unsafe.Pointer(&information), uint32(unsafe.Sizeof(information)), nil); err != nil {
		return "", nil, err
	}
	peb := uintptr(unsafe.Pointer(information.PebBaseAddress))
	if width == 8 {
		var wow64 uintptr
		if err := windows.NtQueryInformationProcess(handle, 26, unsafe.Pointer(&wow64), uint32(unsafe.Sizeof(wow64)), nil); err != nil {
			return "", nil, err
		}
		if wow64 != 0 {
			peb, width = wow64, 4
		}
	}
	parametersOffset, environmentOffset := uintptr(0x20), uintptr(0x80)
	if width == 4 {
		parametersOffset, environmentOffset = 0x10, 0x48
	}
	if peb == 0 || peb > ^uintptr(0)-parametersOffset {
		return "", nil, fmt.Errorf("invalid PEB address")
	}
	parameters, err := readCensusWindowsPointer(handle, peb+parametersOffset, width)
	if err != nil || parameters == 0 || parameters > ^uintptr(0)-environmentOffset {
		return "", nil, fmt.Errorf("process parameters unavailable")
	}
	// Live user processes normalize these pointers to absolute addresses.
	flags, err := readCensusWindowsMemory(handle, parameters+8, 4)
	if err != nil || binary.LittleEndian.Uint32(flags)&1 == 0 {
		return "", nil, fmt.Errorf("process parameters not normalized")
	}
	environment, err := readCensusWindowsPointer(handle, parameters+environmentOffset, width)
	if err != nil || environment == 0 || environment%2 != 0 {
		return "", nil, fmt.Errorf("environment unavailable")
	}
	var region windows.MemoryBasicInformation
	if err := windows.VirtualQueryEx(handle, environment, &region, unsafe.Sizeof(region)); err != nil {
		return "", nil, err
	}
	allocation := region.AllocationBase
	address := environment
	entry := make([]uint16, 0)
	values := make(map[string]string)
	var tag string
	previousNull := false
	for {
		if err := windows.VirtualQueryEx(handle, address, &region, unsafe.Sizeof(region)); err != nil {
			return "", nil, err
		}
		if region.AllocationBase != allocation || region.State != windows.MEM_COMMIT || region.Protect&(windows.PAGE_NOACCESS|windows.PAGE_GUARD) != 0 || region.RegionSize > ^uintptr(0)-region.BaseAddress {
			return "", nil, fmt.Errorf("environment left its readable allocation")
		}
		end := region.BaseAddress + region.RegionSize
		if address < region.BaseAddress || address >= end {
			return "", nil, fmt.Errorf("invalid environment region")
		}
		// Read at most the current OS page, and stop at the UTF-16 double-NUL.
		// The bound comes from the memory owner, not an environment-size cap.
		page := uintptr(os.Getpagesize())
		size := page - address%page
		if end-address < size {
			size = end - address
		}
		if size < 2 || size%2 != 0 {
			return "", nil, fmt.Errorf("unaligned environment region")
		}
		buffer, err := readCensusWindowsMemory(handle, address, int(size))
		if err != nil {
			return "", nil, err
		}
		for i := 0; i < len(buffer); i += 2 {
			unit := binary.LittleEndian.Uint16(buffer[i:])
			if unit != 0 {
				entry = append(entry, unit)
				previousNull = false
				continue
			}
			if previousNull {
				current, err := readCensusWindowsPointer(handle, parameters+environmentOffset, width)
				if err != nil || current != environment {
					return "", nil, fmt.Errorf("environment changed during read")
				}
				return tag, values, nil
			}
			key, value, found := strings.Cut(string(utf16.Decode(entry)), "=")
			key = strings.ToUpper(key)
			if found {
				if key == "HAPPIER_PROCESS_OWNER" {
					tag = value
				} else if censusOwnershipEnvironmentKey(key) {
					values[key] = value
				}
			}
			entry = entry[:0]
			previousNull = true
		}
		if size > ^uintptr(0)-address {
			return "", nil, fmt.Errorf("environment address overflow")
		}
		address += size
	}
}
