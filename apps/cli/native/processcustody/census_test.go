package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func TestNativeIdentityOnlyIncludesReaderAncestors(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "windows" {
		t.Skip("native census platform")
	}
	opts, err := parseCensusOptions([]string{"--scope=all", "--pids=" + fmt.Sprint(os.Getpid()), "--include-ancestors=true", "--identity-only=true"}, os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := readNativeProcessCensus(opts)
	if err != nil {
		t.Fatal(err)
	}
	seen := make(map[int]bool)
	for _, row := range snapshot.Rows {
		seen[row.Pid] = true
		if row.Start.StartTimeMs <= 0 || row.Principal == nil {
			t.Fatalf("identity unavailable: %+v", row)
		}
		if row.Memory != nil || row.CpuTimeUs != nil || len(row.Argv) > 0 || row.ExecutablePath != "" || row.OwnerTag != "" || row.Cwd != "" {
			t.Fatalf("identity read enriched private fields: %+v", row)
		}
	}
	if !seen[os.Getpid()] || os.Getppid() > 1 && !seen[os.Getppid()] {
		t.Fatalf("reader ancestry missing: %+v", snapshot.Rows)
	}
}

func TestNativeCensusMetricsProjection(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "windows" {
		t.Skip("native census platform")
	}
	fullOpts, err := parseCensusOptions([]string{"--scope=all", "--pids=" + fmt.Sprint(os.Getpid())}, os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	full, err := readNativeProcessCensus(fullOpts)
	if err != nil {
		t.Fatal(err)
	}
	var fullSelf censusRow
	for _, row := range full.Rows {
		if row.Pid == os.Getpid() {
			fullSelf = row
		}
	}
	if len(fullSelf.Argv) == 0 || fullSelf.ExecutablePath == "" {
		t.Fatalf("full census lost its process details: %+v", fullSelf)
	}
	for _, fields := range []string{"memory,cpuTimeUs", "memory", "cpuTimeUs"} {
		t.Run(fields, func(t *testing.T) {
			opts, err := parseCensusOptions([]string{"--scope=all", "--pids=" + fmt.Sprint(os.Getpid()), "--fields=" + fields}, os.Getpid())
			if err != nil {
				t.Fatal(err)
			}
			snapshot, err := readNativeProcessCensus(opts)
			if err != nil {
				t.Fatal(err)
			}
			if len(snapshot.Rows) != 1 {
				t.Fatalf("filtered metrics read lost self: %+v", snapshot)
			}
			row := snapshot.Rows[0]
			if row.Start != fullSelf.Start || !reflect.DeepEqual(row.Principal, fullSelf.Principal) || row.Name != fullSelf.Name || !reflect.DeepEqual(row.Ppid, fullSelf.Ppid) {
				t.Fatalf("metrics projection changed identity: %+v", row)
			}
			if (row.Memory != nil) != strings.Contains(fields, "memory") || (row.CpuTimeUs != nil) != strings.Contains(fields, "cpuTimeUs") {
				t.Fatalf("metrics projection lost requested resources: %+v", row)
			}
			if len(row.Argv) != 0 || row.CommandLine != "" || row.ExecutablePath != "" || row.Cwd != "" || row.OwnerTag != "" || len(row.OwnershipEnvironment) != 0 || len(row.Jobs) != 0 || len(snapshot.JobObservations) != 0 || len(snapshot.Partial) != 0 {
				t.Fatalf("metrics projection enriched unrelated details: %+v", snapshot)
			}
		})
	}
}

func TestCensusFilterIncludesReaderAndCaller(t *testing.T) {
	opts, err := parseCensusOptions([]string{"--scope=own_principal", "--pids=42,43", "--caller-pid=99"}, 100)
	if err != nil || !reflect.DeepEqual(opts.Pids, map[int]bool{42: true, 43: true, 99: true, 100: true}) || opts.CallerPid != 99 || opts.Scope != "own_principal" {
		t.Fatalf("pid-filtered census must retain both self-presence witnesses: %+v %v", opts, err)
	}
	for _, args := range [][]string{{"--pids=0"}, {"--pids=42,no"}, {"--caller-pid=-1"}, {"--scope=everything"}, {"--fields=memory,unknown"}, {"--unknown"}} {
		if _, err := parseCensusOptions(args, 100); err == nil {
			t.Fatalf("accepted malformed options %v", args)
		}
	}
}

func TestCensusFieldSelectionKeepsFullAndIdentityNeighbors(t *testing.T) {
	for _, test := range []struct {
		args         []string
		memory, argv bool
	}{
		{nil, true, true},
		{[]string{"--fields=memory,cpuTimeUs"}, true, false},
		{[]string{"--fields="}, false, false},
		{[]string{"--identity-only=true"}, false, false},
	} {
		opts, err := parseCensusOptions(test.args, 100)
		if err != nil || opts.wants("memory") != test.memory || opts.wants("argv") != test.argv {
			t.Fatalf("field projection changed for %v: %+v %v", test.args, opts, err)
		}
	}
}

func TestCensusSessionLeaderComesFromOsNotReparentedTree(t *testing.T) {
	ppid, pgid := 1, 42
	row := censusRow{Pid: 43, Ppid: &ppid, Pgid: &pgid}
	// Fixture of getsid(43): the login-session leader differs from the
	// reparented process's parent and process group. Neither is a fallback.
	missing := applyCensusSessionId(&row, 17, nil)
	if row.SessionId == nil || *row.SessionId != 17 || len(missing) != 0 {
		t.Fatalf("session leader was inferred from the tree: %+v missing=%v", row, missing)
	}
	for _, response := range []struct {
		sid int
		err error
	}{{0, errors.New("permission denied")}, {0, nil}} {
		row := censusRow{Pid: 43, Ppid: &ppid, Pgid: &pgid}
		missing := applyCensusSessionId(&row, response.sid, response.err)
		if row.SessionId != nil || !reflect.DeepEqual(missing, []string{"sessionId"}) {
			t.Fatalf("unreadable session ID was invented: %+v missing=%v", row, missing)
		}
	}
}

func TestCensusUnreadableJobMembershipIsPartialForSelectedRows(t *testing.T) {
	snapshot := newCensusSnapshot()
	snapshot.Rows = []censusRow{{Pid: 42}, {Pid: 43}}
	applyCensusJobMembership(&snapshot, "job", []int{42}, errors.New("access denied"))
	if len(snapshot.Partial) != 2 || snapshot.Partial[0].Pid != 42 || snapshot.Partial[1].Pid != 43 || !reflect.DeepEqual(snapshot.Partial[0].Missing, []string{"jobs"}) || len(snapshot.Rows[0].Jobs) != 0 {
		t.Fatalf("unreadable jobs must not imply no membership: %+v", snapshot)
	}
	applyCensusJobMembership(&snapshot, "job", []int{42}, nil)
	if !reflect.DeepEqual(snapshot.Rows[0].Jobs, []string{"job"}) || len(snapshot.Rows[1].Jobs) != 0 {
		t.Fatalf("job membership leaked to a nonmember: %+v", snapshot.Rows)
	}
}

func TestDarwinProcargsPreservesArgumentsAndOnlyOwnershipEnvironment(t *testing.T) {
	buffer := make([]byte, 4)
	binary.LittleEndian.PutUint32(buffer, 3)
	buffer = append(buffer, []byte("/bin/tool\x00\x00\x00tool\x00\x00arg with spaces\x00HAPPIER_PROCESS_OWNER=v1.scope.session.id\x00HAPPIER_HOME_DIR= /home/test \x00SECRET_TOKEN=must-not-survive\x00PATH=/bin\x00")...)
	exe, argv, tag, env, err := decodeDarwinProcargs(buffer)
	if err != nil || exe != "/bin/tool" || !reflect.DeepEqual(argv, []string{"tool", "", "arg with spaces"}) || tag != "v1.scope.session.id" || !reflect.DeepEqual(env, map[string]string{"HAPPIER_HOME_DIR": "/home/test"}) {
		t.Fatalf("incorrect native argv/environment reduction: exe=%q argv=%q tag=%q env=%v err=%v", exe, argv, tag, env, err)
	}
	for _, raw := range [][]byte{nil, {3, 0, 0, 0}, append([]byte{2, 0, 0, 0}, []byte("/bin/tool\x00\x00tool\x00")...)} {
		if _, _, _, _, err := decodeDarwinProcargs(raw); err == nil {
			t.Fatalf("accepted truncated procargs %v", raw)
		}
	}
}

func TestCensusCpuTimeConvertsBeforeExceedingJavascriptNanosecondPrecision(t *testing.T) {
	got, err := censusMicroseconds(9_007_199_254_740_991, 9_007_199_254_740_991, 1000)
	if err != nil || got != 18_014_398_509_481 {
		t.Fatalf("CPU counter precision lost: %d %v", got, err)
	}
	got, err = censusMicroseconds(^uint64(0), ^uint64(0), 10000)
	if err != nil || got != 3_689_348_814_741_910 {
		t.Fatalf("overflow before unit conversion: %d %v", got, err)
	}
	if _, err := censusMicroseconds(^uint64(0), ^uint64(0), 1000); err == nil {
		t.Fatal("unsafe JSON CPU time must remain unavailable")
	}
}

func TestCensusCpuTimeUsesPlatformTimebase(t *testing.T) {
	got, err := censusTimebaseMicroseconds(24_000_001, 11, 24_000_000)
	if err != nil || got != 1_000_000 {
		t.Fatalf("ARM Mach ticks must use the platform frequency: %d %v", got, err)
	}
	got, err = censusTimebaseMicroseconds(^uint64(0), ^uint64(0), 24_000_000_000)
	if err != nil || got != 1_537_228_672_809_129 {
		t.Fatalf("timebase conversion overflowed before division: %d %v", got, err)
	}
	if _, err := censusTimebaseMicroseconds(1, 1, 0); err == nil {
		t.Fatal("unknown native timebase must remain unavailable")
	}
}
