package integration

import (
	"strings"
	"testing"
)

func TestGeminiStateContract(t *testing.T) {
	capability, ok := Capabilities()["gemini_state"].(string)
	if !ok {
		t.Fatal("missing Gemini state contract")
	}
	for _, s := range []string{"thought:true", "momo_gemini", "same-model", "signature-only", "provider"} {
		if !strings.Contains(capability, s) || !strings.Contains(Skill, s) {
			t.Fatal("missing state boundary", s)
		}
	}
	controls, ok := Capabilities()["gemini_thinking"].(string)
	if !ok {
		t.Fatal("missing Gemini controls")
	}
	for _, s := range []string{"momo_gemini_thinking", "includeThoughts", "thinkingLevel", "thinkingBudget", "generateContent", "per-request", "xhigh/max/ultra/none"} {
		if !strings.Contains(controls, s) || !strings.Contains(Skill, s) {
			t.Fatal("missing thinking boundary", s)
		}
	}
}
