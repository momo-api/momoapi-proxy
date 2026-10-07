package appcore

import (
	"runtime"
	"time"
)

// An allowlisted local snapshot, not a health probe or a dump of State/config.
// Never add endpoints, identifiers, content, headers, keys or OS account paths.
type DiagnosticReport struct {
	Schema           string            `json:"schema"`
	Scope            string            `json:"scope"`
	Version          string            `json:"version"`
	CapturedAt       time.Time         `json:"captured_at"`
	Runtime          DiagnosticRuntime `json:"runtime"`
	Gateway          DiagnosticGateway `json:"gateway"`
	Stores           DiagnosticStores  `json:"stores"`
	Limits           DiagnosticLimits  `json:"limits"`
	Routing          RouteDiagnostics  `json:"routing"`
	VerifiedUpstream bool              `json:"verified_upstream"`
	AccountWallet    bool              `json:"account_wallet"`
	CrossDevice      bool              `json:"cross_device"`
}
type DiagnosticRuntime struct {
	OS   string `json:"os"`
	Arch string `json:"arch"`
	Go   string `json:"go"`
}
type DiagnosticGateway struct {
	Configured        bool   `json:"configured"`
	Running           bool   `json:"running"`
	Active            int    `json:"active"`
	Mode              string `json:"mode"`
	ListenerAllocated bool   `json:"listener_allocated"`
}
type DiagnosticStore struct {
	RetainedEntries int `json:"retained_entries"`
	LiveEntries     int `json:"live_entries"`
	RetainedBytes   int `json:"retained_bytes"`
}
type DiagnosticMediaStore struct {
	RetainedTasks int  `json:"retained_tasks"`
	LiveTasks     int  `json:"live_tasks"`
	Pending       int  `json:"pending"`
	CatalogFresh  bool `json:"catalog_fresh"`
	Refreshing    bool `json:"refreshing"`
}
type DiagnosticStores struct {
	History     DiagnosticStore      `json:"history"`
	Attachments DiagnosticStore      `json:"attachments"`
	Images      DiagnosticMediaStore `json:"images"`
	Videos      DiagnosticMediaStore `json:"videos"`
}
type DiagnosticLimits struct {
	RequestBytes           int `json:"request_bytes"`
	ResponseBytes          int `json:"response_bytes"`
	ActiveRequests         int `json:"active_requests"`
	TCPConnections         int `json:"tcp_connections"`
	HistoryEntries         int `json:"history_entries"`
	HistoryBytes           int `json:"history_bytes"`
	HistoryItems           int `json:"history_items"`
	HistoryTTLSeconds      int `json:"history_ttl_seconds"`
	AttachmentEntries      int `json:"attachment_entries"`
	AttachmentBytes        int `json:"attachment_bytes"`
	AttachmentTTLSeconds   int `json:"attachment_ttl_seconds"`
	ImageTasks             int `json:"image_tasks"`
	VideoTasks             int `json:"video_tasks"`
	MediaCatalogTTLSeconds int `json:"media_catalog_ttl_seconds"`
	MediaTaskTTLSeconds    int `json:"media_task_ttl_seconds"`
}

// CLI report describes only this fresh offline process, never a running desktop.
// No stdin/env/config/vault reads, DNS, listener, provider query or inference.
func OfflineDiagnostics() DiagnosticReport {
	return DiagnosticReport{
		Schema: "momo-local-diagnostics-v1", Scope: "offline-process", Version: Version,
		CapturedAt: time.Now().UTC(), Runtime: DiagnosticRuntime{runtime.GOOS, runtime.GOARCH, runtime.Version()},
		Gateway: DiagnosticGateway{Mode: "passthrough"},
		Routing: routeDiagnosticSnapshot("offline-process", [routeDiagnosticSlots]routeDiagnosticCounter{}),
		Limits:  DiagnosticLimits{MaxRequest, MaxResponse, 4, 32, maxHistoryEntries, maxHistoryBytes, maxHistoryItems, int(historyTTL / time.Second), maxAttachments, maxAttachmentBytes, int(attachmentTTL / time.Second), maxImageTasks, maxVideoTasks, int(imageCatalogTTL / time.Second), int(imageTaskTTL / time.Second)},
	}
}

// Pure snapshot under the same lock; count expired retained entries separately
// instead of expiring/touching them. No storage/content export or state mutation.
func (c *Core) Diagnostics() DiagnosticReport {
	report := OfflineDiagnostics()
	report.Scope = "current-core"
	c.mu.Lock()
	defer c.mu.Unlock()
	report.Routing = routeDiagnosticSnapshot("current-core-since-reset", c.routeCounts)
	now := time.Now().UTC()
	report.CapturedAt = now
	mode := c.config.Mode
	if mode == "" {
		mode = "passthrough"
	}
	report.Gateway = DiagnosticGateway{c.config.APIKey != "", c.running, c.active, mode, c.endpoint != ""}
	report.Stores.History = DiagnosticStore{RetainedEntries: len(c.history.entries), RetainedBytes: c.history.bytes}
	for _, entry := range c.history.entries {
		if now.Before(entry.expires) {
			report.Stores.History.LiveEntries++
		}
	}
	report.Stores.Attachments = DiagnosticStore{RetainedEntries: len(c.attachments.entries), RetainedBytes: c.attachments.bytes}
	for _, entry := range c.attachments.entries {
		if now.Before(entry.meta.Expires) {
			report.Stores.Attachments.LiveEntries++
		}
	}
	report.Stores.Images = DiagnosticMediaStore{RetainedTasks: len(c.images.tasks), Pending: c.images.pending, CatalogFresh: !c.images.checked.IsZero() && now.Before(c.images.checked.Add(imageCatalogTTL)), Refreshing: c.images.refreshing}
	for _, task := range c.images.tasks {
		if now.Before(task.expires) {
			report.Stores.Images.LiveTasks++
		}
	}
	report.Stores.Videos = DiagnosticMediaStore{RetainedTasks: len(c.videos.tasks), Pending: c.videos.pending, CatalogFresh: !c.videos.checked.IsZero() && now.Before(c.videos.checked.Add(videoCatalogTTL)), Refreshing: c.videos.refreshing}
	for _, task := range c.videos.tasks {
		if now.Before(task.expires) {
			report.Stores.Videos.LiveTasks++
		}
	}
	return report
}
