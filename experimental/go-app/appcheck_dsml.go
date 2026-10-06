//go:build appcheck && !nogui

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
)

func probeDSMLUpstream(w http.ResponseWriter, r *http.Request, data []byte) bool {
	var body map[string]any
	if r.URL.Path != "/v1/chat/completions" || json.Unmarshal(data, &body) != nil {
		return false
	}
	messages, ok := body["messages"].([]any)
	if !ok || len(messages) != 1 {
		return false
	}
	message, _ := messages[0].(map[string]any)
	if message["content"] != "dsml-native-probe" {
		return false
	}
	tools, ok := body["tools"].([]any)
	if body["model"] != "gpt-5.5" || body["stream"] != true || !ok || len(tools) != 2 || r.Header.Get("X-MOMO-Tool-Text") != "" {
		w.WriteHeader(400)
		return true
	}
	names := []string{}
	for _, t := range tools {
		tool, _ := t.(map[string]any)
		function, _ := tool["function"].(map[string]any)
		name, _ := function["name"].(string)
		names = append(names, name)
	}
	if strings.Join(names, ",") != "pad__read,pad__write" {
		w.WriteHeader(400)
		return true
	}
	source := `before<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="pad__read"><｜｜DSML｜｜parameter name="path" string="true"> a & b < c </｜｜DSML｜｜parameter></｜｜DSML｜｜invoke><｜｜DSML｜｜invoke name="pad__write"><｜｜DSML｜｜parameter name="input">text("中文🙂")</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>after`
	w.Header().Set("Content-Type", "text/event-stream")
	for _, runeValue := range source {
		b, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]string{"content": string(runeValue)}}}})
		fmt.Fprintln(w, "data: "+string(b))
		fmt.Fprintln(w)
	}
	fmt.Fprintln(w, `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`)
	fmt.Fprintln(w)
	fmt.Fprintln(w, "data: [DONE]")
	fmt.Fprintln(w)
	return true
}
func probeDSMLRequests(core *appcore.Core) error {
	base, key, err := probeCredentials(core)
	if err != nil {
		return err
	}
	client := http.Client{Timeout: 4 * time.Second}
	defer client.CloseIdleConnections()
	for _, stream := range []bool{true, false} {
		payload := map[string]any{"model": "gpt-5.5", "stream": stream, "input": []any{map[string]string{"role": "user", "content": "dsml-native-probe"}}, "tools": []any{map[string]any{"type": "namespace", "name": "pad", "tools": []any{map[string]string{"type": "function", "name": "read"}, map[string]string{"type": "custom", "name": "write"}}}}}
		body, _ := json.Marshal(payload)
		req, _ := http.NewRequest("POST", base+"/responses", strings.NewReader(string(body)))
		req.Header.Set("Authorization", "Bearer "+key)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-MOMO-Tool-Text", "dsml-v1")
		response, err := client.Do(req)
		if err != nil {
			return err
		}
		data, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil || response.StatusCode != 200 || response.Header.Get("X-MOMO-Tool-Text") != "dsml-v1" || strings.Contains(string(data), "DSML｜｜") {
			return errors.New("DSML native delivery")
		}
		var final map[string]any
		if stream {
			for _, line := range strings.Split(string(data), string(rune(10))) {
				if strings.HasPrefix(line, "data: ") {
					var event map[string]any
					if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event) == nil && event["type"] == "response.completed" {
						final, _ = event["response"].(map[string]any)
					}
				}
			}
		} else {
			json.Unmarshal(data, &final)
		}
		if final == nil || final["status"] != "completed" {
			return errors.New("DSML terminal")
		}
		output, ok := final["output"].([]any)
		if !ok || len(output) != 4 {
			return errors.New("DSML output order")
		}
		first, _ := output[1].(map[string]any)
		second, _ := output[2].(map[string]any)
		if first["name"] != "read" || first["namespace"] != "pad" || second["name"] != "write" || second["namespace"] != "pad" || second["input"] != `text("中文🙂")` || first["call_id"] == second["call_id"] {
			return errors.New("DSML call identity/raw")
		}
		var args map[string]any
		encoded, _ := first["arguments"].(string)
		if json.Unmarshal([]byte(encoded), &args) != nil || args["path"] != " a & b < c " {
			return errors.New("DSML arguments")
		}
	}
	return nil
}
