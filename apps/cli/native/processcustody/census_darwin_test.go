//go:build darwin

package main

import (
	"golang.org/x/sys/unix"
	"testing"
)

func TestDarwinCensusKinfoFixtureKeepsPersistedWholeSeconds(t *testing.T) {
	var info unix.KinfoProc
	info.Proc.P_pid = 4242
	info.Proc.P_starttime = unix.Timeval{Sec: 1_754_041_400, Usec: 987654}
	info.Proc.P_stat = 4
	copy(info.Proc.P_comm[:], "tool")
	info.Eproc.Ppid = 100
	info.Eproc.Pgid = 4000
	info.Eproc.Tpgid = 4001
	info.Eproc.Ucred.Uid = 501
	row, err := decodeDarwinCensusKinfo(info, 1_754_041_500)
	if err != nil || row.Start.StartTimeMs != 1_754_041_400_000 || row.Start.Native != "darwin-proc:4242:1754041400:987654" || *row.Ppid != 100 || *row.Pgid != 4000 || *row.Tpgid != 4001 || row.Principal.Value != "501" || row.State != "stopped" {
		t.Fatalf("kinfo fixture decoded incorrectly: %+v %v", row, err)
	}
	info.Proc.P_starttime.Usec = 1_000_000
	if _, err := decodeDarwinCensusKinfo(info, 1_754_041_500); err == nil {
		t.Fatal("malformed native identity accepted")
	}
}
