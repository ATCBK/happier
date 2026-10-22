package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

// Metadata is collected without reading file contents. Platform leaves alone
// own allocation, identities, cloud-state and filesystem sharing evidence.
type diskMetadata struct {
	identity, device, kind             string
	allocatedBytes, logicalBytes       int64
	dataAllocatedBytes                 int64
	dataAllocationKnown                bool
	nlink                              uint64
	nlinkAttempted                     bool
	metadataReadError                  error
	mtimeMs                            int64
	cloudOnly, sharedExtentsUnmeasured bool
	cloneID                            string
	cloneRefCount                      uint64
	mayShareBlocks                     bool
	sharesAllBlocks                    bool
	privateBytes                       int64
	privateBytesKnown, extFlagsKnown   bool
}
type diskEntry struct {
	name, path string
	meta       diskMetadata
	err        error
}
type diskDirectory interface {
	metadata() diskMetadata
	entries(context.Context) ([]diskEntry, string, error)
	openChild(diskEntry) (diskDirectory, error)
	close() error
}

var diskOpenDirectoryForScan = diskOpenRoot

type diskMeasureRequest struct {
	Paths                []string           `json:"paths"`
	Unions               []diskMeasureUnion `json:"unions,omitempty"`
	MeasureSharedExtents bool               `json:"measureSharedExtents,omitempty"`
	LowPower             bool               `json:"lowPower,omitempty"`
}
type diskMeasureUnion struct {
	ID                string   `json:"id"`
	Paths             []string `json:"paths"`
	ExcludeIncomplete bool     `json:"excludeIncomplete,omitempty"`
}
type diskMeasuredUnion struct {
	ID                  string `json:"id"`
	TotalAllocatedBytes int64  `json:"totalAllocatedBytes"`
	TotalExclusiveBytes int64  `json:"totalExclusiveBytes"`
	AtLeast             bool   `json:"atLeast"`
}
type diskPreviousIndexError struct {
	message string
}

func (err *diskPreviousIndexError) Error() string {
	return err.message
}

// The daemon's SQLite owner streams this transient projection, not a second
// index. Fresh scans use ordering hints; relists reuse explicitly cached child
// aggregates without claiming their descendants were freshly observed.
type diskPriorObservation struct {
	path, key      string
	allocatedBytes int64
}
type diskPriorChild struct {
	identityKey                  string
	allocatedBytes, logicalBytes int64
	items                        int64
	flags                        diskFlags
	ageGroups                    diskAgeGroups
}

type diskPriorRow struct {
	V              int            `json:"v"`
	Type           string         `json:"type"`
	ID             string         `json:"id"`
	AllocatedBytes *int64         `json:"allocatedBytes,omitempty"`
	Key            string         `json:"key,omitempty"`
	LogicalBytes   *int64         `json:"logicalBytes,omitempty"`
	Items          *int64         `json:"items,omitempty"`
	IdentityKey    string         `json:"identityKey,omitempty"`
	Flags          *diskFlags     `json:"flags,omitempty"`
	AgeGroupBytes  *diskAgeGroups `json:"ageGroupBytes,omitempty"`
}

func diskReadPrevious(path, root string, resume bool, visit func(diskPriorRow, string) error) error {
	fail := func(err error) error {
		return &diskPreviousIndexError{message: err.Error()}
	}
	if !filepath.IsAbs(path) {
		return fail(errors.New("previous index projection path must be absolute"))
	}
	file, err := os.Open(path)
	if err != nil {
		return fail(err)
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	for {
		var item diskPriorRow
		if err := decoder.Decode(&item); err == io.EOF {
			break
		} else if err != nil {
			return fail(err)
		}
		decoded, err := diskPathFromID(item.ID)
		if err != nil {
			return fail(err)
		}
		id := diskNormalizePath(decoded)
		if item.V != 1 || !filepath.IsAbs(id) || !diskPathContains(root, id) || (item.Type != "prior-frontier" && (item.AllocatedBytes == nil || *item.AllocatedBytes < 0 || *item.AllocatedBytes > (1<<53)-1)) {
			return fail(errors.New("invalid previous index projection row"))
		}
		switch item.Type {
		case "prior-dir":
			if item.Key != "" || item.LogicalBytes != nil || item.Items != nil || item.IdentityKey != "" || item.Flags != nil || item.AgeGroupBytes != nil {
				return fail(errors.New("unexpected prior directory observation key"))
			}
		case "prior-observation":
			if item.Key == "" || item.LogicalBytes != nil || item.Items != nil || item.IdentityKey != "" || item.Flags != nil || item.AgeGroupBytes != nil {
				return fail(errors.New("missing prior observation key"))
			}
		case "prior-child":
			validSize := func(value *int64) bool { return value != nil && *value >= 0 && *value <= (1<<53)-1 }
			// Resume reuses completed descendants at any depth; a one-folder
			// relist consumes only direct children. Neither includes the root.
			if id == root || !resume && filepath.Dir(id) != root || item.Key != "" || item.IdentityKey == "" || !validSize(item.LogicalBytes) || !validSize(item.Items) || item.Flags == nil || item.AgeGroupBytes == nil {
				return fail(errors.New("invalid previous child projection"))
			}
			groups := *item.AgeGroupBytes
			for _, value := range []int64{groups.Unknown, groups.Months3, groups.Months6, groups.Months12} {
				if value < 0 || value > (1<<53)-1 {
					return fail(errors.New("invalid previous direct child age projection"))
				}
			}
		case "prior-frontier":
			if item.AllocatedBytes != nil || item.Key != "" || item.LogicalBytes != nil || item.Items != nil || item.IdentityKey != "" || item.Flags != nil || item.AgeGroupBytes != nil {
				return fail(errors.New("invalid previous frontier projection"))
			}
		default:
			return fail(errors.New("invalid previous index projection type"))
		}
		if err := visit(item, id); err != nil {
			return err
		}
	}
	return nil
}

type diskScanRequest struct {
	measureLinkCounts    bool
	measureSharedExtents bool
	Root                 string           `json:"root"`
	ScratchDirectory     string           `json:"scratchDirectory"`
	RelistOnly           bool             `json:"relistOnly,omitempty"`
	PreviousIndexPath    string           `json:"previousIndexPath,omitempty"`
	ResumeFrom           []string         `json:"resumeFrom,omitempty"`
	SkippedPaths         []string         `json:"skippedPaths,omitempty"`
	PriorityHints        []string         `json:"priorityHints,omitempty"`
	AtomicRules          []diskAtomicRule `json:"atomicRules,omitempty"`
	KeepMinBytes         int64            `json:"keepMinBytes"`
	DrawableNodes        int64            `json:"drawableNodes,omitempty"`
	LowPower             bool             `json:"lowPower,omitempty"`
	UsedBytes            int64            `json:"usedBytes,omitempty"`
	AllowedDevices       []string         `json:"allowedDevices,omitempty"`
}

// The recognizer table supplies these verified predicates; the helper only
// evaluates directory/manifest metadata while traversing its existing owner.
type diskAtomicRule struct {
	Names               []string `json:"names,omitempty"`
	Manifests           []string `json:"manifests,omitempty"`
	ParentName          string   `json:"parentName,omitempty"`
	ManifestParentLevel int      `json:"manifestParentLevel,omitempty"`
	Paths               []string `json:"paths,omitempty"`
}

func diskAtomicDirectory(path string, rules []diskAtomicRule) bool {
	for _, rule := range rules {
		matches := func(values []string, value string) bool {
			for _, candidate := range values {
				if candidate == value || runtime.GOOS == "windows" && strings.EqualFold(candidate, value) {
					return true
				}
			}
			return false
		}
		if len(rule.Names) > 0 && !matches(rule.Names, filepath.Base(path)) {
			continue
		}
		if len(rule.Paths) > 0 && !matches(rule.Paths, diskNormalizePath(path)) {
			continue
		}
		if rule.ParentName != "" && !matches([]string{rule.ParentName}, filepath.Base(filepath.Dir(path))) {
			continue
		}
		if len(rule.Manifests) > 0 {
			parent := path
			levels := rule.ManifestParentLevel
			if levels == 0 {
				levels = 1
			}
			for level := 0; level < levels; level++ {
				parent = filepath.Dir(parent)
			}
			verified := false
			for _, name := range rule.Manifests {
				meta, err := diskReadMetadata(filepath.Join(parent, name))
				if err == nil && meta.kind == "file" && !meta.cloudOnly {
					verified = true
					break
				}
			}
			if !verified {
				continue
			}
		}
		return true
	}
	return false
}

type diskSize struct {
	Path                    string `json:"path"`
	AllocatedBytes          int64  `json:"allocatedBytes"`
	ExclusiveBytes          int64  `json:"exclusiveBytes"`
	FreesUpToBytes          *int64 `json:"freesUpToBytes,omitempty"`
	SharedBytes             int64  `json:"sharedBytes"`
	SharedExtentsUnmeasured bool   `json:"sharedExtentsUnmeasured"`
	Items                   int64  `json:"items"`
	AtLeast                 bool   `json:"atLeast"`
	LastChangedAtMs         *int64 `json:"lastChangedAtMs,omitempty"`
}
type diskMeasureResult struct {
	V                   int                 `json:"v"`
	PerPath             []diskSize          `json:"perPath"`
	TotalAllocatedBytes int64               `json:"totalAllocatedBytes"`
	TotalExclusiveBytes int64               `json:"totalExclusiveBytes"`
	Unions              []diskMeasuredUnion `json:"unions,omitempty"`
}
type diskFlags struct {
	AtLeast                 bool `json:"atLeast"`
	SharedExtentsUnmeasured bool `json:"sharedExtentsUnmeasured,omitempty"`
}
type diskNode struct {
	AllocationFacts []diskAllocationFact `json:"allocationFacts,omitempty"`
	ID              string               `json:"id"`
	Name            string               `json:"name"`
	NameBytes       string               `json:"nameBytes,omitempty"`
	Kind            string               `json:"kind"`
	AllocatedBytes  int64                `json:"allocatedBytes"`
	LogicalBytes    int64                `json:"logicalBytes"`
	Items           int64                `json:"items"`
	MtimeMs         int64                `json:"mtimeMs"`
	Flags           diskFlags            `json:"flags"`
	meta            diskMetadata
	rawPath         string
	retained        *diskPriorChild
}
type diskFolded struct {
	Items          int64 `json:"items"`
	AllocatedBytes int64 `json:"allocatedBytes"`
	LogicalBytes   int64 `json:"logicalBytes"`
}
type diskAgeGroups struct {
	Unknown  int64 `json:"unknown"`
	Months3  int64 `json:"months3"`
	Months6  int64 `json:"months6"`
	Months12 int64 `json:"months12"`
}
type diskDirRecord struct {
	AllocationFacts  []diskAllocationFact `json:"allocationFacts,omitempty"`
	OwnLogicalBytes  int64                `json:"ownLogicalBytes"`
	V                int                  `json:"v"`
	Type             string               `json:"type"`
	ID               string               `json:"id"`
	Parent           string               `json:"parent,omitempty"`
	Name             string               `json:"name"`
	NameBytes        string               `json:"nameBytes,omitempty"`
	AllocatedBytes   int64                `json:"allocatedBytes"`
	LogicalBytes     int64                `json:"logicalBytes"`
	Items            int64                `json:"items"`
	MtimeMs          int64                `json:"mtimeMs"`
	Flags            diskFlags            `json:"flags"`
	Children         []diskNode           `json:"children"`
	Files            []diskNode           `json:"files"`
	Folded           diskFolded           `json:"folded"`
	AgeGroupBytes    diskAgeGroups        `json:"ageGroupBytes"`
	Complete         bool                 `json:"complete"`
	Enumerated       bool                 `json:"enumerated"`
	Summarized       bool                 `json:"summarized,omitempty"`
	Streamed         bool                 `json:"streamed,omitempty"`
	RelistOnly       bool                 `json:"-"`
	DirectChildIDs   *[]string            `json:"directChildIds,omitempty"`
	RetainedSubtrees []string             `json:"retainedSubtrees,omitempty"`
	meta             diskMetadata
	rawPath          string
	atomicParent     string
}
type diskIssue struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}
type diskProgress struct {
	V            int      `json:"v"`
	Type         string   `json:"type"`
	SizedBytes   int64    `json:"sizedBytes"`
	Items        int64    `json:"items"`
	CurrentPath  string   `json:"currentPath,omitempty"`
	Fraction     *float64 `json:"fraction,omitempty"`
	StuckSinceMs int64    `json:"stuckSinceMs,omitempty"`
}
type diskSummary struct {
	V                      int              `json:"v"`
	Type                   string           `json:"type"`
	Termination            string           `json:"termination"`
	Unreadable             []diskIssue      `json:"unreadable"`
	UnreadableCounts       map[string]int64 `json:"unreadableCounts"`
	Skipped                []diskIssue      `json:"skipped"`
	BackendByDirCounts     map[string]int64 `json:"backendByDirCounts"`
	AllocatedBytes         int64            `json:"allocatedBytes"`
	Items                  int64            `json:"items"`
	PendingFrontier        []string         `json:"pendingFrontier"`
	StreamedFrontier       bool             `json:"streamedFrontier,omitempty"`
	APFSLocalSnapshotCount *int64           `json:"apfsLocalSnapshotCount,omitempty"`
}
type diskObservation struct {
	path           string
	meta           diskMetadata
	roots          map[string]map[string]bool
	linkMetadata   map[string]diskMetadata
	allocationOnly bool
	extents        *diskMeasuredExtents
}
type diskMeasuredExtents struct {
	private, possible int64
	err               error
}
type diskWalkResult struct {
	observations map[string]*diskObservation
	summary      diskSummary
	incomplete   map[string]bool
	direct       map[string]*diskDirectMeasure
	aliases      map[string]string
}
type diskDirectMeasure struct {
	roots []string
	size  diskSize
}

type diskControl struct {
	mu      sync.RWMutex
	skipped map[string]bool
	changed chan struct{}
}

func (c *diskControl) skips(path string) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	for prefix := range c.skipped {
		if diskPathContains(prefix, path) {
			return true
		}
	}
	return false
}
func diskPathContains(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
func diskAllowedDevice(devices []string, device string) bool {
	for _, allowed := range devices {
		if allowed == device {
			return true
		}
	}
	return false
}
func diskDirectoryBoundary(device, parentDevice string, allowed []string, skip bool, reason string) (bool, string) {
	if device != parentDevice && !diskAllowedDevice(allowed, device) {
		return true, "foreign_device"
	}
	return skip, reason
}

func diskWorkerCount(lowPower bool) int {
	n := runtime.NumCPU() / 2
	if n < 2 {
		n = 2
	}
	if n > 8 {
		n = 8
	}
	if lowPower {
		n /= 2
		if n < 1 {
			n = 1
		}
	}
	return n
}
func diskDecodeRequest(input io.Reader, target any) error {
	decoder := json.NewDecoder(input)
	decoder.DisallowUnknownFields()
	return decoder.Decode(target)
}
func diskMeasureCommand(args []string, input io.Reader, output io.Writer) error {
	if len(args) != 0 {
		return errors.New("disk-measure takes its request on stdin")
	}
	var request diskMeasureRequest
	if err := diskDecodeRequest(input, &request); err != nil {
		return err
	}
	if request.Paths == nil {
		return errors.New("disk-measure requires paths")
	}
	for index, path := range request.Paths {
		decoded, err := diskPathFromID(path)
		if err != nil {
			return err
		}
		if !filepath.IsAbs(decoded) || strings.ContainsRune(decoded, 0) {
			return errors.New("disk-measure paths must be absolute")
		}
		request.Paths[index] = decoded
	}
	unionIDs := map[string]bool{}
	for index := range request.Unions {
		union := &request.Unions[index]
		if union.ID == "" || unionIDs[union.ID] || union.Paths == nil {
			return errors.New("invalid disk-measure union")
		}
		unionIDs[union.ID] = true
		for pathIndex, path := range union.Paths {
			decoded, err := diskPathFromID(path)
			if err != nil {
				return err
			}
			if !filepath.IsAbs(decoded) || strings.ContainsRune(decoded, 0) {
				return errors.New("disk-measure union paths must be absolute")
			}
			union.Paths[pathIndex] = decoded
		}
	}
	_ = diskSetBackgroundPriority()
	result, err := diskMeasure(context.Background(), request)
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(result)
}
func diskScanCommand(args []string, input io.Reader, output io.Writer) error {
	if len(args) != 0 {
		return errors.New("disk-scan takes its request on stdin")
	}
	reader := bufio.NewReader(input)
	initial, err := reader.ReadBytes('\n')
	if err != nil && err != io.EOF {
		return err
	}
	var request diskScanRequest
	if err = diskDecodeRequest(strings.NewReader(string(initial)), &request); err != nil {
		return err
	}
	request.Root, err = diskPathFromID(request.Root)
	if err != nil {
		return err
	}
	if !filepath.IsAbs(request.Root) || strings.ContainsRune(request.Root, 0) || request.KeepMinBytes < 0 || request.DrawableNodes < 0 || request.UsedBytes < 0 {
		return errors.New("invalid disk-scan request")
	}
	request.Root = diskNormalizePath(request.Root)
	// Only the native volume boundary decides which device crossings belong to
	// this APFS container. Every fresh, resumed and direct-relist command uses it.
	request.AllowedDevices, err = diskScanAllowedDevices(request.Root)
	if err != nil {
		return err
	}
	for index := range request.AtomicRules {
		rule := &request.AtomicRules[index]
		if len(rule.Names) == 0 && len(rule.Paths) == 0 || rule.ManifestParentLevel < 0 {
			return errors.New("invalid atomic summary descriptor")
		}
		for _, name := range append(append([]string{}, rule.Names...), rule.Manifests...) {
			if name == "" || filepath.Base(name) != name || name == "." || name == ".." {
				return errors.New("invalid atomic summary name")
			}
		}
		for pathIndex, path := range rule.Paths {
			decoded, err := diskPathFromID(path)
			if err != nil {
				return err
			}
			if !filepath.IsAbs(decoded) || !diskPathContains(request.Root, decoded) {
				return errors.New("atomic summary path outside root")
			}
			rule.Paths[pathIndex] = diskNormalizePath(decoded)
		}
	}
	if request.RelistOnly && request.ResumeFrom != nil {
		return errors.New("direct relist cannot resume a recursive scan frontier")
	}
	for index, hint := range request.PriorityHints {
		decoded, err := diskPathFromID(hint)
		if err != nil {
			return err
		}
		request.PriorityHints[index] = decoded
	}
	if request.ResumeFrom != nil {
		frontier := make([]string, 0, len(request.ResumeFrom))
		for _, path := range request.ResumeFrom {
			decoded, err := diskPathFromID(path)
			if err != nil {
				return err
			}
			path = decoded
			path = diskNormalizePath(path)
			if !filepath.IsAbs(path) || !diskPathContains(request.Root, path) {
				return errors.New("disk-scan resume frontier must be inside root")
			}
			frontier = append(frontier, path)
		}
		sort.Strings(frontier)
		request.ResumeFrom = []string{}
		for _, path := range frontier {
			covered := false
			for _, ancestor := range request.ResumeFrom {
				if diskPathContains(ancestor, path) {
					covered = true
					break
				}
			}
			if !covered {
				request.ResumeFrom = append(request.ResumeFrom, path)
			}
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	control := &diskControl{skipped: map[string]bool{}, changed: make(chan struct{}, 1)}
	if len(request.SkippedPaths) > 0 && request.ResumeFrom == nil {
		return errors.New("disk-scan skipped paths require same-scan resume")
	}
	for _, path := range request.SkippedPaths {
		decoded, err := diskPathFromID(path)
		if err != nil {
			return err
		}
		decoded = diskNormalizePath(decoded)
		if !filepath.IsAbs(decoded) || !diskPathContains(request.Root, decoded) {
			return errors.New("disk-scan skipped paths must be inside root")
		}
		control.skipped[decoded] = true
	}
	go func() {
		decoder := json.NewDecoder(reader)
		for {
			var command struct {
				Type string `json:"type"`
				Path string `json:"path"`
			}
			if decoder.Decode(&command) != nil {
				return
			}
			switch command.Type {
			case "cancel":
				cancel()
			case "skip":
				decoded, err := diskPathFromID(command.Path)
				if err != nil {
					continue
				}
				command.Path = decoded
				if filepath.IsAbs(command.Path) && diskPathContains(request.Root, command.Path) {
					control.mu.Lock()
					control.skipped[filepath.Clean(command.Path)] = true
					control.mu.Unlock()
					select {
					case control.changed <- struct{}{}:
					default:
					}
				}
			}
		}
	}()
	_ = diskSetBackgroundPriority()
	encoder := json.NewEncoder(output)
	if err := diskEmitPermission(ctx, func(record any) error { return encoder.Encode(record) }); err != nil {
		if errors.Is(err, context.Canceled) {
			summary := diskEmptySummary()
			summary.Termination = "cancelled"
			summary.PendingFrontier = []string{diskPathID(request.Root)}
			return encoder.Encode(summary)
		}
		return err
	}
	err = diskScanStream(ctx, control, request, func(record any) error {
		if summary, ok := record.(diskSummary); ok && ctx.Err() == nil {
			summary.APFSLocalSnapshotCount = diskReadLocalSnapshotCount(ctx, request.Root)
			record = summary
		}
		return encoder.Encode(record)
	})
	return err
}

func diskMeasure(ctx context.Context, request diskMeasureRequest) (diskMeasureResult, error) {
	rootSet := map[string]bool{}
	for _, path := range request.Paths {
		rootSet[diskNormalizePath(path)] = true
	}
	primaryRoots := diskMeasureRoots(request.Paths)
	for _, union := range request.Unions {
		for _, path := range union.Paths {
			rootSet[diskNormalizePath(path)] = true
		}
	}
	roots := make([]string, 0, len(rootSet))
	for path := range rootSet {
		roots = append(roots, path)
	}
	sort.Strings(roots)
	walk, err := diskWalk(ctx, roots, request.LowPower, diskScanRequest{measureLinkCounts: true, measureSharedExtents: request.MeasureSharedExtents})
	if err != nil {
		return diskMeasureResult{}, err
	}
	result := diskAggregateMeasure(walk, primaryRoots, request)
	incomplete := map[string]bool{}
	all := result
	if len(request.Unions) > 0 && len(roots) != len(primaryRoots) {
		all = diskAggregateMeasure(walk, roots, request)
	}
	for _, size := range all.PerPath {
		if size.AtLeast {
			path, _ := diskPathFromID(size.Path)
			incomplete[path] = true
		}
	}
	for _, union := range request.Unions {
		selected := []string{}
		atLeast := false
		for _, root := range diskMeasureRoots(union.Paths) {
			if incomplete[root] {
				atLeast = true
				if union.ExcludeIncomplete {
					continue
				}
			}
			selected = append(selected, root)
		}
		measured := diskAggregateMeasure(walk, selected, request)
		result.Unions = append(result.Unions, diskMeasuredUnion{union.ID, measured.TotalAllocatedBytes, measured.TotalExclusiveBytes, atLeast})
	}
	return result, nil
}
func diskMeasureRoots(paths []string) []string {
	set := map[string]bool{}
	for _, path := range paths {
		set[diskNormalizePath(path)] = true
	}
	roots := make([]string, 0, len(set))
	for root := range set {
		roots = append(roots, root)
	}
	sort.Strings(roots)
	return roots
}

func diskMeasureWinner(members []string, aliases map[string]string) string {
	physical := func(root string) string {
		if path := aliases[root]; path != "" {
			return path
		}
		return root
	}
	for _, candidate := range members {
		covered := false
		for _, other := range members {
			if diskPathContains(physical(candidate), physical(other)) && !diskPathContains(physical(other), physical(candidate)) {
				covered = true
				break
			}
		}
		if !covered {
			return candidate
		}
	}
	return members[0]
}

func diskAggregateMeasure(walk diskWalkResult, roots []string, request diskMeasureRequest) diskMeasureResult {
	result := diskMeasureResult{V: 1, PerPath: make([]diskSize, 0, len(roots))}
	byRoot := map[string]*diskSize{}
	for _, root := range roots {
		size := &diskSize{Path: diskPathID(root), AtLeast: walk.incomplete[root]}
		byRoot[root] = size
	}
	for _, direct := range walk.direct {
		members := []string{}
		for _, root := range direct.roots {
			if byRoot[root] != nil {
				members = append(members, root)
			}
		}
		if len(members) == 0 {
			continue
		}
		for _, root := range members {
			byRoot[root].Items += direct.size.Items
			if changed := direct.size.LastChangedAtMs; changed != nil && (byRoot[root].LastChangedAtMs == nil || *changed > *byRoot[root].LastChangedAtMs) {
				byRoot[root].LastChangedAtMs = diskInt64Pointer(*changed)
			}
		}
		winner := byRoot[diskMeasureWinner(members, walk.aliases)]
		winner.AllocatedBytes += direct.size.AllocatedBytes
		winner.ExclusiveBytes += direct.size.ExclusiveBytes
		winner.SharedBytes += direct.size.SharedBytes
		winner.AtLeast = winner.AtLeast || direct.size.AtLeast
		winner.SharedExtentsUnmeasured = winner.SharedExtentsUnmeasured || direct.size.SharedExtentsUnmeasured
		if direct.size.FreesUpToBytes != nil {
			if winner.FreesUpToBytes == nil {
				winner.FreesUpToBytes = diskInt64Pointer(0)
			}
			*winner.FreesUpToBytes += *direct.size.FreesUpToBytes
		}
		result.TotalAllocatedBytes += direct.size.AllocatedBytes
		result.TotalExclusiveBytes += direct.size.ExclusiveBytes
	}
	ids := make([]string, 0, len(walk.observations))
	for id := range walk.observations {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		observation := walk.observations[id]
		meta := observation.meta
		members := make([]string, 0, len(observation.roots))
		allLinks := map[string]bool{}
		for root, links := range observation.roots {
			if byRoot[root] == nil {
				continue
			}
			members = append(members, root)
			for link := range links {
				allLinks[link] = true
				if !observation.allocationOnly {
					changed := observation.linkMetadata[link].mtimeMs
					// Zero timestamps are unknown; JSON timestamps must remain
					// exact JavaScript integers. This uses already-observed metadata.
					if changed > 0 && changed <= (1<<53)-1 && (byRoot[root].LastChangedAtMs == nil || changed > *byRoot[root].LastChangedAtMs) {
						byRoot[root].LastChangedAtMs = diskInt64Pointer(changed)
					}
				}
			}
			if !observation.allocationOnly {
				byRoot[root].Items++
			}
		}
		if len(members) == 0 {
			continue
		}
		sort.Strings(members)
		winnerRoot := diskMeasureWinner(members, walk.aliases)
		winner := byRoot[winnerRoot]
		if meta.cloudOnly {
			continue
		}
		allocation := meta.allocatedBytes
		winner.AllocatedBytes += allocation
		result.TotalAllocatedBytes += allocation
		exclusive, upper := allocation, allocation
		if meta.privateBytesKnown {
			exclusive = meta.privateBytes
		}
		sharingUnmeasured := meta.sharedExtentsUnmeasured
		if meta.sharedExtentsUnmeasured || meta.mayShareBlocks && !meta.privateBytesKnown {
			exclusive = 0
		}
		if runtime.GOOS == "linux" && request.MeasureSharedExtents && meta.kind == "file" && meta.sharedExtentsUnmeasured {
			if observation.extents == nil {
				private, possible, err := diskMeasureSharedExtents(observation.path, meta)
				observation.extents = &diskMeasuredExtents{private, possible, err}
			}
			private, possible, extentErr := observation.extents.private, observation.extents.possible, observation.extents.err
			if extentErr != nil {
				winner.AtLeast = true
				exclusive = 0
				upper = allocation
			} else {
				exclusive, upper = private, possible
				sharingUnmeasured = false
			}
		}
		winner.SharedExtentsUnmeasured = winner.SharedExtentsUnmeasured || sharingUnmeasured
		if meta.kind == "file" && meta.nlink == 0 && !meta.nlinkAttempted {
			current, statErr := diskReadMetadata(observation.path)
			if statErr != nil || current.identity != meta.identity || current.kind != "file" || current.cloudOnly {
				winner.AtLeast = true
				exclusive = 0
			} else {
				meta.nlink = current.nlink
			}
		}
		if meta.kind == "file" && meta.nlink == 0 {
			winner.AtLeast = true
		}
		unionExclusive := exclusive
		if meta.kind == "file" && !diskLinksReclaimable(observation, allLinks, meta) {
			unionExclusive = 0
		}
		rootExclusive := exclusive
		if meta.kind == "file" && !diskLinksReclaimable(observation, observation.roots[winnerRoot], meta) {
			rootExclusive = 0
			upper = 0
		}
		winner.ExclusiveBytes += rootExclusive
		winner.SharedBytes += allocation - rootExclusive
		result.TotalExclusiveBytes += unionExclusive
		if upper != exclusive || meta.mayShareBlocks {
			if winner.FreesUpToBytes == nil {
				winner.FreesUpToBytes = diskInt64Pointer(0)
			}
			*winner.FreesUpToBytes += upper - rootExclusive
		}
	}
	for _, root := range roots {
		if byRoot[root].FreesUpToBytes != nil {
			*byRoot[root].FreesUpToBytes += byRoot[root].ExclusiveBytes
		}
		result.PerPath = append(result.PerPath, *byRoot[root])
	}
	return result
}
func diskInt64Pointer(value int64) *int64 { return &value }
func diskObservationKey(meta diskMetadata) string {
	// A clone family id alone does not prove identical allocation: modified
	// clones retain private blocks. Only all-shared, zero-private allocation can
	// be deduplicated. Partial clones remain independently charged by inode.
	if diskCloneDataKnown(meta) {
		return "clone:" + meta.device + ":" + meta.cloneID
	}
	return meta.identity
}
func diskFullClone(meta diskMetadata) bool {
	return meta.cloneID != "" && meta.sharesAllBlocks && meta.privateBytesKnown && meta.privateBytes == 0
}
func diskCloneDataKnown(meta diskMetadata) bool {
	return diskFullClone(meta) && meta.dataAllocationKnown && meta.dataAllocatedBytes >= 0 && meta.dataAllocatedBytes <= meta.allocatedBytes
}
func diskAllocationComponents(meta diskMetadata) []diskMetadata {
	if !diskCloneDataKnown(meta) {
		return []diskMetadata{meta}
	}
	// CLONEID identifies the data stream, not resource forks. PRIVATE and
	// SHARES_ALL do not prove all-fork identity (observed on APFS with distinct
	// resource forks). Charge the data stream once and other forks per inode.
	data := meta
	data.allocatedBytes = meta.dataAllocatedBytes
	components := []diskMetadata{data}
	if meta.allocatedBytes > meta.dataAllocatedBytes {
		forks := meta
		forks.identity += ":non-data-allocation"
		forks.allocatedBytes -= meta.dataAllocatedBytes
		forks.cloneID, forks.cloneRefCount = "", 0
		forks.sharesAllBlocks = false
		forks.dataAllocatedBytes, forks.dataAllocationKnown = 0, false
		// Without independent fork sharing/snapshot facts, zero is the honest
		// lower bound. The inode's link set still determines its upper bound.
		forks.privateBytes, forks.privateBytesKnown = 0, false
		components = append(components, forks)
	}
	return components
}
func diskLinksReclaimable(observation *diskObservation, links map[string]bool, meta diskMetadata) bool {
	if !diskCloneDataKnown(meta) {
		return meta.nlink > 0 && uint64(len(links)) >= meta.nlink
	}
	// Distinct clone inodes do not supply one another's hardlinks. Check each
	// inode's complete link set, then the number of full-clone inodes separately.
	counts := map[string]uint64{}
	required := map[string]uint64{}
	cloneRefs := meta.cloneRefCount
	for path, linkMeta := range observation.linkMetadata {
		required[linkMeta.identity] = linkMeta.nlink
		if links[path] {
			counts[linkMeta.identity]++
		}
		if linkMeta.cloneRefCount > cloneRefs {
			cloneRefs = linkMeta.cloneRefCount
		}
	}
	for identity, nlink := range required {
		if nlink == 0 || counts[identity] < nlink {
			return false
		}
	}
	return len(required) > 0 && uint64(len(counts)) >= cloneRefs
}
func diskNodeFromEntry(entry diskEntry) diskNode {
	name := entry.name
	raw := ""
	if !utf8.ValidString(name) {
		raw = base64.StdEncoding.EncodeToString([]byte(name))
		name = strings.ToValidUTF8(name, "�")
	}
	kind := entry.meta.kind
	if entry.meta.cloudOnly {
		kind = "cloud-only"
	}
	node := diskNode{ID: diskPathID(entry.path), Name: name, NameBytes: raw, Kind: kind, AllocatedBytes: entry.meta.allocatedBytes, LogicalBytes: entry.meta.logicalBytes, Items: 1, MtimeMs: entry.meta.mtimeMs, Flags: diskFlags{AtLeast: entry.err != nil, SharedExtentsUnmeasured: entry.meta.sharedExtentsUnmeasured}, meta: entry.meta, rawPath: entry.path}
	if entry.err == nil && !entry.meta.cloudOnly {
		node.AllocationFacts = diskAllocationFacts(entry.path, entry.meta)
	}
	return node
}

type diskAllocationFact struct {
	Key            string `json:"key"`
	AllocatedBytes int64  `json:"allocatedBytes"`
	PathID         string `json:"pathId"`
	MtimeMs        int64  `json:"mtimeMs"`
	AgeIncluded    bool   `json:"ageIncluded"`
}

func diskAllocationKey(path string, meta diskMetadata) string {
	if key := diskObservationKey(meta); key != "" {
		return key
	}
	return "path:" + diskPathID(path)
}
func diskAllocationFacts(path string, meta diskMetadata) []diskAllocationFact {
	facts := []diskAllocationFact{}
	for _, component := range diskAllocationComponents(meta) {
		facts = append(facts, diskAllocationFact{Key: diskAllocationKey(path, component), AllocatedBytes: component.allocatedBytes, PathID: diskPathID(path), MtimeMs: component.mtimeMs, AgeIncluded: component.kind == "file"})
	}
	return facts
}
func diskPathID(path string) string {
	if utf8.ValidString(path) {
		return path
	}
	return "bytes:" + base64.StdEncoding.EncodeToString([]byte(path))
}

func diskPathFromID(id string) (string, error) {
	if strings.HasPrefix(id, "bytes:") {
		if runtime.GOOS == "windows" {
			return "", errors.New("byte paths are unsupported on Windows")
		}
		path, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(id, "bytes:"))
		if err != nil {
			return "", err
		}
		if strings.ContainsRune(string(path), 0) || !filepath.IsAbs(string(path)) || base64.StdEncoding.EncodeToString(path) != strings.TrimPrefix(id, "bytes:") {
			return "", errors.New("invalid absolute byte path")
		}
		return string(path), nil
	}
	return id, nil
}
func diskReason(err error) string {
	if errors.Is(err, os.ErrPermission) {
		return "permission"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	return "io"
}
func diskEmptySummary() diskSummary {
	return diskSummary{V: 1, Type: "summary", Termination: "completed", Unreadable: []diskIssue{}, UnreadableCounts: map[string]int64{"permission": 0, "os_private": 0, "timeout": 0, "io": 0}, Skipped: []diskIssue{}, BackendByDirCounts: map[string]int64{}}
}

type diskTask struct {
	path, root   string
	meta         diskMetadata
	atomicParent string
}
type diskBatch struct {
	task    diskTask
	entries []diskEntry
	backend string
	err     error
}

func diskObserve(result *diskWalkResult, root, path string, meta diskMetadata) {
	for index, component := range diskAllocationComponents(meta) {
		meta := component
		key := diskAllocationKey(path, meta)
		observation := result.observations[key]
		if observation == nil {
			observation = &diskObservation{path: path, meta: meta, roots: map[string]map[string]bool{}, linkMetadata: map[string]diskMetadata{}, allocationOnly: index > 0}
			result.observations[key] = observation
			result.summary.AllocatedBytes += meta.allocatedBytes
			if index == 0 {
				result.summary.Items++
			}
		}
		if path < observation.path {
			observation.path = path
			observation.meta = meta
		}
		if observation.roots[root] == nil {
			observation.roots[root] = map[string]bool{}
		}
		linkPath := path
		if runtime.GOOS == "windows" {
			linkPath = strings.ToLower(strings.TrimPrefix(filepath.Clean(path), `\\?\`))
		}
		observation.roots[root][linkPath] = true
		observation.linkMetadata[linkPath] = meta
	}
}

// Match filepath.Rel's Windows case folding without changing Unix byte paths.
func diskMembershipPathKey(path string) string {
	if runtime.GOOS != "windows" {
		return path
	}
	return strings.Map(func(r rune) rune {
		key := r
		for next := unicode.SimpleFold(r); next != r; next = unicode.SimpleFold(next) {
			if next < key {
				key = next
			}
		}
		return key
	}, path)
}

func diskWalk(ctx context.Context, roots []string, lowPower bool, request diskScanRequest) (diskWalkResult, error) {
	result := diskWalkResult{observations: map[string]*diskObservation{}, summary: diskEmptySummary(), incomplete: map[string]bool{}, direct: map[string]*diskDirectMeasure{}}
	result.aliases = map[string]string{}
	control := &diskControl{skipped: map[string]bool{}}
	visited := map[string]map[string]bool{}
	tasks := []diskTask{}
	linkCounts := map[string]uint64{}
	var linkCountsMu sync.Mutex
	var rootFileFacts map[string]diskMetadata
	// Populated after physical aliases are resolved. Each observation visits its
	// own ancestors rather than comparing itself with every selected catalog row.
	rootsByPhysicalPath := map[string][]string{}
	rootOrder := map[string]int{}
	if request.measureLinkCounts {
		rootFileFacts = map[string]diskMetadata{}
	}
	enumerating := false
	issue := func(root, path, reason string) {
		result.summary.UnreadableCounts[reason]++
		if result.summary.UnreadableCounts[reason] == 1 {
			result.summary.Unreadable = append(result.summary.Unreadable, diskIssue{path, reason})
		}
		result.incomplete[root] = true
		if !enumerating {
			return
		}
		for _, member := range roots {
			physical := result.aliases[member]
			if physical == "" {
				continue
			}
			if diskPathContains(physical, path) || diskPathContains(path, physical) {
				result.incomplete[member] = true
			}
		}
	}
	observe := func(path string, meta diskMetadata) {
		members := []string{}
		for ancestor := filepath.Clean(path); ; ancestor = filepath.Dir(ancestor) {
			members = append(members, rootsByPhysicalPath[diskMembershipPathKey(ancestor)]...)
			if parent := filepath.Dir(ancestor); parent == ancestor {
				break
			}
		}
		sort.Slice(members, func(i, j int) bool { return rootOrder[members[i]] < rootOrder[members[j]] })
		if meta.kind == "file" && meta.nlink == 1 && !diskCloneDataKnown(meta) {
			key := strings.Join(members, "\x00")
			direct := result.direct[key]
			if direct == nil {
				direct = &diskDirectMeasure{roots: members}
				result.direct[key] = direct
			}
			size := &direct.size
			size.Items++
			result.summary.Items++
			if meta.mtimeMs > 0 && meta.mtimeMs <= (1<<53)-1 && (size.LastChangedAtMs == nil || meta.mtimeMs > *size.LastChangedAtMs) {
				size.LastChangedAtMs = diskInt64Pointer(meta.mtimeMs)
			}
			if meta.cloudOnly {
				return
			}
			allocation, exclusive, upper := meta.allocatedBytes, meta.allocatedBytes, meta.allocatedBytes
			if meta.privateBytesKnown {
				exclusive = meta.privateBytes
			}
			unmeasured := meta.sharedExtentsUnmeasured
			if unmeasured || meta.mayShareBlocks && !meta.privateBytesKnown {
				exclusive = 0
			}
			if runtime.GOOS == "linux" && request.measureSharedExtents && unmeasured {
				private, possible, err := diskMeasureSharedExtents(path, meta)
				if err != nil {
					size.AtLeast = true
					exclusive = 0
				} else {
					exclusive, upper, unmeasured = private, possible, false
				}
			}
			size.AllocatedBytes += allocation
			size.ExclusiveBytes += exclusive
			size.SharedBytes += allocation - exclusive
			size.SharedExtentsUnmeasured = size.SharedExtentsUnmeasured || unmeasured
			if upper != exclusive || meta.mayShareBlocks {
				if size.FreesUpToBytes == nil {
					size.FreesUpToBytes = diskInt64Pointer(0)
				}
				*size.FreesUpToBytes += upper - exclusive
			}
			result.summary.AllocatedBytes += allocation
			return
		}
		for _, root := range members {
			diskObserve(&result, root, path, meta)
		}
	}
	rootMetadata := map[string]diskMetadata{}
	for _, root := range roots {
		meta, err := diskReadMetadata(root, rootFileFacts)
		if err != nil {
			issue(root, root, diskReason(err))
			continue
		}
		rootMetadata[root] = meta
		// Explicitly selected file roots may also appear in a containing root's
		// enumeration. This bounded root cache avoids requerying those Windows
		// singleton facts without retaining the whole ordinary-file corpus.
		if rootFileFacts != nil && meta.kind == "file" && !meta.cloudOnly {
			rootFileFacts[meta.identity] = meta
		}
		if request.measureLinkCounts && meta.kind == "file" && meta.nlink != 1 {
			linkCounts[diskAllocationKey(root, meta)] = meta.nlink
		}
	}
	// Directory identities and single-link selected-file identities prove root
	// aliases (case variants, bind mounts). Multi-link file names remain distinct
	// link evidence. This map scales with selected roots, not ordinary files.
	byIdentity := map[string]string{}
	for _, root := range roots {
		meta, ok := rootMetadata[root]
		if !ok {
			continue
		}
		result.aliases[root] = root
		if meta.identity != "" && (meta.kind == "folder" || meta.kind == "package" || meta.kind == "file" && meta.nlink == 1) {
			if canonical := byIdentity[meta.identity]; canonical != "" {
				result.aliases[root] = canonical
			} else {
				byIdentity[meta.identity] = root
			}
		}
	}
	for _, root := range roots {
		for _, ancestor := range roots {
			meta := rootMetadata[ancestor]
			canonical := result.aliases[ancestor]
			if canonical != "" && canonical != ancestor && (meta.kind == "folder" || meta.kind == "package") && diskPathContains(ancestor, root) {
				relative, err := filepath.Rel(ancestor, root)
				if err == nil {
					result.aliases[root] = filepath.Join(canonical, relative)
				}
			}
		}
	}
	for index, root := range roots {
		physical := result.aliases[root]
		if physical == "" {
			physical = root
		}
		key := diskMembershipPathKey(filepath.Clean(physical))
		rootsByPhysicalPath[key] = append(rootsByPhysicalPath[key], root)
		rootOrder[root] = index
	}
	for _, root := range roots {
		meta, ok := rootMetadata[root]
		if !ok {
			continue
		}
		covered := result.aliases[root] != root
		for _, parent := range roots {
			ancestor, ok := rootMetadata[parent]
			if ok && parent != root && diskPathContains(result.aliases[parent], result.aliases[root]) && !diskPathContains(result.aliases[root], result.aliases[parent]) && (ancestor.kind == "folder" || ancestor.kind == "package") && !ancestor.cloudOnly && ancestor.device == meta.device {
				covered = true
				break
			}
		}
		if covered {
			continue
		}
		observe(root, meta)
		visited[root] = map[string]bool{}
		if (meta.kind == "folder" || meta.kind == "package") && !meta.cloudOnly {
			visited[root][meta.identity] = true
			tasks = append(tasks, diskTask{path: root, root: root, meta: meta})
		}
	}
	enumerating = true
	workers := diskWorkerCount(lowPower)
	jobs := make(chan diskTask)
	batches := make(chan diskBatch, workers)
	var group sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		group.Add(1)
		go func() {
			defer group.Done()
			for task := range jobs {
				batch := diskBatch{task: task}
				if ctx.Err() != nil {
					batch.err = ctx.Err()
				} else if !control.skips(task.path) {
					dir, err := diskOpenDirectoryForScan(task.path)
					if err != nil {
						batch.err = err
					} else {
						if dir.metadata().identity != task.meta.identity {
							batch.err = errors.New("directory changed before enumeration")
						} else {
							if enumerator, ok := dir.(interface {
								entriesWithFileFacts(context.Context, map[string]diskMetadata, *sync.Mutex) ([]diskEntry, string, error)
							}); ok && request.measureLinkCounts {
								batch.entries, batch.backend, batch.err = enumerator.entriesWithFileFacts(ctx, rootFileFacts, &linkCountsMu)
							} else {
								batch.entries, batch.backend, batch.err = dir.entries(ctx)
							}
							if reader, ok := dir.(interface {
								readEntryMetadata(diskEntry, ...map[string]diskMetadata) (diskMetadata, error)
							}); ok && request.measureLinkCounts {
								for index := range batch.entries {
									entry := &batch.entries[index]
									if entry.err != nil || entry.meta.kind != "file" || entry.meta.cloudOnly {
										continue
									}
									linkCountsMu.Lock()
									key := diskObservationKey(entry.meta)
									if key == "" {
										key = "path:" + entry.path
									}
									count, known := linkCounts[key]
									if !known {
										count = entry.meta.nlink
										if count == 0 && !entry.meta.nlinkAttempted {
											current, err := reader.readEntryMetadata(*entry, rootFileFacts)
											if err == nil && current.identity == entry.meta.identity && current.kind == "file" && !current.cloudOnly {
												count = current.nlink
											}
										}
										if count != 1 {
											linkCounts[key] = count
										}
									}
									entry.meta.nlink, entry.meta.nlinkAttempted = count, true
									linkCountsMu.Unlock()
								}
							}
						}
						_ = dir.close()
					}
				}
				batches <- batch
			}
		}()
	}
	retired := false
	defer func() {
		close(jobs)
		if !retired {
			group.Wait()
		}
	}()
	for len(tasks) > 0 {
		sort.Slice(tasks, func(i, j int) bool { return tasks[i].path < tasks[j].path })
		frontier := tasks
		tasks = nil
		for start := 0; start < len(frontier); start += workers {
			end := start + workers
			if end > len(frontier) {
				end = len(frontier)
			}
			for _, task := range frontier[start:end] {
				jobs <- task
			}
			for completed := start; completed < end; completed++ {
				var batch diskBatch
				select {
				case batch = <-batches:
				case <-ctx.Done():
					retired = true
					return result, ctx.Err()
				}
				task := batch.task
				if batch.err != nil {
					issue(task.root, task.path, diskReason(batch.err))
					continue
				}
				for _, entry := range batch.entries {
					if entry.err != nil {
						issue(task.root, entry.path, diskReason(entry.err))
						continue
					}
					isDirectory := entry.meta.kind == "folder" || entry.meta.kind == "package"
					skip, reason := diskShouldSkip(entry.path, task.root, entry.meta)
					skip, reason = diskDirectoryBoundary(entry.meta.device, task.meta.device, request.AllowedDevices, skip, reason)
					if isDirectory && skip {
						result.summary.Skipped = append(result.summary.Skipped, diskIssue{entry.path, reason})
						continue
					}
					if isDirectory && !entry.meta.cloudOnly {
						if visited[task.root][entry.meta.identity] {
							continue
						}
						visited[task.root][entry.meta.identity] = true
						tasks = append(tasks, diskTask{path: entry.path, root: task.root, meta: entry.meta})
					}
					observe(entry.path, entry.meta)
				}
			}
		}
	}
	return result, nil
}
func diskAccumulateAge(groups *diskAgeGroups, mtimeMs, bytes int64, now time.Time) {
	// Epoch 0/1 second is the reproducible-build unknown-age sentinel (STO-19).
	if mtimeMs <= 1000 {
		groups.Unknown += bytes
		return
	}
	changed := time.UnixMilli(mtimeMs)
	if changed.Before(now.AddDate(0, -12, 0)) {
		groups.Months12 += bytes
	} else if changed.Before(now.AddDate(0, -6, 0)) {
		groups.Months6 += bytes
	} else if changed.Before(now.AddDate(0, -3, 0)) {
		groups.Months3 += bytes
	}
}
