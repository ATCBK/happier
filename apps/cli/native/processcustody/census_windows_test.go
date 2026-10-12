//go:build windows

package main

import (
	"golang.org/x/sys/windows"
	"reflect"
	"testing"
)

func TestWindowsCensusToolhelpAndFiletimeFixtures(t *testing.T) {
	var entry windows.ProcessEntry32
	entry.ProcessID, entry.ParentProcessID = 4242, 100
	copy(entry.ExeFile[:], windows.StringToUTF16("tool.exe"))
	row := censusWindowsToolhelpRow(entry)
	if row.Pid != 4242 || *row.Ppid != 100 || row.Name != "tool.exe" {
		t.Fatalf("incorrect Toolhelp projection: %+v", row)
	}
	const ticks uint64 = 116_444_736_000_000_000 + 1_754_041_400_987*10000 + 6543
	start, err := censusWindowsStart(windows.Filetime{LowDateTime: uint32(ticks & 0xffffffff), HighDateTime: uint32(ticks >> 32)})
	if err != nil || start.StartTimeMs != 1_754_041_400_987 {
		t.Fatalf("FILETIME identity changed persisted milliseconds: %+v %v", start, err)
	}
	if _, err := censusWindowsStart(windows.Filetime{}); err == nil {
		t.Fatal("zero FILETIME must not become an identity")
	}
}

func TestWindowsCensusJobCarrierDiscovery(t *testing.T) {
	rows := []censusRow{
		{Name: "happier-process-custody.exe", Argv: []string{"helper", "run", "--job=Local\\happier-real", "--", "tool", "--job=fake"}},
		{Name: "tool.exe", Argv: []string{"tool", "run", "--job=other"}},
	}
	if got := censusWindowsJobNames(rows); !reflect.DeepEqual(got, []string{"Local\\happier-real"}) {
		t.Fatalf("incorrect job discovery: %v", got)
	}
}
