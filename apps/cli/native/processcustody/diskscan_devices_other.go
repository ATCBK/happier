//go:build !darwin

package main

func diskScanAllowedDevices(root string) ([]string, error) {
	return nil, nil
}
