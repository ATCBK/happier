package main

import (
	"encoding/json"
	"testing"
)

func TestWindowsProcessorTicksExcludeIdleFromKernel(t *testing.T) {
	// NT kernel time includes idle time. Counts exceed DWORD range on busy hosts.
	ticks := windowsProcessorTicks(9000000000, 12000000000, 6000000000)
	encoded, err := json.Marshal(ticks)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]uint64
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["system"] != 3000000000 || decoded["user"] != 6000000000 || decoded["idle"] != 9000000000 {
		t.Fatalf("wrong CPU counter encoding: %s", encoded)
	}
}

func TestDarwinCoreCountsUseCapturedNames(t *testing.T) {
	// mac-host, 2026-10-10: nperflevels=2; names Super, Performance.
	p, e := darwinVitalsCoreCounts([]vitalsPerfLevel{{"Super", 6}, {"Performance", 12}})
	if p == nil || *p != 12 || e != nil {
		t.Fatalf("guessed performance/efficiency counts: %v %v", p, e)
	}
	p, e = darwinVitalsCoreCounts([]vitalsPerfLevel{{"Performance", 8}, {"Efficiency", 4}})
	if p == nil || e == nil || *p != 8 || *e != 4 {
		t.Fatal("lost reported core classes")
	}
}

func TestVitalsNetworkCountsAggregateNotTunnel(t *testing.T) {
	for _, name := range []string{"bridge0", "bond0", "en0", "Wi-Fi"} {
		if !includeVitalsInterface(name) {
			t.Errorf("missing aggregate or physical interface %s", name)
		}
	}
	for _, name := range []string{"lo0", "utun0", "gif0", "stf0", "Tailscale", "docker0"} {
		if includeVitalsInterface(name) {
			t.Errorf("included virtual interface %s", name)
		}
	}
}
