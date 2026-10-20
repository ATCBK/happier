//go:build darwin

package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"strconv"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

// These are the public libproc structures/flavors from XNU proc_info.h and
// resource.h. __proc_info is libproc's syscall seam, so no cgo is needed.
// https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/libproc/libproc.c
const (
	censusDarwinTaskInfo      = 4
	censusDarwinVnodePathInfo = 9
	censusDarwinTaskInfoSize  = 96
	censusDarwinRusageV0Size  = 96
	censusDarwinVnodeInfoSize = 152
	censusDarwinPathSize      = 1024
)

func censusDarwinProcInfo(callnum, pid, flavor int, buffer []byte) (int, error) {
	r, _, errno := syscall.Syscall6(unix.SYS_PROC_INFO, uintptr(callnum), uintptr(pid), uintptr(flavor), 0, uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
	if errno != 0 {
		return 0, errno
	}
	return int(r), nil
}

func decodeDarwinCensusKinfo(info unix.KinfoProc, nowSecond int64) (censusRow, error) {
	pid := int(info.Proc.P_pid)
	sec, usec := info.Proc.P_starttime.Sec, info.Proc.P_starttime.Usec
	if pid <= 0 || sec <= 0 || sec > nowSecond || usec < 0 || usec >= 1_000_000 {
		return censusRow{}, fmt.Errorf("invalid kinfo_proc identity")
	}
	ppid, pgid, tpgid := int(info.Eproc.Ppid), int(info.Eproc.Pgid), int(info.Eproc.Tpgid)
	name, _, ok := cutCensusCString(info.Proc.P_comm[:])
	if !ok {
		return censusRow{}, fmt.Errorf("unterminated kinfo_proc comm")
	}
	state := "other"
	switch info.Proc.P_stat {
	case 1, 3:
		state = "sleeping"
	case 2:
		state = "running"
	case 4:
		state = "stopped"
	case 5:
		state = "zombie"
	}
	return censusRow{Pid: pid, Ppid: &ppid, Pgid: &pgid, Tpgid: &tpgid, Start: censusStart{StartTimeMs: sec * 1000, Native: fmt.Sprintf("darwin-proc:%d:%d:%d", pid, sec, usec)}, Principal: &censusPrincipal{Kind: "uid", Value: strconv.FormatUint(uint64(info.Eproc.Ucred.Uid), 10)}, Name: string(name), State: state}, nil
}

func readNativeProcessCensus(opts censusOptions) (censusSnapshot, error) {
	snapshot := newCensusSnapshot()
	infos, err := unix.SysctlKinfoProcSlice("kern.proc.all")
	if err != nil {
		return snapshot, err
	}
	parents := make(map[int]int, len(infos))
	for _, info := range infos {
		parents[int(info.Proc.P_pid)] = int(info.Eproc.Ppid)
	}
	includeCensusAncestors(opts, parents)
	ownUid := strconv.Itoa(os.Geteuid())
	// PROC_PIDTASKINFO reports Mach absolute ticks (XNU fill_taskprocinfo),
	// not nanoseconds on Apple Silicon. hw.tbfrequency is the platform's
	// timebase frequency, exposed as uint64 by XNU kern_mib.c.
	var frequency uint64
	if opts.wants("cpuTimeUs") {
		frequency, _ = unix.SysctlUint64("hw.tbfrequency")
	}
	for _, info := range infos {
		pid := int(info.Proc.P_pid)
		if pid <= 0 || !censusWantsPid(opts, pid) {
			continue
		}
		row, err := decodeDarwinCensusKinfo(info, time.Now().Unix())
		if err != nil {
			snapshot.Partial = append(snapshot.Partial, censusPartial{Pid: pid, Missing: []string{"start"}})
			continue
		}
		own := row.Principal.Value == ownUid
		if opts.Scope == "own_principal" && !own {
			continue
		}
		if opts.IdentityOnly {
			snapshot.Rows = append(snapshot.Rows, row)
			continue
		}
		sid, sidErr := unix.Getsid(pid)
		missing := applyCensusSessionId(&row, sid, sidErr)
		gone := false
		if opts.wants("memory") || opts.wants("cpuTimeUs") {
			task := make([]byte, censusDarwinTaskInfoSize)
			if n, err := censusDarwinProcInfo(2, pid, censusDarwinTaskInfo, task); err == nil && n == len(task) {
				if opts.wants("memory") {
					row.Memory = &censusMemory{Bytes: binary.LittleEndian.Uint64(task[8:]), Kind: "rss"}
				}
				if opts.wants("cpuTimeUs") {
					cpu, err := censusTimebaseMicroseconds(binary.LittleEndian.Uint64(task[16:]), binary.LittleEndian.Uint64(task[24:]), frequency)
					if err == nil {
						row.CpuTimeUs = &cpu
					} else {
						missing = append(missing, "cpuTimeUs")
					}
				}
			} else {
				if errors.Is(err, syscall.ESRCH) {
					gone = true
				}
				for _, field := range []string{"memory", "cpuTimeUs"} {
					if opts.wants(field) {
						missing = append(missing, field)
					}
				}
			}
		}
		if own && !gone && opts.wants("memory") {
			rusage := make([]byte, censusDarwinRusageV0Size)
			if _, err := censusDarwinProcInfo(9, pid, 0, rusage); err == nil {
				row.Memory = &censusMemory{Bytes: binary.LittleEndian.Uint64(rusage[72:]), Kind: "footprint"}
				// Successful footprint satisfies memory even when TASKINFO failed.
				for i, field := range missing {
					if field == "memory" {
						missing = append(missing[:i], missing[i+1:]...)
						break
					}
				}
			}
		}
		if own && !gone && (opts.wants("executablePath") || opts.wants("argv") || opts.wants("ownershipEnvironment")) {
			args, err := sysctlBuffer([]uint32{ctlKern, 49, uint32(pid)}) // KERN_PROCARGS2
			if err == nil {
				var executable, tag string
				var argv []string
				var environment map[string]string
				executable, argv, tag, environment, err = decodeDarwinProcargs(args)
				if opts.wants("executablePath") {
					row.ExecutablePath = executable
				}
				if opts.wants("argv") {
					row.Argv = argv
				}
				if opts.wants("ownershipEnvironment") {
					row.OwnerTag, row.OwnershipEnvironment = tag, environment
				}
			}
			if err != nil {
				if errors.Is(err, syscall.ESRCH) {
					gone = true
				}
				for _, field := range []string{"executablePath", "argv", "ownershipEnvironment"} {
					if opts.wants(field) {
						missing = append(missing, field)
						if field == "ownershipEnvironment" {
							missing = append(missing, "ownerTag")
						}
					}
				}
			}
		}
		if own && !gone && opts.wants("cwd") {
			vnode := make([]byte, 2*(censusDarwinVnodeInfoSize+censusDarwinPathSize))
			if n, err := censusDarwinProcInfo(2, pid, censusDarwinVnodePathInfo, vnode); err == nil && n == len(vnode) {
				if cwd, _, ok := cutCensusCString(vnode[censusDarwinVnodeInfoSize : censusDarwinVnodeInfoSize+censusDarwinPathSize]); ok {
					row.Cwd = string(cwd)
				} else {
					missing = append(missing, "cwd")
				}
			} else {
				missing = append(missing, "cwd")
			}
		}
		if gone {
			continue
		}
		snapshot.Rows = append(snapshot.Rows, row)
		if len(missing) > 0 {
			snapshot.Partial = append(snapshot.Partial, censusPartial{Pid: pid, Missing: missing})
		}
	}
	return snapshot, nil
}
