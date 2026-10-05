package appcore

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func inlineFixture(t *testing.T, mime string) string {
	t.Helper()
	var b bytes.Buffer
	im := image.NewRGBA(image.Rect(0, 0, 2, 2))
	im.Set(0, 0, color.RGBA{R: 255, A: 255})
	var err error
	switch mime {
	case "image/png":
		err = png.Encode(&b, im)
	case "image/jpeg":
		err = jpeg.Encode(&b, im, nil)
	case "image/gif":
		err = gif.Encode(&b, im, nil)
	}
	if err != nil {
		t.Fatal(err)
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(b.Bytes())
}

func imagePart(url string) map[string]any {
	return map[string]any{"type": "input_image", "image_url": url}
}

func TestInlineImageHeaderMIMEAndGIFFraming(t *testing.T) {
	for _, mime := range []string{"image/png", "image/jpeg", "image/gif"} {
		data := inlineFixture(t, mime)
		img, err := parseRouteImage(imagePart(data), "gpt-5.5", &imageBudget{})
		if err != nil || img.url != data || img.mime != mime || img.data == "" {
			t.Fatal("inline image framing", mime, err)
		}
	}
	// A real tiny WebP fixture, not a renamed PNG.
	webp := "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA"
	if _, err := parseRouteImage(imagePart(webp), "gemini-2.5-flash", &imageBudget{}); err != nil {
		t.Fatal("WebP header", err)
	}
	_, encoded, _ := strings.Cut(webp, ",")
	webpBytes, _ := base64.StdEncoding.DecodeString(encoded)
	for _, bad := range [][]byte{webpBytes[:len(webpBytes)-1], append(append([]byte{}, webpBytes...), 0)} {
		if staticWebP(bad) {
			t.Fatal("invalid RIFF length accepted")
		}
	}
	for _, kind := range []string{"ANIM", "ANMF", "VP8X"} {
		bad := append([]byte{}, webpBytes...)
		chunk := append([]byte(kind), 10, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0)
		bad = append(bad, chunk...)
		binary.LittleEndian.PutUint32(bad[4:8], uint32(len(bad)-8))
		if staticWebP(bad) {
			t.Fatal("animated WebP accepted", kind)
		}
	}
	pngURL := inlineFixture(t, "image/png")
	_, pngData, _ := strings.Cut(pngURL, ",")
	for _, value := range []string{
		"data:image/jpeg;base64," + pngData, "data:image/png;charset=utf-8;base64," + pngData,
		"data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64," + pngData + "\n",
		"data:image/png;base64,not-base64!", "data:image/png;base64,", "data:image/png;base64,aGVsbG8=",
	} {
		if _, err := parseRouteImage(imagePart(value), "gpt-5.5", &imageBudget{}); !errors.Is(err, errUnsupportedImage) {
			t.Fatal("invalid inline accepted")
		}
	}
	pal := image.NewPaletted(image.Rect(0, 0, 1, 1), color.Palette{color.Black, color.White})
	var b bytes.Buffer
	if err := gif.EncodeAll(&b, &gif.GIF{Image: []*image.Paletted{pal, pal}, Delay: []int{1, 1}}); err != nil {
		t.Fatal(err)
	}
	if _, err := parseRouteImage(imagePart("data:image/gif;base64,"+base64.StdEncoding.EncodeToString(b.Bytes())), "gpt-5.5", &imageBudget{}); err == nil {
		t.Fatal("animated GIF accepted")
	}
	if singleFrameGIF(b.Bytes()[:len(b.Bytes())-1]) || singleFrameGIF([]byte("GIF89a")) {
		t.Fatal("truncated GIF accepted")
	}
	_, gifEncoded, _ := strings.Cut(inlineFixture(t, "image/gif"), ",")
	gifBytes, _ := base64.StdEncoding.DecodeString(gifEncoded)
	for _, bad := range [][]byte{gifBytes[:len(gifBytes)-1], append(append([]byte{}, gifBytes...), 0)} {
		if singleFrameGIF(bad) {
			t.Fatal("invalid GIF framing accepted")
		}
	}
}

func TestImageCountIncludesOriginalHistoryAndUnsupportedMedia(t *testing.T) {
	items := []any{}
	for i := 0; i < 33; i++ {
		items = append(items, map[string]any{"role": "user", "content": []any{imagePart("https://images.example/a")}})
	}
	b, _ := json.Marshal(map[string]any{"model": "gpt-5.5", "input": items})
	if _, err := parseRoutedRequest(b); !errors.Is(err, errUnsupportedImage) {
		t.Fatal("per-message counter bypass")
	}
	for _, part := range []map[string]any{{"type": "input_file", "file_id": "synthetic_file"}, {"type": "input_audio", "input_audio": map[string]any{}}, {"type": "input_video", "video_url": "https://images.example/a"}} {
		b, _ = json.Marshal(map[string]any{"model": "gpt-5.5", "input": []any{map[string]any{"role": "user", "content": []any{part}}}})
		if _, err := parseRoutedRequest(b); err == nil {
			t.Fatal("unsupported media accepted")
		}
	}
	// A small PNG header declaring an excessive image must fail without decoding
	// or allocating its pixels; Encode of uniform data remains under JSON budget.
	var pngData bytes.Buffer
	if err := png.Encode(&pngData, image.NewGray(image.Rect(0, 0, 16385, 1))); err != nil {
		t.Fatal(err)
	}
	if _, err := parseRouteImage(imagePart("data:image/png;base64,"+base64.StdEncoding.EncodeToString(pngData.Bytes())), "gpt-5.5", &imageBudget{}); err == nil {
		t.Fatal("dimension limit bypass")
	}
}

func TestImageURLQualityFieldsAndBudgets(t *testing.T) {
	for _, url := range []string{"https://images.example.invalid/a?signature=synthetic", "https://8.8.8.8/a", "https://[2606:4700:4700::1111]/a"} {
		if _, err := parseRouteImage(imagePart(url), "claude-sonnet-4-6", &imageBudget{}); err != nil {
			t.Fatal("public reference rejected", err)
		}
	}
	for _, url := range []string{"http://images.example/a", "file:///a", "https://localhost./a", "https://a.local./a", "https://127.0.0.1/a", "https://[::1]/a", "https://10.0.0.1/a", "https://127.1/a", "https://2130706433/a", "https://a@images.example/a", "https://images.example:444/a", "https://images.example/a#x", "https://intranet/a", "https://images.example/" + strings.Repeat("a", 8192)} {
		if _, err := parseRouteImage(imagePart(url), "gpt-5.5", &imageBudget{}); err == nil {
			t.Fatal("invalid URL accepted")
		}
	}
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		for _, detail := range []string{"auto", "low", "high", "invalid"} {
			p := imagePart(inlineFixture(t, "image/png"))
			p["detail"] = detail
			_, err := parseRouteImage(p, model, &imageBudget{})
			want := detail == "auto" || model == "gpt-5.5" && (detail == "low" || detail == "high")
			if (err == nil) != want {
				t.Fatal("quality contract erased", model, detail)
			}
		}
	}
	for key, value := range map[string]any{"detail": nil, "image_url": map[string]any{"url": "https://images.example/a"}, "mime_type": "image/svg+xml", "file_id": "file_a", "unknown": true} {
		p := imagePart(inlineFixture(t, "image/png"))
		p[key] = value
		if _, err := parseRouteImage(p, "gpt-5.5", &imageBudget{}); err == nil {
			t.Fatal("unknown/type field accepted", key)
		}
	}
	p := imagePart(inlineFixture(t, "image/png"))
	p["mime_type"] = "image/jpeg"
	if _, err := parseRouteImage(p, "gpt-5.5", &imageBudget{}); err == nil {
		t.Fatal("conflicting MIME accepted")
	}
	url := imagePart("https://images.example/a.png")
	if _, err := parseRouteImage(url, "gemini-2.5-flash", &imageBudget{}); err == nil {
		t.Fatal("Gemini MIME guessed from suffix")
	}
	url["mime_type"] = "image/png"
	if _, err := parseRouteImage(url, "gemini-2.5-flash", &imageBudget{}); err != nil {
		t.Fatal(err)
	}
	budget := &imageBudget{}
	for i := 0; i < 32; i++ {
		if _, err := parseRouteImage(url, "gpt-5.5", budget); err != nil {
			t.Fatal("32-image bound", err)
		}
	}
	if _, err := parseRouteImage(url, "gpt-5.5", budget); err == nil {
		t.Fatal("image count exceeded")
	}
	if _, err := parseRouteImage(imagePart(inlineFixture(t, "image/png")), "gpt-5.5", &imageBudget{bytes: MaxRequest}); err == nil {
		t.Fatal("inline budget exceeded")
	}
}

func TestImageInterleavingWireAndOnlyUser(t *testing.T) {
	inline := inlineFixture(t, "image/png")
	parts := []any{map[string]any{"type": "input_text", "text": "before"}, imagePart(inline), map[string]any{"type": "input_text", "text": "after"}, map[string]any{"type": "input_image", "image_url": "https://images.example/a", "mime_type": "image/jpeg"}}
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		p := map[string]any{"model": model, "input": []any{map[string]any{"role": "user", "content": parts}}}
		b, _ := json.Marshal(p)
		var plan *chatPlan
		var err error
		switch resolveProtocol(model) {
		case "chat":
			plan, err = buildChatPlan(b)
		case "claude":
			plan, err = buildClaudePlan(b)
		default:
			plan, err = buildGeminiPlan(b)
		}
		if err != nil {
			t.Fatal(err)
		}
		wire, _ := decodeObject(string(plan.body))
		var got, want any
		_, data, _ := strings.Cut(inline, ",")
		switch resolveProtocol(model) {
		case "chat":
			got = obj(wire["messages"].([]any)[0])["content"]
			want = []any{map[string]any{"type": "text", "text": "before"}, map[string]any{"type": "image_url", "image_url": map[string]any{"url": inline}}, map[string]any{"type": "text", "text": "after"}, map[string]any{"type": "image_url", "image_url": map[string]any{"url": "https://images.example/a"}}}
		case "claude":
			got = obj(wire["messages"].([]any)[0])["content"]
			want = []any{map[string]any{"type": "text", "text": "before"}, map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": "image/png", "data": data}}, map[string]any{"type": "text", "text": "after"}, map[string]any{"type": "image", "source": map[string]any{"type": "url", "url": "https://images.example/a"}}}
		default:
			got = obj(wire["contents"].([]any)[0])["parts"]
			want = []any{map[string]any{"text": "before"}, map[string]any{"inline_data": map[string]any{"mime_type": "image/png", "data": data}}, map[string]any{"text": "after"}, map[string]any{"fileData": map[string]any{"mimeType": "image/jpeg", "fileUri": "https://images.example/a"}}}
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatal("image/text order changed", model)
		}
		for _, role := range []string{"assistant", "system", "developer"} {
			p["input"] = []any{map[string]any{"role": role, "content": parts}}
			b, _ = json.Marshal(p)
			if _, err := parseRoutedRequest(b); err == nil {
				t.Fatal("non-user image accepted")
			}
		}
		p["input"] = []any{map[string]any{"role": "user", "content": []any{imagePart(inline)}}}
		b, _ = json.Marshal(p)
		ir, err := parseRoutedRequest(b)
		if err != nil || ir.messages[0].text != "" || len(ir.messages[0].parts) != 1 {
			t.Fatal("image-only user fabricated text")
		}
	}
}

func TestImageTCPHistoryAndRedactedRejection(t *testing.T) {
	for _, tc := range []struct{ model, upstream string }{{"gpt-5.5", chatSSE(choice(map[string]any{"content": "answer"}, "stop"))}, {"claude-sonnet-4-6", claudeStart() + claudeText(0, "answer") + claudeEnd("end_turn")}, {"gemini-2.5-flash", geminiFrame([]any{geminiText("answer")}, "STOP", geminiUsageFixture())}} {
		for _, stream := range []bool{true, false} {
			t.Run(fmt.Sprint(tc.model, stream), func(t *testing.T) {
				var mu sync.Mutex
				var captures []string
				c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					b, _ := io.ReadAll(r.Body)
					mu.Lock()
					captures = append(captures, string(b))
					mu.Unlock()
					w.Header().Set("Content-Type", "text/event-stream")
					fmt.Fprint(w, tc.upstream)
				}))
				inline := inlineFixture(t, "image/png")
				initial := []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "input_text", "text": "first"}, imagePart(inline), map[string]any{"type": "input_image", "image_url": "https://images.example/a", "mime_type": "image/jpeg"}}}}
				final := historyFinal(t, c, endpoint, historyPayload(tc.model, initial, "", stream), stream)
				id := str(final["id"])
				suffix := []any{map[string]string{"role": "user", "content": "second"}}
				historyFinal(t, c, endpoint, historyPayload(tc.model, suffix, id, stream), stream)
				full := append(append([]any{}, initial...), final["output"].([]any)...)
				full = append(full, suffix...)
				historyFinal(t, c, endpoint, historyPayload(tc.model, full, id, stream), stream)
				c.mu.Lock()
				before := append([]string{}, c.history.order...)
				size := c.history.bytes
				c.mu.Unlock()
				bad := []any{map[string]any{"role": "user", "content": []any{imagePart("data:image/png;base64,private-not-an-image")}}}
				code, body, _ := request(t, c, endpoint, "/v1/responses", "POST", historyPayload(tc.model, bad, id, stream), nil)
				if code != 400 || strings.TrimSpace(string(body)) != "unsupported_image_input" {
					t.Fatal("image error not fixed/redacted")
				}
				c.mu.Lock()
				if !reflect.DeepEqual(before, c.history.order) || size != c.history.bytes {
					t.Error("invalid image mutated history")
				}
				c.mu.Unlock()
				mu.Lock()
				defer mu.Unlock()
				_, data, _ := strings.Cut(inline, ",")
				if len(captures) != 3 || captures[1] != captures[2] || strings.Count(captures[1], data) != 1 || strings.Count(captures[1], "https://images.example/a") != 1 {
					t.Fatal("image history lost/duplicated or rejection sent upstream")
				}
			})
		}
	}
}

func TestImageDefaultAndNativeRequestsRemainExact(t *testing.T) {
	for _, mode := range []string{"passthrough", "momo-routing"} {
		payload := ` {"model":"gpt-5.6-sol","input":[{"role":"user","content":[{"type":"input_image","image_url":"data:image/not-local-supported;base64,opaque","detail":"original"}]}],"unknown":"中文🙂"} `
		response := ` {"opaque":"original synthetic bytes"} `
		c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			b, _ := io.ReadAll(r.Body)
			if string(b) != payload || r.URL.Path != "/v1/responses" {
				t.Error("native image mutated")
			}
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, response)
		}))
		c.Stop()
		if c.Configure(Config{Endpoint: "https://mock.example", APIKey: syntheticKey, Mode: mode}) != nil || c.Start() != nil {
			t.Fatal("configure")
		}
		code, b, _ := request(t, c, endpoint, "/v1/responses", "POST", payload, nil)
		if code != 200 || string(b) != response {
			t.Fatal("native image bytes")
		}
	}
}
