//go:build windows

package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

var censusGetProcessMemoryInfo = kernel32.NewProc("K32GetProcessMemoryInfo")

// PROCESS_MEMORY_COUNTERS_EX: PrivateUsage is the last SIZE_T field.
// https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters_ex
type censusWindowsMemoryCounters struct {
	Cb, PageFaultCount                                                                                 uint32
	PeakWorkingSetSize, WorkingSetSize, QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage                   uintptr
	QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage, PagefileUsage, PeakPagefileUsage, PrivateUsage uintptr
}

func censusWindowsFiletime(value windows.Filetime) uint64 {
	return uint64(value.HighDateTime)<<32 | uint64(value.LowDateTime)
}

func censusWindowsStart(value windows.Filetime) (censusStart, error) {
	const windowsEpoch = 116_444_736_000_000_000
	ticks := censusWindowsFiletime(value)
	if ticks <= windowsEpoch {
		return censusStart{}, fmt.Errorf("invalid process creation FILETIME")
	}
	return censusStart{StartTimeMs: int64((ticks - windowsEpoch) / 10000)}, nil
}

func censusWindowsPrincipal(handle windows.Handle) (*censusPrincipal, error) {
	var token windows.Token
	if err := windows.OpenProcessToken(handle, windows.TOKEN_QUERY, &token); err != nil {
		return nil, err
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return nil, err
	}
	return &censusPrincipal{Kind: "sid", Value: user.User.Sid.String()}, nil
}

func censusWindowsExecutable(handle windows.Handle) (string, error) {
	size := uint32(windows.MAX_PATH)
	for {
		buffer := make([]uint16, size)
		n := size
		err := windows.QueryFullProcessImageName(handle, 0, &buffer[0], &n)
		if err == nil {
			return windows.UTF16ToString(buffer[:n]), nil
		}
		if !errors.Is(err, windows.ERROR_INSUFFICIENT_BUFFER) {
			return "", err
		}
		size *= 2
	}
}

type censusWindowsUnicodeString struct {
	Length, MaximumLength uint16
	Buffer                *uint16
}

func censusWindowsCommandLine(handle windows.Handle) (string, []string, error) {
	// ProcessCommandLineInformation (60) returns a local UNICODE_STRING
	// followed by the exact command line, without remote PEB dereferences.
	var required uint32
	err := windows.NtQueryInformationProcess(handle, 60, nil, 0, &required)
	if required < uint32(unsafe.Sizeof(censusWindowsUnicodeString{})) {
		return "", nil, fmt.Errorf("command-line size query: %w", err)
	}
	for {
		buffer := make([]byte, required)
		err = windows.NtQueryInformationProcess(handle, 60, unsafe.Pointer(&buffer[0]), uint32(len(buffer)), &required)
		if errors.Is(err, windows.STATUS_INFO_LENGTH_MISMATCH) || errors.Is(err, windows.STATUS_BUFFER_TOO_SMALL) {
			continue
		}
		if err != nil {
			return "", nil, err
		}
		header := *(*censusWindowsUnicodeString)(unsafe.Pointer(&buffer[0]))
		base, pointer := uintptr(unsafe.Pointer(&buffer[0])), uintptr(unsafe.Pointer(header.Buffer))
		if header.Length%2 != 0 || header.Length > header.MaximumLength || pointer < base || pointer-base > uintptr(len(buffer)) || uintptr(header.Length) > uintptr(len(buffer))-(pointer-base) {
			return "", nil, fmt.Errorf("invalid command-line UNICODE_STRING")
		}
		units := make([]uint16, int(header.Length)/2)
		start := int(pointer - base)
		for i := range units {
			units[i] = binary.LittleEndian.Uint16(buffer[start+i*2:])
		}
		commandLine := windows.UTF16ToString(units)
		argv, err := windows.DecomposeCommandLine(commandLine)
		return commandLine, argv, err
	}
}

func censusWindowsToolhelpRow(entry windows.ProcessEntry32) censusRow {
	ppid := int(entry.ParentProcessID)
	return censusRow{Pid: int(entry.ProcessID), Ppid: &ppid, Name: windows.UTF16ToString(entry.ExeFile[:])}
}

func censusWindowsJobNames(rows []censusRow) []string {
	names := make(map[string]bool)
	for _, row := range rows {
		if row.OwnerTag != "" {
			names[censusWindowsOwnerJobName(row.OwnerTag)] = true
		}
		if !strings.EqualFold(filepath.Base(row.ExecutablePath), "happier-process-custody.exe") && !strings.EqualFold(row.Name, "happier-process-custody.exe") {
			continue
		}
		if len(row.Argv) < 2 || row.Argv[1] != "run" {
			continue
		}
		for _, arg := range row.Argv[2:] {
			if arg == "--" {
				break
			}
			if name, ok := strings.CutPrefix(arg, "--job="); ok && name != "" {
				names[name] = true
			}
		}
	}
	result := make([]string, 0, len(names))
	for name := range names {
		result = append(result, name)
	}
	sort.Strings(result)
	return result
}

func censusWindowsJobPids(job uintptr) ([]int, error) {
	// The kernel returns assigned/list counts even when the process list grew.
	// Grow to the reported count until complete; never truncate membership.
	width := int(unsafe.Sizeof(uintptr(0)))
	buffer := make([]byte, 8+width)
	for {
		var returned uint32
		ok, _, err := procQueryInformationJobObject.Call(job, 3, uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)), uintptr(unsafe.Pointer(&returned)))
		assigned, listed := int(binary.LittleEndian.Uint32(buffer)), int(binary.LittleEndian.Uint32(buffer[4:]))
		if ok == 0 && !errors.Is(err, windows.ERROR_MORE_DATA) {
			return nil, err
		}
		if listed < assigned || 8+listed*width > len(buffer) {
			buffer = make([]byte, 8+assigned*width)
			continue
		}
		result := make([]int, 0, listed)
		for i := 0; i < listed; i++ {
			var pid uint64
			if width == 8 {
				pid = binary.LittleEndian.Uint64(buffer[8+i*width:])
			} else {
				pid = uint64(binary.LittleEndian.Uint32(buffer[8+i*width:]))
			}
			result = append(result, int(pid))
		}
		return result, nil
	}
}

func readNativeProcessCensus(opts censusOptions) (censusSnapshot, error) {
	snapshot := newCensusSnapshot()
	own, err := censusWindowsPrincipal(windows.CurrentProcess())
	if err != nil {
		return snapshot, err
	}
	// A verified incumbent name need not have a resident helper or an owner
	// marker carrier. Observe its kernel PID list through this same census and
	// enrich every listed identity, including members outside a PID filter.
	explicit := make(map[string]censusJobObservation)
	for _, name := range opts.JobNames {
		observation := censusWindowsObserveJob(name)
		explicit[name] = observation
		snapshot.JobObservations = append(snapshot.JobObservations, observation)
		if opts.Pids != nil && observation.State == "live" {
			for _, pid := range observation.Pids {
				opts.Pids[pid] = true
			}
		}
	}
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return snapshot, err
	}
	defer windows.CloseHandle(snap)
	var entry windows.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	err = windows.Process32First(snap, &entry)
	entries := make([]windows.ProcessEntry32, 0)
	parents := make(map[int]int)
	for err == nil {
		entries = append(entries, entry)
		parents[int(entry.ProcessID)] = int(entry.ParentProcessID)
		err = windows.Process32Next(snap, &entry)
	}
	if !errors.Is(err, windows.ERROR_NO_MORE_FILES) {
		return snapshot, err
	}
	includeCensusAncestors(opts, parents)
	// A full census discovers resident custody helpers outside a PID filter.
	// Restricted field reads observe only explicitly requested Jobs.
	discoverJobs := !opts.IdentityOnly && opts.Fields == nil
	jobCarriers := make([]censusRow, 0)
	for _, entry := range entries {
		row := censusWindowsToolhelpRow(entry)
		selected := row.Pid > 0 && censusWantsPid(opts, row.Pid)
		carrier := discoverJobs && strings.EqualFold(row.Name, "happier-process-custody.exe")
		if selected || carrier {
			handle, openErr := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(row.Pid))
			if openErr != nil {
				if selected && !errors.Is(openErr, windows.ERROR_INVALID_PARAMETER) {
					missing := []string{"start", "principal"}
					for _, field := range []string{"memory", "cpuTimeUs"} {
						if opts.wants(field) {
							missing = append(missing, field)
						}
					}
					snapshot.Partial = append(snapshot.Partial, censusPartial{Pid: row.Pid, Missing: missing})
				}
			} else {
				missing := make([]string, 0)
				var creation, exit, kernel, user windows.Filetime
				timesErr := windows.GetProcessTimes(handle, &creation, &exit, &kernel, &user)
				row.Start, err = censusWindowsStart(creation)
				if timesErr != nil || err != nil {
					if selected {
						missing := []string{"start"}
						if opts.wants("cpuTimeUs") {
							missing = append(missing, "cpuTimeUs")
						}
						snapshot.Partial = append(snapshot.Partial, censusPartial{Pid: row.Pid, Missing: missing})
					}
				} else if censusWindowsFiletime(exit) == 0 {
					row.Principal, _ = censusWindowsPrincipal(handle)
					isOwn := row.Principal != nil && row.Principal.Value == own.Value
					if row.Principal == nil {
						missing = append(missing, "principal")
					}
					if opts.Scope == "all" || isOwn || row.Principal == nil {
						if opts.IdentityOnly {
							snapshot.Rows = append(snapshot.Rows, row)
							if len(missing) > 0 {
								snapshot.Partial = append(snapshot.Partial, censusPartial{Pid: row.Pid, Missing: missing})
							}
							windows.CloseHandle(handle)
							continue
						}
						if opts.wants("cpuTimeUs") {
							cpu, cpuErr := censusMicroseconds(censusWindowsFiletime(user), censusWindowsFiletime(kernel), 10)
							if cpuErr == nil {
								row.CpuTimeUs = &cpu
							} else {
								missing = append(missing, "cpuTimeUs")
							}
						}
						if opts.wants("memory") {
							var memory censusWindowsMemoryCounters
							memory.Cb = uint32(unsafe.Sizeof(memory))
							if ok, _, _ := censusGetProcessMemoryInfo.Call(uintptr(handle), uintptr(unsafe.Pointer(&memory)), uintptr(memory.Cb)); ok != 0 {
								row.Memory = &censusMemory{Bytes: uint64(memory.PrivateUsage), Kind: "private"}
							} else {
								missing = append(missing, "memory")
							}
						}
						if isOwn {
							if opts.wants("executablePath") {
								row.ExecutablePath, err = censusWindowsExecutable(handle)
								if err != nil {
									missing = append(missing, "executablePath")
								}
							}
							if opts.wants("argv") {
								row.CommandLine, row.Argv, err = censusWindowsCommandLine(handle)
								if err != nil {
									missing = append(missing, "argv", "commandLine")
								}
							}
							if opts.wants("ownershipEnvironment") {
								row.OwnerTag, row.OwnershipEnvironment, err = censusWindowsEnvironment(row.Pid, row.Principal)
								if err != nil {
									missing = append(missing, "ownerTag", "ownershipEnvironment")
								}
							}
							if carrier {
								jobCarriers = append(jobCarriers, row)
							}
						}
						if selected {
							snapshot.Rows = append(snapshot.Rows, row)
							if len(missing) > 0 {
								snapshot.Partial = append(snapshot.Partial, censusPartial{Pid: row.Pid, Missing: missing})
							}
						}
					}
				}
				windows.CloseHandle(handle)
			}
		}
	}
	if opts.IdentityOnly {
		return snapshot, nil
	}
	names := make(map[string]bool)
	if discoverJobs {
		for _, name := range censusWindowsJobNames(append(jobCarriers, snapshot.Rows...)) {
			names[name] = true
		}
	}
	for _, name := range opts.JobNames {
		names[name] = true
	}
	for name := range names {
		observation, cached := explicit[name]
		if !cached {
			observation = censusWindowsObserveJob(name)
		}
		var membershipErr error
		if observation.State == "unavailable" {
			membershipErr = fmt.Errorf("Job membership unavailable")
		}
		applyCensusJobMembership(&snapshot, name, observation.Pids, membershipErr)
	}
	return snapshot, nil
}

func censusWindowsObserveJob(name string) censusJobObservation {
	observation := censusJobObservation{Name: name, State: "unavailable"}
	job, exists, err := openJobByName(name, jobObjectQuery)
	if err != nil {
		return observation
	}
	if !exists {
		observation.State = "absent"
		return observation
	}
	defer procCloseHandle.Call(job)
	members, err := censusWindowsJobPids(job)
	if err != nil {
		return observation
	}
	observation.State = "absent"
	if len(members) > 0 {
		observation.State = "live"
		observation.Pids = members
	}
	return observation
}
