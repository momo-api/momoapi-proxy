import test from "node:test";
import assert from "node:assert/strict";
import { buildMuseChatBody, extractStrictCodexPatch, hasApplyPatchTool, latestMuseUserTask, MUSE_PATCH_LIMITS } from "../src/muse-adapter.mjs";

const validAdd = "*** Begin Patch\n*** Add File: notes/ok.txt\n+hello\n+world\n*** End Patch";

test("detects only exact custom apply_patch declarations", () => {
  assert.equal(hasApplyPatchTool({ tools: [{ type: "custom", name: "apply_patch" }] }), true);
  assert.equal(hasApplyPatchTool({ additional_tools: [{ type: "custom", name: "apply_patch" }] }), false);
  assert.equal(hasApplyPatchTool({ tools: [{ type: "function", name: "apply_patch" }] }), false);
  assert.equal(hasApplyPatchTool({ tools: [{ type: "custom", name: "Apply_Patch" }] }), false);
});

test("extracts one exact valid patch", () => {
  assert.equal(extractStrictCodexPatch(validAdd), validAdd);
  assert.equal(extractStrictCodexPatch(validAdd + "\n"), validAdd);
});

test("rejects text outside, multiple, nested, and incomplete patches", () => {
  assert.equal(extractStrictCodexPatch("here\n" + validAdd), null);
  assert.equal(extractStrictCodexPatch(validAdd + "\n" + validAdd), null);
  assert.equal(extractStrictCodexPatch("*** Begin Patch\n*** Begin Patch\n*** End Patch\n*** End Patch"), null);
  assert.equal(extractStrictCodexPatch("*** Begin Patch\n*** Add File: a.txt\n+x"), null);
});

test("validates all patch paths", () => {
  for (const header of [
    "*** Add File: /tmp/x", "*** Update File: C:/x", "*** Delete File: ../x",
    "*** Move to: dir/../x", "*** Add File: \\\\server\\share\\x", "*** Add File: dir\\x",
    "*** Add File: name:stream", "*** Add File: ./../x",
  ]) assert.equal(extractStrictCodexPatch("*** Begin Patch\n" + header + "\n+x\n*** End Patch"), null, header);
});

test("requires plus-prefixed Add File body lines", () => {
  assert.equal(extractStrictCodexPatch("*** Begin Patch\n*** Add File: a.txt\nhello\n*** End Patch"), null);
  assert.equal(extractStrictCodexPatch("*** Begin Patch\n*** Add File: a.txt\n+hello\n+\n*** End Patch"), "*** Begin Patch\n*** Add File: a.txt\n+hello\n+\n*** End Patch");
});

test("accepts update delete and move path headers when safe", () => {
  const patch = "*** Begin Patch\n*** Update File: src/a.js\n*** Move to: src/b.js\n@@\n-old\n+new\n*** Delete File: old/a.js\n*** End Patch";
  assert.equal(extractStrictCodexPatch(patch), patch);
});

test("rejects controls unicode separators and configured limits", () => {
  assert.equal(extractStrictCodexPatch(validAdd.replace("notes/ok.txt", "notes/\u0000ok.txt")), null);
  assert.equal(extractStrictCodexPatch(validAdd + "\u2028"), null);
  const longLine = "+" + "a".repeat(MUSE_PATCH_LIMITS.maxLineBytes + 1);
  assert.equal(extractStrictCodexPatch("*** Begin Patch\n*** Add File: a.txt\n" + longLine + "\n*** End Patch"), null);
  const manyFiles = ["*** Begin Patch", ...Array.from({ length: MUSE_PATCH_LIMITS.maxFiles + 1 }, (_, index) => "*** Delete File: x/" + index), "*** End Patch"].join("\n");
  assert.equal(extractStrictCodexPatch(manyFiles), null);
});

test("extracts only the latest real user text task", () => {
  const input = [
    { role: "user", content: [{ type: "input_text", text: "old" }] },
    { type: "custom_tool_call", name: "exec", input: "ignored" },
    { type: "custom_tool_call_output", call_id: "c", output: "ignored" },
    { type: "additional_tools", tools: [] },
    { role: "assistant", content: [{ type: "output_text", text: "ignored" }] },
    { role: "user", content: [{ type: "input_text", text: "latest" }, { type: "input_image", image_url: "x" }] },
  ];
  assert.equal(latestMuseUserTask(input), "latest");
  assert.equal(latestMuseUserTask([{ type: "function_call_output", output: "no" }]), "");
});

test("builds a stripped chat request with a strict system contract", () => {
  const body = buildMuseChatBody({ model: "muse-auto", instructions: "cloud noise", input: [{ role: "user", content: [{ type: "input_text", text: "edit a.txt" }] }], tools: [{ type: "custom", name: "apply_patch" }] });
  assert.equal(body.model, "muse-auto");
  assert.equal(body.stream, true);
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, "system");
  assert.match(body.messages[0].content, /no access|cannot access|do not claim/i);
  assert.match(body.messages[0].content, /\*\*\* Begin Patch/);
  assert.deepEqual(body.messages[1], { role: "user", content: "edit a.txt" });
  assert.equal("tools" in body, false);
});


