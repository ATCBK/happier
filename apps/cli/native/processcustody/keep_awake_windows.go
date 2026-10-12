//go:build windows

package main

import (
	"fmt"
	"io"
	"os"
	"runtime"
	"syscall"
)

// The execution requirement belongs to this exact OS thread, which stays
// locked until the daemon's stdin pipe closes. No display/away-mode request.
func keepAwakeCommand(args []string) error {
	if len(args) != 0 {
		return fmt.Errorf("keep-awake takes no arguments")
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	setState := syscall.NewLazyDLL("kernel32.dll").NewProc("SetThreadExecutionState")
	const continuous = 0x80000000
	const systemRequired = 0x00000001
	result, _, err := setState.Call(continuous | systemRequired)
	if result == 0 {
		return fmt.Errorf("SetThreadExecutionState: %w", err)
	}
	defer setState.Call(continuous)
	if err := emit(map[string]any{"holding": true}); err != nil {
		return err
	}
	_, err = io.Copy(io.Discard, os.Stdin)
	return err
}
