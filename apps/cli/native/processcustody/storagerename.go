package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

type storageRenameRequest struct {
	SourcePath       string                 `json:"sourcePath"`
	TargetPath       string                 `json:"targetPath"`
	ExpectedIdentity *storageRenameIdentity `json:"expectedIdentity,omitempty"`
}

type storageRenameIdentity struct {
	Dev string `json:"dev"`
	Ino string `json:"ino"`
}

var storageRenameChanged = errors.New("storage source changed since review")

func (identity *storageRenameIdentity) matches(dev, ino string) bool {
	return identity == nil || (identity.Dev == dev && identity.Ino == ino)
}

type storageRenameResult struct {
	V       int    `json:"v"`
	Status  string `json:"status"`
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

// Storage owns authorization and source identity. This boundary performs only
// a same-volume leaf rename whose OS primitive cannot replace a destination.
func storageRenameCommand(args []string, input io.Reader, output io.Writer) error {
	if len(args) != 0 {
		return fmt.Errorf("storage-rename takes no arguments")
	}
	var request storageRenameRequest
	decoder := json.NewDecoder(input)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return fmt.Errorf("storage-rename requires one JSON request")
	}
	var err error
	request.SourcePath, err = diskPathFromID(request.SourcePath)
	if err != nil {
		return err
	}
	request.TargetPath, err = diskPathFromID(request.TargetPath)
	if err != nil {
		return err
	}
	for _, path := range []string{request.SourcePath, request.TargetPath} {
		if !filepath.IsAbs(path) || strings.ContainsRune(path, 0) {
			return fmt.Errorf("storage-rename requires absolute paths")
		}
	}
	result := storageRenameResult{V: 1, Status: "renamed"}
	if err := renameStorageLeafNoReplace(request.SourcePath, request.TargetPath, request.ExpectedIdentity); err != nil {
		result.Status = "failed"
		result.Code = "storage_rename_failed"
		result.Message = err.Error()
		if errors.Is(err, os.ErrExist) {
			result.Code = "destination_occupied"
		}
		if errors.Is(err, storageRenameChanged) {
			result.Code = "changed_since_review"
		}
	}
	return json.NewEncoder(output).Encode(result)
}
