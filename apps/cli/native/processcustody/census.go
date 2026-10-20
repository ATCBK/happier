package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math/bits"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"
)

type censusStart struct {
	StartTimeMs int64  `json:"startTimeMs"`
	Native      string `json:"native,omitempty"`
}
type censusPrincipal struct {
	Kind  string `json:"kind"`
	Value string `json:"value"`
}
type censusMemory struct {
	Bytes uint64 `json:"bytes"`
	Kind  string `json:"kind"`
}
type censusRow struct {
	Pid                  int               `json:"pid"`
	Ppid                 *int              `json:"ppid"`
	Pgid                 *int              `json:"pgid,omitempty"`
	SessionId            *int              `json:"sessionId,omitempty"`
	Start                censusStart       `json:"start"`
	Principal            *censusPrincipal  `json:"principal"`
	Name                 string            `json:"name"`
	ExecutablePath       string            `json:"executablePath,omitempty"`
	Argv                 []string          `json:"argv,omitempty"`
	CommandLine          string            `json:"commandLine,omitempty"`
	Cwd                  string            `json:"cwd,omitempty"`
	OwnerTag             string            `json:"ownerTag,omitempty"`
	OwnershipEnvironment map[string]string `json:"ownershipEnvironment,omitempty"`
	Memory               *censusMemory     `json:"memory"`
	CpuTimeUs            *uint64           `json:"cpuTimeUs"`
	Jobs                 []string          `json:"jobs,omitempty"`
	State                string            `json:"state,omitempty"`
	Tpgid                *int              `json:"tpgid,omitempty"`
}
type censusPartial struct {
	Pid     int      `json:"pid"`
	Missing []string `json:"missing"`
}
type censusJobObservation struct {
	Name  string `json:"name"`
	State string `json:"state"`
	Pids  []int  `json:"pids,omitempty"`
}
type censusSnapshot struct {
	V               int                    `json:"v"`
	CapturedAtMs    int64                  `json:"capturedAtMs"`
	LogicalCpus     int                    `json:"logicalCpus"`
	Rows            []censusRow            `json:"rows"`
	Partial         []censusPartial        `json:"partial"`
	JobObservations []censusJobObservation `json:"jobObservations,omitempty"`
}
type censusOptions struct {
	Pids             map[int]bool
	CallerPid        int
	Scope            string
	JobNames         []string
	IdentityOnly     bool
	IncludeAncestors bool
	Fields           map[string]bool
}

func (opts censusOptions) wants(field string) bool {
	return !opts.IdentityOnly && (opts.Fields == nil || opts.Fields[field])
}

func parseCensusOptions(args []string, selfPid int) (censusOptions, error) {
	opts := censusOptions{Scope: "own_principal"}
	for _, arg := range args {
		key, value, ok := strings.Cut(arg, "=")
		if !ok {
			return opts, fmt.Errorf("invalid census option %q", arg)
		}
		switch key {
		case "--fields":
			opts.Fields = make(map[string]bool)
			if value == "" {
				continue
			}
			for _, field := range strings.Split(value, ",") {
				switch field {
				case "argv", "cwd", "executablePath", "ownershipEnvironment", "cgroup", "memory", "cpuTimeUs":
					opts.Fields[field] = true
				default:
					return opts, fmt.Errorf("invalid census field %q", field)
				}
			}
		case "--identity-only", "--include-ancestors":
			if value != "true" && value != "false" {
				return opts, fmt.Errorf("invalid census projection")
			}
			if key == "--identity-only" {
				opts.IdentityOnly = value == "true"
			} else {
				opts.IncludeAncestors = value == "true"
			}
		case "--job":
			if value == "" || strings.ContainsRune(value, '\x00') {
				return opts, fmt.Errorf("invalid census Job name")
			}
			duplicate := false
			for _, name := range opts.JobNames {
				if name == value {
					duplicate = true
				}
			}
			if !duplicate {
				opts.JobNames = append(opts.JobNames, value)
			}
		case "--scope":
			if value != "all" && value != "own_principal" {
				return opts, fmt.Errorf("invalid census scope")
			}
			opts.Scope = value
		case "--pids":
			if opts.Pids == nil {
				opts.Pids = make(map[int]bool)
			}
			for _, item := range strings.Split(value, ",") {
				pid, err := strconv.Atoi(item)
				if err != nil || pid <= 0 {
					return opts, fmt.Errorf("invalid census pid")
				}
				opts.Pids[pid] = true
			}
		case "--caller-pid":
			pid, err := strconv.Atoi(value)
			if err != nil || pid <= 0 {
				return opts, fmt.Errorf("invalid caller pid")
			}
			opts.CallerPid = pid
		default:
			return opts, fmt.Errorf("unknown census option %q", key)
		}
	}
	if opts.Pids != nil {
		opts.Pids[selfPid] = true
		if opts.CallerPid > 0 {
			opts.Pids[opts.CallerPid] = true
		}
	}
	return opts, nil
}

func decodeDarwinProcargs(buffer []byte) (string, []string, string, map[string]string, error) {
	if len(buffer) < 4 {
		return "", nil, "", nil, fmt.Errorf("short KERN_PROCARGS2")
	}
	argc := int(int32(binary.LittleEndian.Uint32(buffer)))
	if argc <= 0 {
		return "", nil, "", nil, fmt.Errorf("invalid KERN_PROCARGS2 argc")
	}
	buffer = buffer[4:]
	executable, rest, ok := cutCensusCString(buffer)
	if !ok || len(executable) == 0 {
		return "", nil, "", nil, fmt.Errorf("missing process executable")
	}
	// KERN_PROCARGS2 pads between the executable path and argv[0]. After
	// argv[0], empty arguments are significant and must not be skipped.
	for len(rest) > 0 && rest[0] == 0 {
		rest = rest[1:]
	}
	argv := make([]string, 0)
	for i := 0; i < argc; i++ {
		arg, next, ok := cutCensusCString(rest)
		if !ok {
			return "", nil, "", nil, fmt.Errorf("truncated process argv")
		}
		argv = append(argv, string(arg))
		rest = next
	}
	var tag string
	env := make(map[string]string)
	for len(rest) > 0 {
		entry, next, ok := cutCensusCString(rest)
		if !ok {
			break
		}
		rest = next
		key, value, ok := strings.Cut(string(entry), "=")
		if !ok {
			continue
		}
		if key == "HAPPIER_PROCESS_OWNER" {
			tag = value
			continue
		}
		if censusOwnershipEnvironmentKey(key) {
			if value = strings.TrimSpace(value); value != "" {
				env[key] = value
			}
		}
	}
	return string(executable), argv, tag, env, nil
}

func censusMicroseconds(user, system, unitsPerMicrosecond uint64) (uint64, error) {
	if unitsPerMicrosecond == 0 {
		return 0, fmt.Errorf("invalid CPU time unit")
	}
	// Convert each cumulative counter before summing: nanosecond counters may
	// exceed JavaScript precision, and their uint64 sum can overflow first.
	u, s := user/unitsPerMicrosecond, system/unitsPerMicrosecond
	carry := (user%unitsPerMicrosecond + system%unitsPerMicrosecond) / unitsPerMicrosecond
	const maxSafeInteger uint64 = 9_007_199_254_740_991
	if u > maxSafeInteger || s > maxSafeInteger-u || carry > maxSafeInteger-u-s {
		return 0, fmt.Errorf("CPU time cannot be represented exactly in JSON")
	}
	return u + s + carry, nil
}

func censusTimebaseMicroseconds(user, system, frequency uint64) (uint64, error) {
	if frequency == 0 {
		return 0, fmt.Errorf("unavailable native CPU timebase")
	}
	// Sum ticks in 128 bits after multiplying: neither a cumulative uint64
	// sum nor converting through floating-point nanoseconds is lossless.
	uhi, ulo := bits.Mul64(user, 1_000_000)
	shi, slo := bits.Mul64(system, 1_000_000)
	lo, carry := bits.Add64(ulo, slo, 0)
	hi, _ := bits.Add64(uhi, shi, carry)
	if hi >= frequency {
		return 0, fmt.Errorf("CPU time cannot be represented exactly in JSON")
	}
	value, _ := bits.Div64(hi, lo, frequency)
	if value > 9_007_199_254_740_991 {
		return 0, fmt.Errorf("CPU time cannot be represented exactly in JSON")
	}
	return value, nil
}

func cutCensusCString(raw []byte) ([]byte, []byte, bool) {
	end := bytes.IndexByte(raw, 0)
	if end < 0 {
		return nil, nil, false
	}
	return raw[:end], raw[end+1:], true
}

func censusOwnershipEnvironmentKey(key string) bool {
	switch key {
	case "HAPPIER_HOME_DIR", "HAPPIER_ACTIVE_SERVER_ID", "HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID", "HAPPIER_SERVER_URL", "HAPPIER_WEBAPP_URL", "HAPPIER_PUBLIC_SERVER_URL":
		return true
	default:
		return false
	}
}

func newCensusSnapshot() censusSnapshot {
	return censusSnapshot{V: 1, CapturedAtMs: time.Now().UnixMilli(), LogicalCpus: runtime.NumCPU(), Rows: make([]censusRow, 0), Partial: make([]censusPartial, 0)}
}

func censusWantsPid(opts censusOptions, pid int) bool { return opts.Pids == nil || opts.Pids[pid] }

func includeCensusAncestors(opts censusOptions, parents map[int]int) {
	if opts.Pids == nil || !opts.IncludeAncestors {
		return
	}
	for pid := range opts.Pids {
		for parent := parents[pid]; parent > 1 && !opts.Pids[parent]; parent = parents[parent] {
			opts.Pids[parent] = true
		}
	}
}

func applyCensusSessionId(row *censusRow, sid int, err error) []string {
	if err != nil || sid <= 0 {
		return []string{"sessionId"}
	}
	row.SessionId = &sid
	return nil
}

func applyCensusJobMembership(snapshot *censusSnapshot, name string, members []int, err error) {
	if err != nil {
		// Failure to read one known Job leaves every selected row's membership
		// in that Job unknown, not merely the resident helper's membership.
		for _, row := range snapshot.Rows {
			snapshot.Partial = append(snapshot.Partial, censusPartial{Pid: row.Pid, Missing: []string{"jobs"}})
		}
		return
	}
	memberSet := make(map[int]bool, len(members))
	for _, pid := range members {
		memberSet[pid] = true
	}
	for i := range snapshot.Rows {
		if memberSet[snapshot.Rows[i].Pid] {
			snapshot.Rows[i].Jobs = append(snapshot.Rows[i].Jobs, name)
		}
	}
}

func validateCensusPresence(snapshot censusSnapshot, opts censusOptions) error {
	self, caller := false, opts.CallerPid == 0
	for _, row := range snapshot.Rows {
		if row.Pid == os.Getpid() {
			self = true
		}
		if row.Pid == opts.CallerPid {
			caller = true
		}
	}
	if !self || !caller {
		return fmt.Errorf("self_absent: census did not contain helper and caller")
	}
	return nil
}

func processCensusCommand(args []string) error {
	opts, err := parseCensusOptions(args, os.Getpid())
	if err != nil {
		usage()
		os.Exit(exitUsage)
	}
	if len(opts.JobNames) > 0 && runtime.GOOS != "windows" {
		return fmt.Errorf("explicit Job census requires Windows")
	}
	snapshot, err := readNativeProcessCensus(opts)
	if err != nil {
		return err
	}
	if err := validateCensusPresence(snapshot, opts); err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(snapshot)
}
