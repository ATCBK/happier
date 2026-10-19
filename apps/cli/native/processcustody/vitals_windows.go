//go:build windows

package main

import (
	"encoding/binary"
	"fmt"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	procVitalsMemory                   = kernel32.NewProc("GlobalMemoryStatusEx")
	procVitalsPerformance              = syscall.NewLazyDLL("psapi.dll").NewProc("GetPerformanceInfo")
	procVitalsProcessors               = syscall.NewLazyDLL("ntdll.dll").NewProc("NtQuerySystemInformation")
	procVitalsCreateMemoryNotification = kernel32.NewProc("CreateMemoryResourceNotification")
	procVitalsQueryMemoryNotification  = kernel32.NewProc("QueryMemoryResourceNotification")
	procVitalsDrives                   = kernel32.NewProc("GetLogicalDrives")
	procVitalsDriveType                = kernel32.NewProc("GetDriveTypeW")
	procVitalsDiskFree                 = kernel32.NewProc("GetDiskFreeSpaceExW")
	procVitalsVolumeInformation        = kernel32.NewProc("GetVolumeInformationW")
	procVitalsVolumeName               = kernel32.NewProc("GetVolumeNameForVolumeMountPointW")
	procVitalsIfTable                  = syscall.NewLazyDLL("iphlpapi.dll").NewProc("GetIfTable2")
	procVitalsFreeIfTable              = syscall.NewLazyDLL("iphlpapi.dll").NewProc("FreeMibTable")
	procVitalsPower                    = kernel32.NewProc("GetSystemPowerStatus")
	procVitalsTopology                 = kernel32.NewProc("GetLogicalProcessorInformationEx")
	procVitalsActiveProcessors         = kernel32.NewProc("GetActiveProcessorCount")
)

type vitalsMemoryStatus struct {
	Length               uint32
	Load                 uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}
type vitalsPerformanceInformation struct {
	Size              uint32
	CommitTotal       uintptr
	CommitLimit       uintptr
	CommitPeak        uintptr
	PhysicalTotal     uintptr
	PhysicalAvailable uintptr
	SystemCache       uintptr
	KernelTotal       uintptr
	KernelPaged       uintptr
	KernelNonpaged    uintptr
	PageSize          uintptr
	HandleCount       uint32
	ProcessCount      uint32
	ThreadCount       uint32
}
type vitalsPowerStatus struct {
	ACLineStatus        uint8
	BatteryFlag         uint8
	BatteryLifePercent  uint8
	SystemStatusFlag    uint8
	BatteryLifeTime     uint32
	BatteryFullLifeTime uint32
}

func readNativeVitals(extras bool) (vitalsNativeSample, error) {
	s := vitalsNativeSample{}
	m := vitalsMemoryStatus{Length: uint32(unsafe.Sizeof(vitalsMemoryStatus{}))}
	if ok, _, err := procVitalsMemory.Call(uintptr(unsafe.Pointer(&m))); ok == 0 {
		return s, fmt.Errorf("GlobalMemoryStatusEx: %w", err)
	}
	s.Memory = vitalsMemory{TotalBytes: m.TotalPhys, AvailableBytes: m.AvailPhys, PressureLevel: "not_reported", PressureSource: "none"}
	p := vitalsPerformanceInformation{Size: uint32(unsafe.Sizeof(vitalsPerformanceInformation{}))}
	if ok, _, err := procVitalsPerformance.Call(uintptr(unsafe.Pointer(&p)), uintptr(p.Size)); ok == 0 {
		return s, fmt.Errorf("GetPerformanceInfo: %w", err)
	}
	page := uint64(p.PageSize)
	s.Memory.Swap = &vitalsSwap{Kind: "page_file", TotalBytes: uint64(p.CommitLimit) * page, UsedBytes: uint64(p.CommitTotal) * page}
	// Both APIs have already been read for this memory observation.
	used := m.TotalPhys - m.AvailPhys
	cached := min(used, uint64(p.SystemCache)*page)
	system := min(used-cached, uint64(p.KernelTotal)*page)
	s.Memory.Composition = []vitalsComposition{{"apps", used - cached - system}, {"system", system}, {"cached_files", cached}}
	if handle, _, _ := procVitalsCreateMemoryNotification.Call(0); handle != 0 {
		var signaled int32
		if ok, _, _ := procVitalsQueryMemoryNotification.Call(handle, uintptr(unsafe.Pointer(&signaled))); ok != 0 {
			value := signaled != 0
			s.Memory.LowMemorySignal = &value
		}
		procCloseHandle.Call(handle)
	}
	var err error
	s.CPU, err = readWindowsVitalsCPU()
	if err != nil {
		return s, err
	}
	s.Clusters = readWindowsVitalsClusters(len(s.CPU))
	s.Volumes, err = readWindowsVitalsVolumes()
	if err != nil {
		return s, err
	}
	s.Interfaces, err = readWindowsVitalsInterfaces()
	if err != nil {
		return s, err
	}
	power := vitalsPowerStatus{}
	if ok, _, _ := procVitalsPower.Call(uintptr(unsafe.Pointer(&power))); ok != 0 && power.ACLineStatus <= 1 {
		s.Power = &vitalsPower{OnAC: power.ACLineStatus == 1}
		if extras && power.BatteryFlag&128 == 0 && power.BatteryLifePercent <= 100 {
			state := "discharging"
			if power.BatteryFlag&8 != 0 {
				state = "charging"
			} else if power.ACLineStatus == 1 {
				state = "full"
			}
			s.Battery = &vitalsBattery{Pct: power.BatteryLifePercent, State: state, OnAC: power.ACLineStatus == 1}
			if power.BatteryLifeTime != 0xffffffff {
				minutes := power.BatteryLifeTime / 60
				s.Battery.MinutesToEmpty = &minutes
			}
		}
	}
	return s, nil
}

func readWindowsVitalsCPU() ([]vitalsCPU, error) {
	count, _, _ := procVitalsActiveProcessors.Call(0xffff)
	if count == 0 {
		count = uintptr(runtime.NumCPU())
	}
	// SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION is 48 bytes on supported x64.
	raw := make([]byte, int(count)*48)
	var returned uint32
	status, _, _ := procVitalsProcessors.Call(8, uintptr(unsafe.Pointer(&raw[0])), uintptr(len(raw)), uintptr(unsafe.Pointer(&returned)))
	if int32(status) < 0 || returned == 0 || int(returned) > len(raw) || returned%48 != 0 {
		return nil, fmt.Errorf("processor performance query: NTSTATUS %#x, length %d", status, returned)
	}
	result := []vitalsCPU{}
	for offset := 0; offset < int(returned); offset += 48 {
		idle := binary.LittleEndian.Uint64(raw[offset:])
		kernel := binary.LittleEndian.Uint64(raw[offset+8:])
		user := binary.LittleEndian.Uint64(raw[offset+16:])
		ticks := windowsProcessorTicks(idle, kernel, user)
		result = append(result, vitalsCPU{User: ticks["user"], System: ticks["system"], Idle: ticks["idle"]})
	}
	return result, nil
}

func readWindowsVitalsClusters(count int) []string {
	var length uint32
	procVitalsTopology.Call(0, 0, uintptr(unsafe.Pointer(&length)))
	if length == 0 {
		return nil
	}
	raw := make([]byte, length)
	if ok, _, _ := procVitalsTopology.Call(0, uintptr(unsafe.Pointer(&raw[0])), uintptr(unsafe.Pointer(&length))); ok == 0 {
		return nil
	}
	classes := make([]byte, count)
	seen := make([]bool, count)
	for offset := 0; offset+32 <= int(length); {
		size := int(binary.LittleEndian.Uint32(raw[offset+4:]))
		if size < 32 || offset+size > int(length) {
			return nil
		}
		groups := int(binary.LittleEndian.Uint16(raw[offset+30:]))
		if 32+groups*16 > size {
			return nil
		}
		for g := 0; g < groups; g++ {
			affinity := offset + 32 + g*16
			mask := binary.LittleEndian.Uint64(raw[affinity:])
			group := binary.LittleEndian.Uint16(raw[affinity+8:])
			base := 0
			for previous := uint16(0); previous < group; previous++ {
				n, _, _ := procVitalsActiveProcessors.Call(uintptr(previous))
				base += int(n)
			}
			for bit := 0; bit < 64; bit++ {
				if mask&(uint64(1)<<bit) != 0 {
					index := base + bit
					if index >= count {
						return nil
					}
					classes[index] = raw[offset+9]
					seen[index] = true
				}
			}
		}
		offset += size
	}
	lo, hi := byte(255), byte(0)
	for index, class := range classes {
		if !seen[index] {
			return nil
		}
		lo = min(lo, class)
		hi = max(hi, class)
	}
	if lo == hi {
		return nil
	}
	clusters := make([]string, count)
	for index, class := range classes {
		if class == lo {
			clusters[index] = "e"
		} else if class == hi {
			clusters[index] = "p"
		} else {
			return nil
		}
	}
	return clusters
}

func readWindowsVitalsVolumes() ([]vitalsVolume, error) {
	mask, _, err := procVitalsDrives.Call()
	if mask == 0 {
		return nil, fmt.Errorf("GetLogicalDrives: %w", err)
	}
	result := []vitalsVolume{}
	seen := make(map[string]bool)
	for letter := 0; letter < 26; letter++ {
		if mask&(1<<letter) == 0 {
			continue
		}
		mount := fmt.Sprintf("%c:\\", 'A'+letter)
		root, _ := syscall.UTF16PtrFromString(mount)
		typeID, _, _ := procVitalsDriveType.Call(uintptr(unsafe.Pointer(root)))
		if typeID != 2 && typeID != 3 {
			continue
		}
		var available, total, free uint64
		if ok, _, _ := procVitalsDiskFree.Call(uintptr(unsafe.Pointer(root)), uintptr(unsafe.Pointer(&available)), uintptr(unsafe.Pointer(&total)), uintptr(unsafe.Pointer(&free))); ok == 0 {
			continue
		}
		var label [261]uint16
		if ok, _, _ := procVitalsVolumeInformation.Call(uintptr(unsafe.Pointer(root)), uintptr(unsafe.Pointer(&label[0])), uintptr(len(label)), 0, 0, 0, 0, 0); ok == 0 {
			continue
		}
		var name [261]uint16
		if ok, _, _ := procVitalsVolumeName.Call(uintptr(unsafe.Pointer(root)), uintptr(unsafe.Pointer(&name[0])), uintptr(len(name))); ok == 0 {
			continue
		}
		id := syscall.UTF16ToString(name[:])
		if seen[id] {
			continue
		}
		seen[id] = true
		volumeLabel := syscall.UTF16ToString(label[:])
		if volumeLabel == "" {
			volumeLabel = mount
		}
		result = append(result, vitalsVolume{ID: id, Label: volumeLabel, Mount: mount, TotalBytes: total, AvailableBytes: available})
	}
	return result, nil
}

func readWindowsVitalsInterfaces() ([]vitalsInterface, error) {
	var table uintptr
	if status, _, _ := procVitalsIfTable.Call(uintptr(unsafe.Pointer(&table))); status != 0 {
		return nil, fmt.Errorf("GetIfTable2: status %d", status)
	}
	defer procVitalsFreeIfTable.Call(table)
	count := *(*uint32)(unsafe.Pointer(table))
	// MIB_IF_TABLE2 aligns its first MIB_IF_ROW2 to an eight-byte boundary.
	rows := unsafe.Slice((*windows.MibIfRow2)(unsafe.Pointer(table+8)), count)
	result := []vitalsInterface{}
	for _, row := range rows {
		name := syscall.UTF16ToString(row.Alias[:])
		result = append(result, vitalsInterface{ID: fmt.Sprintf("%d", row.InterfaceLuid), Name: name, RxBytes: row.InOctets, TxBytes: row.OutOctets,
			Included: row.Type != 24 && row.Type != 131 && row.InterfaceAndOperStatusFlags&1 != 0 && includeVitalsInterface(name)})
	}
	return result, nil
}
