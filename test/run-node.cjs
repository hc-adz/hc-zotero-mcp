// Exercises every tool through the MCP protocol layer against a COPY of a Zotero database.
// Usage: node test/run-node.cjs <dir containing zotero.sqlite [+ fulltext.sqlite]> [zoteroDataDir for file checks]
const path = require("node:path");
const assert = require("node:assert/strict");
const { createEnv } = require("./node-env.cjs");
globalThis.ZMCPTools = require("../plugin/content/tools.js");
const ZMCPProtocol = require("../plugin/content/mcp.js");

const dbDir = process.argv[2];
const dataDir = process.argv[3] || dbDir;
if (!dbDir) {
	console.error("usage: node test/run-node.cjs <dbCopyDir> [dataDir]");
	process.exit(2);
}

(async () => {
	const env = createEnv({
		dbPath: path.join(dbDir, "zotero.sqlite"),
		fulltextPath: path.join(dbDir, "fulltext.sqlite"),
		dataDir
	});
	const tools = ZMCPTools.create(env);
	const proto = ZMCPProtocol.create({ tools, serverInfo: { name: "t", version: "0" }, log: (m, e) => e && console.error(m) });
	let id = 0;
	const rpc = async (method, params) => {
		const res = await proto.handleBody(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }));
		return JSON.parse(res.body);
	};
	const call = async (name, args, { expectError = false, show = true } = {}) => {
		const t0 = performance.now();
		const r = await rpc("tools/call", { name, arguments: args });
		const ms = (performance.now() - t0).toFixed(1);
		const text = r.result.content[0].text;
		const data = JSON.parse(text);
		assert.equal(!!r.result.isError, expectError, `${name} ${JSON.stringify(args)} -> ${text.slice(0, 400)}`);
		if (show) console.log(`\n### ${name} ${JSON.stringify(args)}  (${ms} ms, ${text.length} chars)\n${text.slice(0, 1400)}`);
		return data;
	};

	// --- protocol
	const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } });
	assert.equal(init.result.protocolVersion, "2025-06-18");
	const init2 = await rpc("initialize", { protocolVersion: "1999-01-01" });
	assert.equal(init2.result.protocolVersion, ZMCPProtocol.SUPPORTED_VERSIONS[0]);
	assert.equal((await proto.handleBody('{"jsonrpc":"2.0","method":"notifications/initialized"}')).status, 202);
	assert.equal((await proto.handleBody("{bad json")).status, 400);
	const batch = JSON.parse((await proto.handleBody(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/x" }]))).body);
	assert.equal(batch.length, 1);
	assert.equal((await rpc("nope")).error.code, -32601);
	const list = await rpc("tools/list", {});
	console.log("tools:", list.result.tools.map(t => t.name).join(", "));

	// --- safety guard
	const { assertReadOnly } = tools._internal;
	for (const bad of ["DELETE FROM items", "SELECT 1; DELETE FROM items", "UPDATE items SET key='x'", "PRAGMA writable_schema=1",
		"WITH x AS (SELECT 1) DELETE FROM items", "ATTACH DATABASE 'x' AS y", "INSERT INTO tags VALUES (1,'a',null)"]) {
		assert.throws(() => assertReadOnly(bad), /refusing/, bad);
	}
	assertReadOnly("SELECT itemID FROM deletedItems WHERE dateDeleted > 0");

	// --- query parsing
	const pq = tools._internal.parseQuery('"machine learning"|"deep learning" fairness OR bias -survey the');
	assert.deepEqual(pq.clauses.map(c => c.map(a => a.text)), [["machine learning", "deep learning"], ["fairness", "bias"]]);
	assert.deepEqual(pq.excludes.map(a => a.text), ["survey"]);

	// --- tools
	const info = await call("library_info", {});
	assert.ok(info.libraries.length >= 1);
	await call("list_collections", {});
	await call("list_tags", { limit: 15 });
	await call("list_tags", { query: "learn", limit: 5 });

	const s1 = await call("search_items", { query: "online learning", limit: 5 });
	assert.ok(s1.total > 0, "expected results for 'online learning'");
	await call("search_items", { query: "\"collaborative learning\"|\"cooperative learning\" nurse", limit: 5, includeAbstract: true, abstractChars: 200 });
	await call("search_items", { query: "persistence doctoral -nebraska", limit: 3 });
	await call("search_items", { query: "learning analytics", fields: ["title", "tags"], limit: 3 });
	await call("search_items", { query: "learning analytics dashboards", fulltext: false, limit: 3 });
	const relaxed = await call("search_items", { query: "qzxv learning", limit: 3 });
	assert.ok(relaxed.total > 0 && relaxed.fullMatches === 0, "best mode should return partial matches");
	const strict = await call("search_items", { query: "qzxv learning", mode: "all" }, { show: false });
	assert.equal(strict.total, 0);
	const st = tools._internal.parseQuery("experimental practices teaching \"teaching practices\"").clauses.map(c => c[0].match);
	assert.deepEqual(st, ["experiment", "practic", "teach", "teaching practices"]);
	await call("search_items", { concepts: [["experiment", "randomized"], "AI|chatgpt"], yearFrom: 2026, limit: 3 });
	await call("search_items", { concepts: "nope" }, { expectError: true });
	await call("search_items", { query: "gasevic", limit: 3 }); // diacritic-insensitive (Gašević)
	await call("search_items", { limit: 3, sort: "dateAdded" });
	await call("search_items", { limit: 3, sort: "year", yearFrom: 2015, yearTo: 2020, itemTypes: ["journalArticle"] });
	await call("search_items", { limit: 3, sort: "title" });
	await call("search_items", { query: "learning", sort: "title", limit: 3 });
	await call("search_items", { itemTypes: ["bogus"] }, { expectError: true });
	await call("search_items", { query: "x", fields: ["nope"] }, { expectError: true });

	const firstTag = (await call("list_tags", { limit: 1 }, { show: false })).tags[0];
	if (firstTag) {
		const t = await call("search_items", { tags: [firstTag.tag.toUpperCase()], limit: 2 });
		assert.ok(t.total >= 1, "tag filter should be case-insensitive");
	}
	const colls = (await call("list_collections", {}, { show: false })).collections;
	if (colls.length) {
		await call("search_items", { collection: colls[0].key, limit: 3 });
		await call("search_items", { collection: colls[0].name, query: "learning", limit: 3 });
	}

	// items with PDFs / annotations / notes
	const withPdf = env.db.prepare("SELECT P.key FROM itemAttachments A JOIN items P ON P.itemID=A.parentItemID WHERE A.contentType='application/pdf' AND A.linkMode IN (0,1) LIMIT 1").get();
	const anyKeys = env.db.prepare("SELECT key FROM items I WHERE itemTypeID NOT IN (SELECT itemTypeID FROM itemTypesCombined WHERE typeName IN ('attachment','note','annotation')) LIMIT 3").all().map(r => r.key);
	await call("get_items", { keys: [...anyKeys, "ZZZZZZZZ"], noteChars: 300 });
	if (withPdf) {
		const a = await call("get_attachments", { keys: withPdf.key });
		assert.ok(a.items[0].attachments.length >= 1);
	}
	const withNote = env.db.prepare("SELECT P.key FROM itemNotes N JOIN items P ON P.itemID=N.parentItemID LIMIT 1").get();
	if (withNote) await call("get_items", { keys: withNote.key, noteChars: 200 });
	const withAnn = env.db.prepare("SELECT I.key FROM itemAnnotations AN JOIN items I ON I.itemID=AN.parentItemID LIMIT 1").get();
	if (withAnn) await call("get_annotations", { keys: withAnn.key });
	await call("get_items", { keys: ["bad"] }, { expectError: true });

	// --- timing: repeated searches (statement cache warm)
	const terms = ["learning", "online", "student engagement", "assessment|evaluation feedback", "\"higher education\"", "motivation"];
	const times = [];
	for (let i = 0; i < 3; i++) {
		for (const t of terms) {
			const t0 = performance.now();
			await tools.call("search_items", { query: t, limit: 20 });
			times.push(performance.now() - t0);
		}
	}
	times.sort((a, b) => a - b);
	console.log(`\nsearch timing over ${times.length} runs: median ${times[times.length >> 1].toFixed(1)} ms, max ${times[times.length - 1].toFixed(1)} ms`);
	const nonSelect = env.queries.filter(s => !/^\s*SELECT\b/i.test(s));
	assert.deepEqual(nonSelect, [], "only SELECT statements may be issued");
	console.log(`\nALL CHECKS PASSED (${env.queries.length} SELECT statements issued, none other)`);
})().catch((e) => {
	console.error("FAILED:", e);
	process.exit(1);
});
