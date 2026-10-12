//go:build darwin

// Darwin custody guards and the numeric-MIB sysctl boundary shared by
// process census and machine vitals.
package main

import (
	"fmt"
	"syscall"
	"unsafe"
)

const ctlKern = 1

// callSysctl performs one numeric-MIB sysctl(2) with the caller's buffer. The
// kernel writes the returned byte count through sizePtr.
func callSysctl(mib []uint32, old []byte, size *uintptr) error {
	var oldPtr uintptr
	if old != nil {
		oldPtr = uintptr(unsafe.Pointer(&old[0]))
	}
	_, _, errno := syscall.Syscall6(
		syscall.SYS___SYSCTL,
		uintptr(unsafe.Pointer(&mib[0])),
		uintptr(len(mib)),
		oldPtr,
		uintptr(unsafe.Pointer(size)),
		0,
		0,
	)
	if errno != 0 {
		return errno
	}
	return nil
}

// Windows Job Object commands are intentionally unavailable on Darwin. Keep
// the command surface total so the shared main dispatcher compiles while each
// platform still fails closed outside its owned primitive.
func runCustodyCommand(args []string) error {
	return fmt.Errorf("Windows job custody is unavailable on Darwin")
}

func terminateCustodyJob(args []string) error {
	return fmt.Errorf("Windows job custody is unavailable on Darwin")
}

func queryCustodyJob(args []string) error {
	return fmt.Errorf("Windows job custody is unavailable on Darwin")
}

// sysctlBuffer returns the exact bytes of one numeric-MIB sysctl node: a size
// probe first, then a second call into an exactly-sized buffer.
func sysctlBuffer(mib []uint32) ([]byte, error) {
	var size uintptr
	if err := callSysctl(mib, nil, &size); err != nil {
		return nil, err
	}
	if size == 0 {
		return []byte{}, nil
	}
	buffer := make([]byte, size)
	if err := callSysctl(mib, buffer, &size); err != nil {
		return nil, err
	}
	if uintptr(len(buffer)) < size {
		return nil, fmt.Errorf("sysctl mib %v shrank below its probed size", mib)
	}
	return buffer[:size], nil
}
