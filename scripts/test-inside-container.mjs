const t0 = Date.now();
console.log("Fetching https://momoapi.us/v1/responses inside container...");
try {
  const r = await fetch("https://momoapi.us/v1/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer sk-momo-demo-dummy-key-placeholder",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-5.4",
      stream: true,
      input: [{ role: "user", content: [{ type: "input_text", text: "Hi" }] }]
    })
  });
  console.log("Got response in", Date.now() - t0, "ms, status:", r.status);
  for await (const chunk of r.body) {
    console.log("Got chunk in", Date.now() - t0, "ms, size:", chunk.length);
    break;
  }
} catch (err) {
  console.error("Fetch failed:", err.message);
}
