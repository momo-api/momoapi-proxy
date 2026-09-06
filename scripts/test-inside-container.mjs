const t0 = Date.now();
const apiKey = process.env.MOMO_API_KEY;
if (!apiKey) throw new Error("MOMO_API_KEY is required for the container connectivity test.");
console.log("Fetching https://momoapi.us/v1/responses inside container...");
try {
  const r = await fetch("https://momoapi.us/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
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
