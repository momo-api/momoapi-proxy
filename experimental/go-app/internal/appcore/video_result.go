package appcore

import "strings"

type videoResult struct {
	TaskID    string `json:"task_id"`
	Status    string `json:"status"`
	RawStatus string `json:"raw_status,omitempty"`
	Terminal  bool   `json:"terminal"`
	RemoteURL string `json:"remote_url,omitempty"`
	Progress  *int   `json:"progress,omitempty"`
	Error     string `json:"error,omitempty"`
}

// Exact bounded known envelopes only. No reflection of arbitrary errors,
// metadata, URLs requiring auth, HTML or generated file bodies. Conflicting
// IDs/status/URL/progress reject instead of choosing a convenient member.
func parseVideoResult(data []byte, expectedID string) (videoResult, error) {
	result := videoResult{}
	m, err := decodeVideoObject(data)
	if err != nil || len(data) > MaxResponse {
		return result, errVideo
	}
	if v, present := m["code"]; present {
		n, err := videoInteger(v)
		if err != nil || n != 200 {
			return result, errVideo
		}
	}
	rows := []map[string]any{m}
	if v, present := m["data"]; present {
		inner := obj(v)
		if inner == nil {
			return result, errVideo
		}
		rows = append(rows, inner)
	}
	hasError := false
	for _, row := range rows {
		for _, name := range []string{"task_id", "id"} {
			if v, present := row[name]; present {
				id, ok := v.(string)
				if !ok || !validImageTaskID(id) || result.TaskID != "" && result.TaskID != id {
					return result, errVideo
				}
				result.TaskID = id
			}
		}
		if v, present := row["status"]; present {
			s, ok := v.(string)
			if !ok {
				return result, errVideo
			}
			s = strings.ToLower(s)
			if !includes([]string{"submitted", "queued", "pending", "processing", "running", "in_progress", "completed", "success", "succeeded", "failed", "failure", "error", "cancelled", "canceled", "expired"}, s) || result.RawStatus != "" && result.RawStatus != s {
				return result, errVideo
			}
			result.RawStatus = s
		}
		if v, present := row["progress"]; present {
			n, err := videoInteger(v)
			if err != nil || n > 100 || result.Progress != nil && *result.Progress != n {
				return result, errVideo
			}
			result.Progress = &n
		}
		if v, present := row["error"]; present && v != nil {
			hasError = true
		}
		urlRows := []map[string]any{row}
		for _, name := range []string{"metadata", "result"} {
			if v, present := row[name]; present {
				inner := obj(v)
				if inner == nil {
					return result, errVideo
				}
				urlRows = append(urlRows, inner)
			}
		}
		for _, r := range urlRows {
			for _, name := range []string{"url", "video_url", "result_url"} {
				if v, present := r[name]; present {
					s, ok := v.(string)
					if !ok || !validMediaURL(s) || result.RemoteURL != "" && result.RemoteURL != s {
						return result, errVideo
					}
					result.RemoteURL = s
				}
			}
		}
	}
	if expectedID != "" {
		if result.RawStatus == "" {
			return result, errVideo
		}
		if result.TaskID != "" && result.TaskID != expectedID {
			return result, errVideo
		}
		result.TaskID = expectedID
	}
	if result.TaskID == "" {
		return result, errVideo
	}
	switch result.RawStatus {
	case "", "submitted", "queued", "pending":
		result.Status = "queued"
	case "processing", "running", "in_progress":
		result.Status = "processing"
	case "completed", "success", "succeeded":
		result.Status = "completed"
		result.Terminal = true
	case "failed", "failure", "error":
		result.Status = "failed"
		result.Terminal = true
		result.Error = "video task ended without output"
	case "cancelled", "canceled":
		result.Status = "cancelled"
		result.Terminal = true
		result.Error = "video task ended without output"
	case "expired":
		result.Status = "expired"
		result.Terminal = true
		result.Error = "video task ended without output"
	}
	if result.Status == "completed" && result.RemoteURL == "" || result.Status != "completed" && result.RemoteURL != "" || hasError && result.Error == "" {
		return result, errVideo
	}
	return result, nil
}
