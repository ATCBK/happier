//go:build linux

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

type scopeExitEvidence struct {
	V       int    `json:"v"`
	Unit    string `json:"unit"`
	Path    string `json:"path,omitempty"`
	Status  string `json:"status"`
	Oom     uint64 `json:"oom"`
	OomKill uint64 `json:"oomKill"`
}

// One exit read while this launch wrapper still holds membership in the same scope.
// It changes neither OOM policy nor collection and never observes another scope.
func captureScopeExitMemory(unit string) scopeExitEvidence {
	evidence := scopeExitEvidence{V: 1, Unit: unit, Status: "unavailable"}
	membership, err := os.ReadFile("/proc/self/cgroup")
	if err != nil {
		return evidence
	}
	for _, line := range strings.Split(string(membership), "\n") {
		if !strings.HasPrefix(line, "0::/") {
			continue
		}
		relative := strings.TrimPrefix(line, "0::")
		if filepath.Base(relative) != unit {
			return evidence
		}
		evidence.Path = filepath.Join("/sys/fs/cgroup", relative)
		counters, err := os.ReadFile(filepath.Join(evidence.Path, "memory.events"))
		if err != nil {
			return evidence
		}
		foundOom, foundKill := false, false
		for _, counter := range strings.Split(string(counters), "\n") {
			fields := strings.Fields(counter)
			if len(fields) != 2 || fields[0] != "oom" && fields[0] != "oom_kill" {
				continue
			}
			value, err := strconv.ParseUint(fields[1], 10, 64)
			if err != nil {
				return evidence
			}
			if fields[0] == "oom" {
				evidence.Oom = value
				foundOom = true
			} else {
				evidence.OomKill = value
				foundKill = true
			}
		}
		if foundOom && foundKill {
			evidence.Status = "captured"
		}
		return evidence
	}
	return evidence
}

func scopeExitCommand(args []string) error {
	var unit, evidencePath string
	var target []string
	for i, arg := range args {
		if arg == "--" {
			target = args[i+1:]
			break
		}
		if strings.HasPrefix(arg, "--unit=") {
			unit = strings.TrimPrefix(arg, "--unit=")
		} else if strings.HasPrefix(arg, "--evidence=") {
			evidencePath = strings.TrimPrefix(arg, "--evidence=")
		} else {
			return errors.New("invalid scope exit argument")
		}
	}
	if unit == "" || filepath.Base(unit) != unit || !strings.HasSuffix(unit, ".scope") || !filepath.IsAbs(evidencePath) || len(target) == 0 {
		return errors.New("scope exit requires exact scope, absolute evidence path and target")
	}
	// An exclusive private leaf prevents reuse or redirection of this launch's evidence.
	evidence, err := os.OpenFile(evidencePath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return fmt.Errorf("scope exit evidence unavailable: %w", err)
	}
	defer evidence.Close()
	command := exec.Command(target[0], target[1:]...)
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer signal.Stop(signals)
	if err := command.Start(); err != nil {
		return err
	}
	done := make(chan struct{})
	go func() {
		for {
			select {
			case received := <-signals:
				_ = command.Process.Signal(received)
			case <-done:
				return
			}
		}
	}()
	exit := command.Wait()
	close(done)
	captured := captureScopeExitMemory(unit)
	if err := json.NewEncoder(evidence).Encode(captured); err != nil {
		return err
	}
	if err := evidence.Close(); err != nil {
		return err
	}
	if exit == nil {
		return nil
	}
	var exited *exec.ExitError
	if !errors.As(exit, &exited) {
		return exit
	}
	status := exited.Sys().(syscall.WaitStatus)
	if status.Signaled() {
		os.Exit(128 + int(status.Signal()))
	}
	os.Exit(exited.ExitCode())
	return nil
}
