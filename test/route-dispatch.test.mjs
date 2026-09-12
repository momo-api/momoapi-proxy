import test from "node:test";
import assert from "node:assert/strict";
import { classifyPublicRoute, isChatCompletionsRoute, isCompactRoute, isModelsRoute, isResponsesRoute } from "../src/route-dispatch.mjs";

const aliases = [
  [isModelsRoute, "GET", ["/v1/models", "/models"]],
  [isChatCompletionsRoute, "POST", ["/v1/chat/completions", "/chat/completions"]],
  [isCompactRoute, "POST", ["/v1/responses/compact", "/responses/compact"]],
  [isResponsesRoute, "POST", ["/v1/responses", "/responses"]],
];

test("public route predicates preserve both versioned and legacy aliases", () => {
  for (const [predicate, method, paths] of aliases) {
    for (const path of paths) assert.equal(predicate(method, path), true, `${method} ${path}`);
    assert.equal(predicate(method === "GET" ? "POST" : "GET", paths[0]), false);
    assert.equal(predicate(method, `${paths[0]}/extra`), false);
  }
});

test("public route classifier keeps compact ahead of the general responses route", () => {
  assert.equal(classifyPublicRoute("GET", "/v1/models"), "models");
  assert.equal(classifyPublicRoute("POST", "/v1/chat/completions"), "chat");
  assert.equal(classifyPublicRoute("POST", "/v1/responses/compact"), "compact");
  assert.equal(classifyPublicRoute("POST", "/v1/responses"), "responses");
  assert.equal(classifyPublicRoute("PUT", "/v1/responses"), null);
  assert.equal(classifyPublicRoute("POST", "/unknown"), null);
});
