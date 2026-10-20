package main

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
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
	got, err := os.ReadFile("../../../src/provider/staticModels.generated.ts")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatal("static model output is stale: run go -C managed-runtime run ./tools/catalog from the plugin root")
	}
}
