//go:build !darwin && !windows

package main

import "fmt"

func readNativeVitals(extras bool) (vitalsNativeSample, error) {
	return vitalsNativeSample{}, fmt.Errorf("vitals-sample is available on macOS and Windows only")
}
