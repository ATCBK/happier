//go:build windows

package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

func TestWindowsCensusObservesExplicitLegacyJob(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	member := exec.Command(executable, "-test.run=^TestOwnerHeldJobSubprocess$", "--", "member")
	stdout, err := member.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := member.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = member.Process.Kill(); _ = member.Wait() }()
	if _, err := bufio.NewReader(stdout).ReadString('\n'); err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf(`Local\happier-svc09-explicit-%d-%d`, os.Getpid(), time.Now().UnixNano())
	wide, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		t.Fatal(err)
	}
	job, _, callErr := procCreateJobObjectW.Call(0, uintptr(unsafe.Pointer(wide)))
	if job == 0 {
		t.Fatal(callErr)
	}
	defer procCloseHandle.Call(job)
	// A same-namespace non-Job object makes OpenJobObject fail, not prove
	// absence. This is a real unavailable boundary, not a mocked membership.
	eventName, err := syscall.UTF16PtrFromString(name + "-event")
	if err != nil {
		t.Fatal(err)
	}
	event, _, err := kernel32.NewProc("CreateEventW").Call(0, 0, 0, uintptr(unsafe.Pointer(eventName)))
	if event == 0 {
		t.Fatal(err)
	}
	defer procCloseHandle.Call(event)
	target, err := syscall.OpenProcess(0x100|0x1, false, uint32(member.Process.Pid))
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(target)
	if ok, _, err := procAssignProcessToJobObject.Call(job, uintptr(target)); ok == 0 {
		t.Fatal(err)
	}
	// There is no canonical owner marker or resident helper to carry this
	// independently held incumbent Job name into an ordinary filtered census.
	output := ownerHeldJobCommand(t, "process-census", "--pids="+strconv.Itoa(os.Getpid()), "--job="+name, "--job="+name+"-absent", "--job="+name+"-event")
	var snapshot map[string]json.RawMessage
	if err := json.Unmarshal(output, &snapshot); err != nil {
		t.Fatal(err)
	}
	var observations []struct {
		Name  string
		State string
		Pids  []int
	}
	if err := json.Unmarshal(snapshot["jobObservations"], &observations); err != nil {
		t.Fatal(err)
	}
	if len(observations) != 3 || observations[0].Name != name || observations[0].State != "live" || !reflect.DeepEqual(observations[0].Pids, []int{member.Process.Pid}) || observations[1].State != "absent" || observations[2].State != "unavailable" {
		t.Fatalf("explicit membership not complete: %s", output)
	}
	var decoded censusSnapshot
	if err := json.Unmarshal(output, &decoded); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, row := range decoded.Rows {
		if row.Pid == member.Process.Pid && reflect.DeepEqual(row.Jobs, []string{name}) && row.Principal != nil && row.Start.StartTimeMs > 0 {
			found = true
		}
	}
	if !found {
		t.Fatalf("member outside PID filter not enriched: %s", output)
	}
	if err := member.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = member.Wait()
	output = ownerHeldJobCommand(t, "process-census", "--pids="+strconv.Itoa(os.Getpid()), "--job="+name)
	if !strings.Contains(string(output), `"state":"absent"`) {
		t.Fatalf("held empty Job not absent: %s", output)
	}
}

func TestOwnerHeldJobSubprocess(t *testing.T) {
	for i, arg := range os.Args {
		if arg != "--" || i+1 >= len(os.Args) {
			continue
		}
		switch os.Args[i+1] {
		case "native":
			os.Args = append([]string{os.Args[0]}, os.Args[i+2:]...)
			main()
			os.Exit(0)
		case "member":
			fmt.Fprintln(os.Stdout, os.Getpid())
			// The fixture must outlive holder Wait closing its inherited stdin.
			// Only this test's exact process handle disposes the survivor.
			for {
				time.Sleep(time.Hour)
			}
		case "holder":
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			join := exec.Command(executable, "-test.run=^TestOwnerHeldJobSubprocess$", "--", "native", "job-join", "--job="+os.Args[i+2], "--pid="+strconv.Itoa(os.Getpid()), "--holder-pid="+strconv.Itoa(os.Getpid()))
			output, err := join.CombinedOutput()
			if err != nil {
				t.Fatalf("join owner: %s %v", output, err)
			}
			if i+3 < len(os.Args) {
				// Mirrors the host's same-runner Session binding change: only
				// the current marker changes; Job membership is not removable.
				if err := os.Setenv("HAPPIER_PROCESS_OWNER", os.Args[i+3]); err != nil {
					t.Fatal(err)
				}
			}
			child := exec.Command(executable, "-test.run=^TestOwnerHeldJobSubprocess$", "--", "member")
			child.Stdin, child.Stdout, child.Stderr = os.Stdin, os.Stdout, os.Stderr
			if err := child.Start(); err != nil {
				t.Fatal(err)
			}
			fmt.Fprintln(os.Stdout, "holder-joined")
			_ = child.Wait()
			os.Exit(0)
		}
	}
}

func TestWindowsOwnerTagChangeDoesNotMoveExistingJob(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	oldTag := fmt.Sprintf("v1.0123456789ab.session.old-%d-%d", os.Getpid(), time.Now().UnixNano())
	newTag := "v1.0123456789ab.session.current"
	jobName := censusWindowsOwnerJobName(oldTag)
	holder := exec.Command(executable, "-test.run=^TestOwnerHeldJobSubprocess$", "--", "holder", jobName, newTag)
	holder.Env = append(os.Environ(), "HAPPIER_PROCESS_OWNER="+oldTag)
	stdout, err := holder.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := holder.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = holder.Process.Kill(); _ = holder.Wait() }()
	reader := bufio.NewReader(stdout)
	childPid := 0
	for i := 0; i < 2; i++ {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if pid, err := strconv.Atoi(strings.TrimSpace(line)); err == nil {
			childPid = pid
		}
	}
	if childPid == 0 {
		t.Fatal("child pid absent")
	}
	child, err := os.FindProcess(childPid)
	if err != nil {
		t.Fatal(err)
	}
	defer child.Kill()
	var snapshot censusSnapshot
	if err := json.Unmarshal(ownerHeldJobCommand(t, "process-census", "--pids="+strconv.Itoa(childPid)), &snapshot); err != nil {
		t.Fatal(err)
	}
	foundCurrent := false
	for _, row := range snapshot.Rows {
		if row.Pid == childPid && row.OwnerTag == newTag {
			foundCurrent = true
		}
	}
	if !foundCurrent {
		t.Fatalf("current tag missing: %+v", snapshot.Rows)
	}
	query := ownerHeldJobCommand(t, "query", "--job="+jobName)
	if !strings.Contains(string(query), `"state":"live"`) || !strings.Contains(string(query), `"members":2`) {
		t.Fatalf("original fence changed: %s", query)
	}
	t.Logf("current-tag child %d still belongs to original Job; tag change is not a fence move", childPid)
}

func ownerHeldJobCommand(t *testing.T, args ...string) []byte {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	output, err := exec.Command(executable, append([]string{"-test.run=^TestOwnerHeldJobSubprocess$", "--", "native"}, args...)...).CombinedOutput()
	if err != nil {
		t.Fatalf("native %v: %s %v", args, output, err)
	}
	return output
}

func TestWindowsCensusReadsOwnerEnvironment(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	child := exec.Command(executable, "-test.run=^TestOwnerHeldJobSubprocess$", "--", "member")
	// Exceed an OS page and include surrogate pairs: no local environment
	// size guess or byte/UTF-16 truncation may hide an owner's marker.
	const tag = "v1.0123456789ab.session.owner-census-雪-😀"
	child.Env = append(os.Environ(), "AAA_LONG_FIXTURE="+strings.Repeat("雪😀", 4096), "HAPPIER_PROCESS_OWNER="+tag, "HAPPIER_HOME_DIR=C:\\Users\\test_qa\\雪", "UNRELATED_SECRET=must-not-be-returned")
	stdin, err := child.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	stdout, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = child.Process.Kill(); _ = child.Wait() }()
	if _, err := bufio.NewReader(stdout).ReadString('\n'); err != nil {
		t.Fatal(err)
	}
	output := ownerHeldJobCommand(t, "process-census", "--pids="+strconv.Itoa(child.Process.Pid))
	var snapshot censusSnapshot
	if err := json.Unmarshal(output, &snapshot); err != nil {
		t.Fatal(err)
	}
	for _, row := range snapshot.Rows {
		if row.Pid == child.Process.Pid {
			if row.OwnerTag != tag {
				t.Fatalf("own-principal marker absent: %+v", row)
			}
			if row.OwnershipEnvironment["HAPPIER_HOME_DIR"] != `C:\Users\test_qa\雪` {
				t.Fatalf("ownership environment lost: %+v", row)
			}
			if strings.Contains(string(output), "must-not-be-returned") {
				t.Fatal("unallowlisted env disclosed")
			}
			return
		}
	}
	t.Fatal("owned child absent")
}

func TestWindowsCensusReadsWOW64OwnerEnvironment(t *testing.T) {
	executable := os.Getenv("HAPPIER_CENSUS_TEST_X86")
	if executable == "" {
		t.Skip("native WOW64 fixture supplied by Windows architecture lane")
	}
	child := exec.Command(executable, "-test.run=^TestOwnerHeldJobSubprocess$", "--", "member")
	const tag = "v1.0123456789ab.session.owner-wow64"
	child.Env = append(os.Environ(), "HAPPIER_PROCESS_OWNER="+tag)
	stdout, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = child.Process.Kill(); _ = child.Wait() }()
	if _, err := bufio.NewReader(stdout).ReadString('\n'); err != nil {
		t.Fatal(err)
	}
	var snapshot censusSnapshot
	if err := json.Unmarshal(ownerHeldJobCommand(t, "process-census", "--pids="+strconv.Itoa(child.Process.Pid)), &snapshot); err != nil {
		t.Fatal(err)
	}
	for _, row := range snapshot.Rows {
		if row.Pid == child.Process.Pid && row.OwnerTag == tag {
			return
		}
	}
	t.Fatalf("WOW64 marker unavailable: %+v", snapshot.Rows)
}

func TestWindowsCensusRefusesInvalidEnvironmentPrincipal(t *testing.T) {
	if _, _, err := censusWindowsEnvironment(os.Getpid(), &censusPrincipal{Kind: "windows-sid", Value: "S-1-0-0"}); err == nil {
		t.Fatal("foreign principal accepted")
	}
}

func TestWindowsJoinAssignsIntoExistingHolder(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	member := exec.Command(executable, "-test.run=^TestOwnerHeldJobSubprocess$", "--", "member")
	tag := fmt.Sprintf("v1.0123456789ab.terminal.join-%d", os.Getpid())
	member.Env = append(os.Environ(), "HAPPIER_PROCESS_OWNER="+tag)
	stdin, err := member.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	stdout, err := member.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := member.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = member.Process.Kill(); _ = member.Wait() }()
	if _, err := bufio.NewReader(stdout).ReadString('\n'); err != nil {
		t.Fatal(err)
	}
	jobName := censusWindowsOwnerJobName(tag)
	// PID reuse must not assign an unrelated current generation merely because
	// the PID still names an own-principal process.
	mismatch := exec.Command(executable, "-test.run=^TestOwnerHeldJobSubprocess$", "--", "native", "job-join", "--job="+censusWindowsOwnerJobName(tag+".other"), "--pid="+strconv.Itoa(member.Process.Pid), "--holder-pid="+strconv.Itoa(os.Getpid()))
	if output, err := mismatch.CombinedOutput(); err == nil || !strings.Contains(string(output), "target ownership tag changed or unavailable") {
		t.Fatalf("mismatched owner assigned: %s %v", output, err)
	}
	output := ownerHeldJobCommand(t, "job-join", "--job="+jobName, "--pid="+strconv.Itoa(member.Process.Pid), "--holder-pid="+strconv.Itoa(os.Getpid()))
	var joined struct {
		State             string
		HolderHandle      string
		HolderStartTimeMs int64
	}
	if err := json.Unmarshal(output, &joined); err != nil || joined.State != "joined" || joined.HolderHandle == "" {
		t.Fatalf("join outcome: %s %v", output, err)
	}
	query := ownerHeldJobCommand(t, "query", "--job="+jobName)
	if !strings.Contains(string(query), `"state":"live"`) {
		t.Fatalf("holder lost membership: %s", query)
	}
	// A reused PID must not turn an old custody closure into authority to close
	// a handle in the new generation. A rejected release preserves the Job.
	wrong := exec.Command(executable, "-test.run=^TestOwnerHeldJobSubprocess$", "--", "native", "job-release", "--holder-pid="+strconv.Itoa(os.Getpid()), "--holder-handle="+joined.HolderHandle, "--holder-start-time-ms="+strconv.FormatInt(joined.HolderStartTimeMs+1, 10))
	if output, err := wrong.CombinedOutput(); err == nil || !strings.Contains(string(output), "holder generation changed") {
		t.Fatalf("wrong generation accepted: %s %v", output, err)
	}
	if query = ownerHeldJobCommand(t, "query", "--job="+jobName); !strings.Contains(string(query), `"state":"live"`) {
		t.Fatalf("wrong generation closed holder handle: %s", query)
	}
	// A manual session bind can repeat the earliest runner self-join. This
	// must recognize exact membership rather than attempt to reassign it.
	secondOutput := ownerHeldJobCommand(t, "job-join", "--job="+jobName, "--pid="+strconv.Itoa(member.Process.Pid), "--holder-pid="+strconv.Itoa(os.Getpid()))
	var second struct {
		HolderHandle      string
		HolderStartTimeMs int64
	}
	if err := json.Unmarshal(secondOutput, &second); err != nil {
		t.Fatal(err)
	}
	ownerHeldJobCommand(t, "job-release", "--holder-pid="+strconv.Itoa(os.Getpid()), "--holder-handle="+second.HolderHandle, "--holder-start-time-ms="+strconv.FormatInt(second.HolderStartTimeMs, 10))
	terminated := ownerHeldJobCommand(t, "terminate", "--job="+jobName)
	if !strings.Contains(string(terminated), `"state":"absent"`) {
		t.Fatalf("held Job did not settle: %s", terminated)
	}
	if err := member.Wait(); err == nil {
		t.Fatal("native terminate did not end the indefinitely live member")
	}
	ownerHeldJobCommand(t, "job-release", "--holder-pid="+strconv.Itoa(os.Getpid()), "--holder-handle="+joined.HolderHandle, "--holder-start-time-ms="+strconv.FormatInt(joined.HolderStartTimeMs, 10))
	query = ownerHeldJobCommand(t, "query", "--job="+jobName)
	if !strings.Contains(string(query), `"state":"absent"`) {
		t.Fatalf("released handle leaked: %s", query)
	}
}

func TestWindowsOwnerHeldJobSurvivesHelperExitAndFallsBackAfterHolderDeath(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	tag := fmt.Sprintf("v1.0123456789ab.session.owner-held-%d-%d", os.Getpid(), time.Now().UnixNano())
	jobName := censusWindowsOwnerJobName(tag)
	holder := exec.Command(executable, "-test.run=^TestOwnerHeldJobSubprocess$", "--", "holder", jobName)
	holder.Env = append(os.Environ(), "HAPPIER_PROCESS_OWNER="+tag)
	stdin, err := holder.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	stdout, err := holder.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	holder.Stderr = os.Stderr
	if err := holder.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = holder.Process.Kill(); _ = holder.Wait() }()
	reader := bufio.NewReader(stdout)
	childPid := 0
	for i := 0; i < 2; i++ {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("holder startup: %q %v", line, err)
		}
		if pid, err := strconv.Atoi(strings.TrimSpace(line)); err == nil {
			childPid = pid
		}
	}
	if childPid == 0 {
		t.Fatal("child pid missing")
	}
	child, err := syscall.OpenProcess(0x00100000|0x0001, false, uint32(childPid))
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(child)
	defer procTerminateProcess.Call(uintptr(child), 1)
	// Each query runs in a fresh process; neither the join helper nor a daemon
	// retains its original handle. A replacement daemon can reopen by name.
	for i := 0; i < 2; i++ {
		output := ownerHeldJobCommand(t, "query", "--job="+jobName)
		if !strings.Contains(string(output), `"state":"live"`) {
			t.Fatalf("replacement observer lost Job: %s", output)
		}
	}
	before := ownerHeldJobCommand(t, "process-census", "--pids="+strconv.Itoa(childPid))
	if !strings.Contains(string(before), `"jobs":[`) {
		t.Fatalf("owner-held Job undiscovered: %s", before)
	}
	if err := holder.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = holder.Wait()
	if result, _, err := procWaitForSingleObject.Call(uintptr(child), 0); result != 258 {
		t.Fatalf("child died with holder: %d %v", result, err)
	}
	after := ownerHeldJobCommand(t, "process-census", "--pids="+strconv.Itoa(childPid))
	var snapshot censusSnapshot
	if err := json.Unmarshal(after, &snapshot); err != nil {
		t.Fatal(err)
	}
	for _, row := range snapshot.Rows {
		if row.Pid == childPid {
			if row.OwnerTag != tag || len(row.Jobs) != 0 {
				t.Fatalf("holder-death fallback wrong: %+v", row)
			}
			t.Logf("holder exited; member %d remains live, ownerTag recovered, named Job absent", childPid)
			return
		}
	}
	t.Fatal("surviving child absent")
}
