//go:build !windows

package main

import "fmt"

func joinCustodyJob([]string) error { return fmt.Errorf("job-join is only available on Windows") }
func releaseCustodyJobHandle([]string) error {
	return fmt.Errorf("job-release is only available on Windows")
}
