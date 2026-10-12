//go:build !windows

package main

import "fmt"

func keepAwakeCommand(_ []string) error {
	return fmt.Errorf("keep-awake native command is only available on Windows")
}
