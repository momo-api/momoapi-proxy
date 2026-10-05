package appcore

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"net"
	"net/url"
	"strings"

	_ "golang.org/x/image/webp"
)

var errUnsupportedImage = errors.New("unsupported_image_input")

// No file reads, image fetching, redirects, or proxy-side image execution.
// URLs are references delegated to the upstream; lexical checks are not DNS/
// redirect or image-content validation. Inline data is header-checked, not decoded
// to a full pixel buffer. The global request/history budget remains authoritative.
type routeImage struct{ url, mime, data, detail string }
type imageBudget struct{ count, bytes int }

func parseRouteImage(m map[string]any, model string, budget *imageBudget) (*routeImage, error) {
	if !only(m, "type", "image_url", "detail", "mime_type") || m["type"] != "input_image" {
		return nil, errUnsupportedImage
	}
	s, ok := m["image_url"].(string)
	if !ok || s == "" {
		return nil, errUnsupportedImage
	}
	detail := ""
	if v, present := m["detail"]; present {
		detail, ok = v.(string)
		if !ok || (detail != "auto" && detail != "low" && detail != "high") {
			return nil, errUnsupportedImage
		}
	}
	if resolveProtocol(model) != "chat" && detail != "" && detail != "auto" {
		return nil, errUnsupportedImage
	} // never erase a requested quality contract
	mime := ""
	if v, present := m["mime_type"]; present {
		mime, ok = v.(string)
		if !ok || !imageMIME(mime) {
			return nil, errUnsupportedImage
		}
	}
	result := &routeImage{url: s, mime: mime, detail: detail}
	if strings.HasPrefix(s, "data:") {
		meta, encoded, found := strings.Cut(s, ",")
		if !found {
			return nil, errUnsupportedImage
		}
		inlineMIME := strings.TrimSuffix(strings.TrimPrefix(meta, "data:"), ";base64")
		if meta != "data:"+inlineMIME+";base64" || !imageMIME(inlineMIME) || mime != "" && mime != inlineMIME {
			return nil, errUnsupportedImage
		}
		if strings.ContainsAny(encoded, "\r\n\t ") || len(encoded) > MaxRequest {
			return nil, errUnsupportedImage
		}
		data, err := base64.StdEncoding.Strict().DecodeString(encoded)
		if err != nil || len(data) == 0 || base64.StdEncoding.EncodeToString(data) != encoded {
			return nil, errUnsupportedImage
		}
		cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
		if err != nil || "image/"+format != inlineMIME || cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width > 16384 || cfg.Height > 16384 || int64(cfg.Width)*int64(cfg.Height) > 32_000_000 {
			return nil, errUnsupportedImage
		}
		if format == "gif" && !singleFrameGIF(data) {
			return nil, errUnsupportedImage
		}
		if format == "webp" && !staticWebP(data) {
			return nil, errUnsupportedImage
		}
		result.mime, result.data = inlineMIME, encoded
		budget.bytes += len(data)
	} else {
		u, err := url.Parse(s)
		if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Fragment != "" || u.Opaque != "" || u.Port() != "" && u.Port() != "443" || len(s) > 8192 {
			return nil, errUnsupportedImage
		}
		host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
		if host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") || !strings.Contains(host, ".") && net.ParseIP(host) == nil {
			return nil, errUnsupportedImage
		}
		if ip := net.ParseIP(host); ip != nil && !publicIP(ip) {
			return nil, errUnsupportedImage
		}
		// Reject alternate numeric spellings (127.1, 2130706433) rather than
		// assuming every provider resolves them as ordinary DNS names.
		if net.ParseIP(host) == nil && strings.Trim(host, "0123456789.") == "" {
			return nil, errUnsupportedImage
		}
		if resolveProtocol(model) == "gemini" && mime == "" {
			return nil, errUnsupportedImage
		} // fileData requires explicit MIME, never guess from URL suffix
	}
	budget.count++
	if budget.count > 32 || budget.bytes > MaxRequest {
		return nil, errUnsupportedImage
	}
	return result, nil
}

// Validate bounded RIFF chunk framing and reject animation flags/chunks. Do
// not decode pixels or claim payload integrity based only on these headers.
func staticWebP(data []byte) bool {
	if len(data) < 12 || string(data[:4]) != "RIFF" || string(data[8:12]) != "WEBP" || uint64(binary.LittleEndian.Uint32(data[4:8]))+8 != uint64(len(data)) {
		return false
	}
	for pos := 12; pos < len(data); {
		if pos+8 > len(data) {
			return false
		}
		kind := string(data[pos : pos+4])
		size := uint64(binary.LittleEndian.Uint32(data[pos+4 : pos+8]))
		start := pos + 8
		end := uint64(start) + size
		if end > uint64(len(data)) || kind == "ANIM" || kind == "ANMF" {
			return false
		}
		if kind == "VP8X" && (size != 10 || data[start]&2 != 0) {
			return false
		}
		pos = int(end + size%2)
		if pos > len(data) {
			return false
		}
	}
	return true
}

// Scan bounded GIF framing without allocating any pixel/frame buffers. This
// rejects animated GIFs; neither this nor DecodeConfig proves full pixel data.
func singleFrameGIF(data []byte) bool {
	if len(data) < 13 {
		return false
	}
	pos := 13
	if data[10]&0x80 != 0 {
		pos += 3 * (1 << (int(data[10]&7) + 1))
	}
	frames := 0
	skipBlocks := func() bool {
		for pos < len(data) {
			n := int(data[pos])
			pos++
			if n == 0 {
				return true
			}
			pos += n
			if pos > len(data) {
				return false
			}
		}
		return false
	}
	for pos < len(data) {
		marker := data[pos]
		pos++
		switch marker {
		case 0x3b:
			return frames == 1 && pos == len(data)
		case 0x21:
			if pos >= len(data) {
				return false
			}
			pos++ // extension label
			if !skipBlocks() {
				return false
			}
		case 0x2c:
			frames++
			if frames != 1 || pos+9 > len(data) {
				return false
			}
			// A single frame must lie inside the logical screen.
			left, top := int(binary.LittleEndian.Uint16(data[pos:])), int(binary.LittleEndian.Uint16(data[pos+2:]))
			width, height := int(binary.LittleEndian.Uint16(data[pos+4:])), int(binary.LittleEndian.Uint16(data[pos+6:]))
			if width == 0 || height == 0 || left+width > int(binary.LittleEndian.Uint16(data[6:])) || top+height > int(binary.LittleEndian.Uint16(data[8:])) {
				return false
			}
			packed := data[pos+8]
			pos += 9
			if packed&0x80 != 0 {
				pos += 3 * (1 << (int(packed&7) + 1))
			}
			if pos >= len(data) || data[pos] < 2 || data[pos] > 8 {
				return false
			}
			pos++ // LZW minimum code size
			if !skipBlocks() {
				return false
			}
		default:
			return false
		}
	}
	return false
}

func imageMIME(s string) bool {
	return s == "image/png" || s == "image/jpeg" || s == "image/gif" || s == "image/webp"
}

func messageParts(v any, role, model string, budget *imageBudget) (string, []routePart, error) {
	// Preserve the pre-existing text-only wire representation/goldens unchanged.
	if text, err := textParts(v); err == nil {
		return text, []routePart{{text: text}}, nil
	}
	values, ok := v.([]any)
	if !ok || role != "user" {
		return "", nil, errUnsupportedImage
	}
	parts := []routePart{}
	texts := []string{}
	for _, value := range values {
		m := obj(value)
		if m == nil {
			return "", nil, errRouted
		}
		if m["type"] == "input_image" {
			img, err := parseRouteImage(m, model, budget)
			if err != nil {
				return "", nil, err
			}
			parts = append(parts, routePart{image: img})
		} else {
			text, err := textParts([]any{value})
			if err != nil {
				return "", nil, err
			}
			texts = append(texts, text)
			parts = append(parts, routePart{text: text})
		}
	}
	return strings.Join(texts, "\n"), parts, nil
}

func hasImages(parts []routePart) bool {
	for _, part := range parts {
		if part.image != nil {
			return true
		}
	}
	return false
}
