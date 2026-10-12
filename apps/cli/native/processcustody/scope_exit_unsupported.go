//go:build !linux

package main

import "errors"

func scopeExitCommand(_ []string) error {
	return errors.New("scope exit memory evidence is only available on Linux")
}
