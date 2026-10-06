package appcore

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

func TestAttachmentRawJSONRejectsBeforeStorageOrCheckpointNormalization(t *testing.T) {
	var calls atomic.Int32
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	c.mu.Lock()
	c.config.Mode = "momo-routing"
	c.mu.Unlock()
	part, _ := json.Marshal(filePart(false))
	valid := `{"part":` + string(part) + `}`
	for name, raw := range map[string]string{
		"duplicate-root":    `{"part":null,"part":` + string(part) + `}`,
		"duplicate-part":    strings.Replace(valid, `"type":"input_file"`, `"type":"input_image","type":"input_file"`, 1),
		"escaped-duplicate": strings.Replace(valid, `"type":"input_file"`, `"\u0074ype":"input_image","type":"input_file"`, 1),
		"invalid-utf8":      strings.Replace(valid, "report.pdf", string([]byte{0xff})+".pdf", 1),
		"trailing-object":   valid + `{}`,
		"null-root":         `null`,
	} {
		t.Run("register-"+name, func(t *testing.T) {
			code, data, _ := request(t, c, endpoint, "/internal/attachments", "POST", raw, nil)
			if code != 400 || strings.Contains(string(data), "asset_id") {
				t.Error("ambiguous raw JSON accepted", code)
			}
		})
	}
	c.mu.Lock()
	if len(c.attachments.entries) != 0 || c.attachments.bytes != 0 {
		t.Error("rejected JSON mutated attachment store")
	}
	c.mu.Unlock()
	m := registerAttachment(t, c, endpoint, filePart(false))
	ref := `{"type":"momo_attachment","asset_id":"` + m.ID + `"}`
	base := `{"model":"claude-sonnet-4-6","input":[{"role":"user","content":"old"},{"role":"assistant","content":"` + strings.Repeat("old text", 150) + `"},{"role":"user","content":"middle"},{"role":"assistant","content":"latest"},{"role":"user","content":[` + ref + `]}]}`
	head := map[string]string{"X-MOMO-Attachments": "inline"}
	for name, raw := range map[string]string{
		"duplicate-model":     strings.Replace(base, `"model":`, `"model":"gpt-5.5","model":`, 1),
		"duplicate-role":      strings.Replace(base, `"role":"user"`, `"role":"assistant","role":"user"`, 1),
		"duplicate-reference": strings.Replace(base, `"asset_id":`, `"asset_id":"att_bad","asset_id":`, 1),
		"invalid-utf8":        strings.Replace(base, ref, `{"type":"input_text","text":"`+string([]byte{0xff})+`"},`+ref, 1),
		"depth-limit":         strings.Replace(base, ref, `{"type":"input_text","text":`+strings.Repeat("[", 65)+`"x"`+strings.Repeat("]", 65)+`},`+ref, 1),
		"escaped-duplicate":   strings.Replace(base, `"asset_id":`, `"\u0061sset_id":"att_bad","asset_id":`, 1),
	} {
		for _, path := range []string{"/v1/responses/compact", "/v1/responses"} {
			t.Run(name+path, func(t *testing.T) {
				code, data, _ := request(t, c, endpoint, path, "POST", raw, head)
				if code != 400 || strings.Contains(string(data), "response.compaction") {
					t.Error("raw JSON normalized before rejection", code)
				}
			})
		}
	}
	code, _, _ := request(t, c, endpoint, "/v1/responses/compact", "POST", base, head)
	if code != 200 {
		t.Fatal("valid explicit snapshot checkpoint rejected", code)
	}
	c.mu.Lock()
	if len(c.attachments.entries) != 1 {
		t.Error("rejected expansion modified store")
	}
	c.mu.Unlock()
	if calls.Load() != 0 {
		t.Fatal("invalid JSON or local checkpoint contacted upstream")
	}
}
