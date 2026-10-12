//go:build !darwin && !windows

package main

import "fmt"

func readNativeProcessCensus(opts censusOptions) (censusSnapshot, error) {
	return censusSnapshot{}, fmt.Errorf("native process census unavailable on this platform; Linux uses procfs")
}
