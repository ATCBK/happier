package main

import (
	"fmt"
	"strings"
)

type vitalsCPU struct {
	User   uint64 `json:"user"`
	System uint64 `json:"system"`
	Idle   uint64 `json:"idle"`
}
type vitalsInterface struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	RxBytes  uint64 `json:"rxBytes"`
	TxBytes  uint64 `json:"txBytes"`
	Included bool   `json:"included"`
}
type vitalsVolume struct {
	ID              string `json:"id"`
	Label           string `json:"label"`
	Mount           string `json:"mount"`
	TotalBytes      uint64 `json:"totalBytes"`
	AvailableBytes  uint64 `json:"availableBytes"`
	APFSContainerID string `json:"apfsContainerId,omitempty"`
	InodesExhausted bool   `json:"inodesExhausted,omitempty"`
}
type vitalsComposition struct {
	Kind  string `json:"kind"`
	Bytes uint64 `json:"bytes"`
}
type vitalsSwap struct {
	Kind       string  `json:"kind"`
	TotalBytes uint64  `json:"totalBytes"`
	UsedBytes  uint64  `json:"usedBytes"`
	In         *uint64 `json:"in,omitempty"`
	Out        *uint64 `json:"out,omitempty"`
}
type vitalsMemory struct {
	TotalBytes      uint64              `json:"totalBytes"`
	AvailableBytes  uint64              `json:"availableBytes"`
	PressureLevel   string              `json:"pressureLevel"`
	PressureSource  string              `json:"pressureSource"`
	LowMemorySignal *bool               `json:"lowMemorySignal,omitempty"`
	Swap            *vitalsSwap         `json:"swap,omitempty"`
	Composition     []vitalsComposition `json:"composition,omitempty"`
}
type vitalsLimit struct {
	Used uint64 `json:"used"`
	Max  uint64 `json:"max"`
}
type vitalsBattery struct {
	Pct            uint8   `json:"pct"`
	State          string  `json:"state"`
	OnAC           bool    `json:"onAC"`
	MinutesToEmpty *uint32 `json:"minutesToEmpty,omitempty"`
}
type vitalsPower struct {
	OnAC bool `json:"onAC"`
}
type vitalsNativeSample struct {
	Memory              vitalsMemory           `json:"memory"`
	CPU                 []vitalsCPU            `json:"cpu,omitempty"`
	Clusters            []string               `json:"clusters,omitempty"`
	Volumes             []vitalsVolume         `json:"volumes"`
	Interfaces          []vitalsInterface      `json:"interfaces"`
	PerformanceCores    *uint32                `json:"performanceCores,omitempty"`
	EfficiencyCores     *uint32                `json:"efficiencyCores,omitempty"`
	Limits              map[string]vitalsLimit `json:"limits,omitempty"`
	Battery             *vitalsBattery         `json:"battery,omitempty"`
	Power               *vitalsPower           `json:"power,omitempty"`
	DaemonFileSoftLimit *uint64                `json:"daemonFileSoftLimit,omitempty"`
}

type vitalsPerfLevel struct {
	Name  string
	Cores uint32
}

func darwinVitalsCoreCounts(levels []vitalsPerfLevel) (*uint32, *uint32) {
	var performance, efficiency *uint32
	for _, level := range levels {
		switch strings.ToLower(level.Name) {
		case "performance":
			value := level.Cores
			if performance != nil {
				value += *performance
			}
			performance = &value
		case "efficiency":
			value := level.Cores
			if efficiency != nil {
				value += *efficiency
			}
			efficiency = &value
		}
	}
	return performance, efficiency
}

// vitals-sample is a one-shot boundary; the daemon owns rates and cadence.
func vitalsSampleCommand(args []string) error {
	extras := false
	for _, arg := range args {
		if arg != "--extras" {
			return fmt.Errorf("unknown vitals-sample argument %q", arg)
		}
		extras = true
	}
	sample, err := readNativeVitals(extras)
	if err != nil {
		return err
	}
	return emit(map[string]any{"t": "vitals-sample", "sample": sample})
}

func windowsProcessorTicks(idle, kernel, user uint64) map[string]uint64 {
	system := uint64(0)
	if kernel >= idle {
		system = kernel - idle
	}
	return map[string]uint64{"idle": idle, "user": user, "system": system}
}

func includeVitalsInterface(name string) bool {
	name = strings.ToLower(name)
	for _, prefix := range []string{"lo", "docker", "veth", "br-", "virbr", "tun", "utun", "tap", "gif", "stf", "wg", "tailscale", "ipsec", "awdl", "llw"} {
		if strings.HasPrefix(name, prefix) {
			return false
		}
	}
	return true
}
