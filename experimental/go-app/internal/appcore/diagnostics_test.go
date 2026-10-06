package appcore

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestDiagnosticsSnapshotIsAllowlistedNonmutatingAndOffline(t *testing.T) {
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("diagnostics queried upstream") }))
	secret := "synthetic-diag-private-only"
	now := time.Now()
	c.mu.Lock()
	c.config.APIKey = secret
	c.config.Endpoint = "https://" + secret + ".example"
	c.token = secret
	c.endpoint = "http://127.0.0.1:32123"
	c.history.entries = map[string]historyEntry{secret: {model: secret, input: []json.RawMessage{json.RawMessage(`{"private":true}`)}, bytes: 10, expires: now.Add(time.Hour)}, "expired": {bytes: 20, expires: now.Add(-time.Hour)}}
	c.history.order = []string{secret, "expired"}
	c.history.bytes = 30
	c.attachments.entries = map[string]attachmentEntry{secret: {part: json.RawMessage(`{"private":true}`), meta: attachmentMetadata{Name: secret, Expires: now.Add(time.Hour)}}, "expired": {meta: attachmentMetadata{Expires: now.Add(-time.Hour)}}}
	c.attachments.bytes = 40
	c.images.tasks = map[string]imageTask{secret: {expires: now.Add(time.Hour)}, "expired": {expires: now.Add(-time.Hour)}}
	c.images.checked = now
	c.images.pending = 2
	c.images.refreshing = true
	c.videos.tasks = map[string]videoTask{secret: {expires: now.Add(time.Hour)}, "expired": {expires: now.Add(-time.Hour)}}
	c.videos.checked = now.Add(-time.Hour)
	c.videos.pending = 1
	c.mu.Unlock()
	report := c.Diagnostics()
	raw, _ := json.Marshal(report)
	for _, s := range []string{secret, endpoint, "127.0.0.1", "32123", "private", "input", "expires", "filename", "endpoint"} {
		if strings.Contains(string(raw), s) {
			t.Fatal("diagnostic private content leak")
		}
	}
	if report.Scope != "current-core" || !report.Gateway.Configured || !report.Gateway.Running || !report.Gateway.ListenerAllocated || report.Gateway.Mode != "momo-routing" || report.VerifiedUpstream || report.CrossDevice || report.AccountWallet {
		t.Fatal("snapshot claims")
	}
	if report.Stores.History != (DiagnosticStore{2, 1, 30}) || report.Stores.Attachments != (DiagnosticStore{2, 1, 40}) || report.Stores.Images != (DiagnosticMediaStore{2, 1, 2, true, true}) || report.Stores.Videos != (DiagnosticMediaStore{2, 1, 1, false, false}) {
		t.Fatal("store snapshot counts")
	}
	c.mu.Lock()
	if !reflect.DeepEqual(c.history.order, []string{secret, "expired"}) || len(c.history.entries) != 2 || len(c.attachments.entries) != 2 || len(c.images.tasks) != 2 || len(c.videos.tasks) != 2 || !c.images.checked.Equal(now) {
		t.Fatal("snapshot changed state/expiry/LRU")
	}
	c.mu.Unlock()
	c.Stop()
	stopped := c.Diagnostics()
	if stopped.Gateway.Running || stopped.Stores != (DiagnosticStores{}) || !stopped.Gateway.Configured {
		t.Fatal("Stop snapshot")
	}
	c.Close()
	if c.Diagnostics().Gateway.Configured {
		t.Fatal("Close snapshot")
	}
	offline := OfflineDiagnostics()
	if offline.Scope != "offline-process" || offline.Gateway != (DiagnosticGateway{Mode: "passthrough"}) || offline.Stores != (DiagnosticStores{}) || offline.CapturedAt.IsZero() || offline.Runtime.OS == "" || offline.Runtime.Arch == "" || offline.Runtime.Go == "" {
		t.Fatal("offline scope")
	}
	if offline.Limits.RequestBytes != MaxRequest || offline.Limits.ResponseBytes != MaxResponse || offline.Limits.HistoryEntries != maxHistoryEntries || offline.Limits.HistoryBytes != maxHistoryBytes || offline.Limits.HistoryItems != maxHistoryItems || offline.Limits.HistoryTTLSeconds != 1800 || offline.Limits.AttachmentEntries != maxAttachments || offline.Limits.AttachmentBytes != maxAttachmentBytes || offline.Limits.ImageTasks != maxImageTasks || offline.Limits.VideoTasks != maxVideoTasks || offline.Limits.ActiveRequests != 4 || offline.Limits.TCPConnections != 32 || offline.Limits.MediaCatalogTTLSeconds != 300 || offline.Limits.MediaTaskTTLSeconds != 1800 {
		t.Fatal("offline limits")
	}
}

func TestDiagnosticsConcurrentStopAndConfigure(t *testing.T) {
	c, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				r := c.Diagnostics()
				if r.Gateway.Active < 0 || r.Scope != "current-core" {
					t.Error("concurrent snapshot")
				}
			}
		}()
	}
	for i := 0; i < 100; i++ {
		c.Stop()
		if c.Configure(Config{Endpoint: "https://mock.example", APIKey: "synthetic-diag"}) != nil || c.Start() != nil {
			t.Fatal("configure")
		}
	}
	wg.Wait()
}
