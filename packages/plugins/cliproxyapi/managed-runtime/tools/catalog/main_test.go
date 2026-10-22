package main

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"testing"
)

func TestGeneratedCatalogMatchesPinnedSDKSource(t *testing.T) {
	data, err := exec.Command("go", "list", "-m", "-json", sdkModule).Output()
	if err != nil {
		t.Fatal(err)
	}
	var module struct{ Dir, Version string }
	if err := json.Unmarshal(data, &module); err != nil {
		t.Fatal(err)
	}
	want, err := generate(module.Dir, module.Version)
	if err != nil {
		t.Fatal(err)
	}
	var rows map[string][]struct {
		ID           string            `json:"id"`
		Capabilities map[string]string `json:"capabilities"`
		ModelOptions []struct {
			ID      string `json:"id"`
			Options []struct {
				Value string `json:"value"`
			} `json:"options"`
		} `json:"modelOptions"`
	}
	modelJSON := strings.SplitN(string(want), "export const CLIPROXYAPI_STATIC_MODELS = ", 2)[1]
	if err := json.Unmarshal([]byte(strings.SplitN(modelJSON, " satisfies ", 2)[0]), &rows); err != nil {
		t.Fatal(err)
	}
	images := map[string]bool{"gpt-image-1.5": false, "gpt-image-2": false}
	for _, row := range rows["codex"] {
		if _, image := images[row.ID]; image {
			images[row.ID] = true
			if row.Capabilities["toolRoundTrips"] != "unsupported" {
				t.Errorf("image model %s toolRoundTrips = %q, want unsupported", row.ID, row.Capabilities["toolRoundTrips"])
			}
		} else if row.Capabilities["toolRoundTrips"] != "unknown" {
			t.Errorf("chat model %s must retain unknown tool support", row.ID)
		}
		if row.ID != "gpt-5.5" {
			continue
		}
		var levels []string
		for _, option := range row.ModelOptions {
			if option.ID == "reasoning_effort" {
				for _, choice := range option.Options {
					levels = append(levels, choice.Value)
				}
			}
		}
		if !reflect.DeepEqual(levels, []string{"low", "medium", "high", "xhigh"}) {
			t.Fatalf("generated gpt-5.5 effort choices = %v, want exact pinned SDK levels", levels)
		}
	}
	for id, found := range images {
		if !found {
			t.Errorf("missing pinned image model %s", id)
		}
	}
	got, err := os.ReadFile("../../../src/provider/staticModels.generated.ts")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatal("static model output is stale: run go -C managed-runtime run ./tools/catalog from the plugin root")
	}
}
