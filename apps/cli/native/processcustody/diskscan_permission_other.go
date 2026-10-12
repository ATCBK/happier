//go:build !darwin

package main

import "context"

func diskEmitPermission(ctx context.Context, emit func(any) error) error {
	record, err := diskPermissionIdentity("not_applicable")
	if err != nil {
		return err
	}
	return emit(record)
}
