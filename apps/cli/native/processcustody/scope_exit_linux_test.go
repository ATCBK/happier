//go:build linux

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestScopeExitHogChild(t *testing.T) {
	if os.Getenv("HAPPIER_SCOPE_EXIT_HOG") != "1" {
		t.Skip("owned native OOM child only")
	}
	pages := make([][]byte, 0)
	for {
		page := make([]byte, 8*1024*1024)
		for i := range page {
			page[i] = byte(i + 1)
		}
		pages = append(pages, page)
		runtime.KeepAlive(pages)
	}
}

func TestScopeExitCapturesBeforeCollection(t *testing.T) {
	helper := os.Getenv("HAPPIER_SCOPE_EXIT_HELPER")
	if helper == "" {
		t.Skip("requires freshly built native helper and a user manager")
	}
	// The hard boundary induces kernel OOM independently of Happier's soft ceiling.
	// Keep the configured ceiling above that test-only bound so throttling cannot park the allocator.
	for _, high := range []string{"infinity", "134217728"} {
		t.Run(high, func(t *testing.T) {
			unit := fmt.Sprintf("happier-fx35-oom-%d-%d.scope", os.Getpid(), time.Now().UnixNano())
			evidence := filepath.Join(t.TempDir(), "exit.json")
			command := exec.Command("systemd-run", "--user", "--scope", "--quiet", "--collect", "--unit="+unit,
				"-p", "MemoryMax=67108864", "-p", "MemoryHigh="+high,
				"--", helper, "scope-exec", "--unit="+unit, "--evidence="+evidence,
				"--", os.Args[0], "-test.run=^TestScopeExitHogChild$")
			command.Env = append(os.Environ(), "HAPPIER_SCOPE_EXIT_HOG=1")
			output, err := command.CombinedOutput()
			if err == nil {
				t.Fatalf("owned memory hog unexpectedly survived: %s", output)
			}
			raw, readErr := os.ReadFile(evidence)
			if readErr != nil {
				t.Fatalf("scope exit failed to capture evidence before collection: %v; output=%s", readErr, output)
			}
			var captured struct {
				V       int    `json:"v"`
				Unit    string `json:"unit"`
				Path    string `json:"path"`
				Oom     uint64 `json:"oom"`
				OomKill uint64 `json:"oomKill"`
			}
			if err := json.Unmarshal(raw, &captured); err != nil {
				t.Fatal(err)
			}
			if captured.V != 1 || captured.Unit != unit || captured.Oom == 0 || captured.OomKill == 0 {
				t.Fatalf("missing positive exact-scope OOM attribution: %s", raw)
			}
			show, err := exec.Command("systemctl", "--user", "show", unit, "--property=LoadState").CombinedOutput()
			if err != nil || !strings.Contains(string(show), "LoadState=not-found") {
				t.Fatalf("scope not collected: %s, %v", show, err)
			}
			if _, err := os.ReadFile(filepath.Join(captured.Path, "memory.events")); !os.IsNotExist(err) {
				t.Fatalf("expected collected memory.events; path=%s err=%v", captured.Path, err)
			}
			t.Logf("unit=%s high=%s oom=%d oom_kill=%d collected=true", unit, high, captured.Oom, captured.OomKill)
		})
	}
}

func TestScopeExitDoesNotInferOomFromSigkill(t *testing.T) {
	helper := os.Getenv("HAPPIER_SCOPE_EXIT_HELPER")
	if helper == "" {
		t.Skip("requires freshly built native helper and a user manager")
	}
	unit := fmt.Sprintf("happier-fx35-signal-%d-%d.scope", os.Getpid(), time.Now().UnixNano())
	evidence := filepath.Join(t.TempDir(), "exit.json")
	command := exec.Command("systemd-run", "--user", "--scope", "--quiet", "--collect", "--unit="+unit,
		"--", helper, "scope-exec", "--unit="+unit, "--evidence="+evidence, "--", "/bin/sh", "-c", "kill -KILL $$")
	if output, err := command.CombinedOutput(); err == nil {
		t.Fatalf("owned SIGKILL target survived: %s", output)
	}
	raw, err := os.ReadFile(evidence)
	if err != nil {
		t.Fatal(err)
	}
	var captured struct {
		Status  string `json:"status"`
		OomKill uint64 `json:"oomKill"`
	}
	if err := json.Unmarshal(raw, &captured); err != nil {
		t.Fatal(err)
	}
	if captured.Status != "captured" || captured.OomKill != 0 {
		t.Fatalf("SIGKILL is not OOM evidence: %s", raw)
	}
	t.Logf("unit=%s external_SIGKILL=true oom_kill=0", unit)
}
