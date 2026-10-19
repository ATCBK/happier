//go:build windows

package main

import "testing"

func TestWindowsBaseMemoryIncludesMeasuredComposition(t *testing.T) {
	sample, err := readNativeVitals(false)
	if err != nil {
		t.Fatal(err)
	}
	if len(sample.Memory.Composition) == 0 {
		t.Fatal("base memory reading has no composition")
	}
	var sum uint64
	for _, segment := range sample.Memory.Composition {
		sum += segment.Bytes
	}
	if used := sample.Memory.TotalBytes - sample.Memory.AvailableBytes; sum != used {
		t.Fatalf("composition %d differs from used memory %d", sum, used)
	}
}
