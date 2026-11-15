// Live end-to-end test against the plugin running inside Zotero.
// Usage: node test/smoke-live.cjs [baseUrl=http://127.0.0.1:37119] [token]
const assert = require("node:assert/strict");
const base = process.argv[2] || "http://127.0.0.1:37119";
const token = process.argv[3] || "";
const auth = token ? { Authorization: `Bearer ${token}` } : {};

async function post(body, headers = {}) {
	const r = await fetch(base + "/mcp", {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...auth, ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body)
	});
	const text = await r.text();
	return { status: r.status, text, json: text ? JSON.parse(text) : null };
}

(async () => {
	const health = await (await fetch(base + "/health")).json();
	console.log("health:", health);

	const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } });
	assert.equal(init.status, 200);
	console.log("initialize:", init.json.result.serverInfo, init.json.result.protocolVersion);
	assert.equal((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);

	const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
	console.log("tools:", list.json.result.tools.map(t => t.name).join(", "));

	let id = 10;
	const call = async (name, args) => {
		const t0 = performance.now();
		const r = await post({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } });
		const ms = (performance.now() - t0).toFixed(1);
		assert.equal(r.status, 200);
		const text = r.json.result.content[0].text;
		console.log(`\n### ${name} ${JSON.stringify(args)} (${ms} ms round trip)\n${text.slice(0, 900)}`);
		assert.ok(!r.json.result.isError, text);
		return JSON.parse(text);
	};
	await call("library_info", {});
	const s = await call("search_items", { query: "learning", limit: 3 });
	await call("search_items", { query: "\"higher education\" assessment|evaluation", limit: 3, includeAbstract: true, abstractChars: 150 });
	if (s.items[0]) {
		await call("get_items", { keys: s.items.map(i => i.key), noteChars: 200 });
		await call("get_attachments", { keys: s.items.map(i => i.key) });
		await call("get_annotations", { keys: s.items[0].key, limit: 5 });
	}
	await call("list_tags", { limit: 5 });
	await call("list_collections", { limit: 5 });

	// Non-ASCII round trip (UTF-8 request + response)
	await call("search_items", { query: "Gašević", limit: 2 });

	// Transport/security behaviour
	assert.equal((await fetch(base + "/mcp")).status, 405, "GET /mcp should be 405");
	assert.equal((await post({ jsonrpc: "2.0", id: 99, method: "ping" }, { Origin: "https://evil.example" })).status, 403, "foreign Origin should be 403");
	assert.equal((await post("{not json")).status, 400);
	const big = await post({ jsonrpc: "2.0", id: 100, method: "tools/call", params: { name: "search_items", arguments: { query: "the", limit: 200, includeAbstract: true } } });
	console.log(`\nlarge response: ${big.text.length} chars, status ${big.status}`);

	// Latency
	const times = [];
	for (let i = 0; i < 20; i++) {
		const t0 = performance.now();
		await post({ jsonrpc: "2.0", id: 1000 + i, method: "tools/call", params: { name: "search_items", arguments: { query: ["learning", "online", "student motivation", "assessment"][i % 4], limit: 20 } } });
		times.push(performance.now() - t0);
	}
	times.sort((a, b) => a - b);
	console.log(`\nround-trip search latency: median ${times[10].toFixed(1)} ms, max ${times[19].toFixed(1)} ms`);
	console.log("\nLIVE SMOKE TEST PASSED");
})().catch((e) => {
	console.error("FAILED:", e);
	process.exit(1);
});
