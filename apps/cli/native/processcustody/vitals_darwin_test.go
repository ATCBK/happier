//go:build darwin

package main

import (
	"os/exec"
	"strconv"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

func TestDarwinInterfaceCountersMatchNetstat(t *testing.T) {
	// netstat is an independent OS boundary, not part of the product sampling path.
	before, err := exec.Command("/usr/sbin/netstat", "-ib").Output()
	if err != nil {
		t.Fatal(err)
	}
	sample, err := readDarwinVitalsInterfaces()
	if err != nil {
		t.Fatal(err)
	}
	after, err := exec.Command("/usr/sbin/netstat", "-ib").Output()
	if err != nil {
		t.Fatal(err)
	}
	counters := func(raw []byte) map[string][2]uint64 {
		result := map[string][2]uint64{}
		for _, line := range strings.Split(string(raw), "\n") {
			fields := strings.Fields(line)
			if len(fields) < 11 || !strings.HasPrefix(fields[2], "<Link#") {
				continue
			}
			rx, rxErr := strconv.ParseUint(fields[6], 10, 64)
			tx, txErr := strconv.ParseUint(fields[9], 10, 64)
			if rxErr == nil && txErr == nil {
				result[fields[0]] = [2]uint64{rx, tx}
			}
		}
		return result
	}
	low, high := counters(before), counters(after)
	checked := 0
	for _, iface := range sample {
		start, ok := low[iface.Name]
		end, endOK := high[iface.Name]
		if !ok || !endOK || start[0] == 0 {
			continue
		}
		checked++
		if iface.RxBytes < start[0] || iface.RxBytes > end[0] || iface.TxBytes < start[1] || iface.TxBytes > end[1] {
			t.Errorf("%s native=%d/%d netstat=%v..%v", iface.Name, iface.RxBytes, iface.TxBytes, start, end)
		}
	}
	if checked == 0 {
		t.Fatal("no active interface to compare")
	}
}

func TestDarwinVolumesExcludeReadOnlyImages(t *testing.T) {
	volumes, err := readDarwinVitalsVolumes()
	if err != nil {
		t.Fatal(err)
	}
	for _, volume := range volumes {
		if volume.Mount == "/" {
			continue
		} // Sealed root projects the writable Data capacity.
		var st unix.Statfs_t
		if err := unix.Statfs(volume.Mount, &st); err != nil {
			t.Fatal(err)
		}
		if st.Flags&unix.MNT_RDONLY != 0 {
			t.Errorf("read-only image produces writable capacity: %s", volume.Mount)
		}
	}
}
