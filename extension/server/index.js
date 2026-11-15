#!/usr/bin/env node
/*
 * HC Zotero MCP — Claude Desktop extension (stdio bridge).
 *
 * Claude Desktop talks to local extensions over stdio; the Zotero plugin serves MCP over HTTP on
 * 127.0.0.1. This bridge reads newline-delimited JSON-RPC from stdin, POSTs each message to the
 * plugin, and writes the replies to stdout. No dependencies: Node's built-in fetch only.
 *
 * If Zotero isn't running, the bridge still answers initialize / tools/list from a snapshot taken
 * at build time (fallback.json), so Claude Desktop starts cleanly in any order, and tool calls
 * return a plain-language "open Zotero" message instead of failing.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

// Unset user_config values may arrive as a literal "${user_config.x}" placeholder
const envValue = (name) => {
	const v = (process.env[name] || "").trim();
	return v.startsWith("${") ? "" : v;
};

const port = (() => {
	const n = parseInt(envValue("HC_ZOTERO_MCP_PORT"), 10);
	return Number.isInteger(n) && n > 0 && n < 65536 ? n : 37119;
})();
const token = envValue("HC_ZOTERO_MCP_TOKEN");
const endpoint = `http://127.0.0.1:${port}/mcp`;
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

const fallback = JSON.parse(fs.readFileSync(path.join(__dirname, "fallback.json"), "utf8"));

const OFFLINE_TEXT = `Zotero isn't reachable at ${endpoint}. Ask the user to open Zotero (and make sure the `
	+ `HC Zotero MCP plugin is installed and enabled under Tools → Plugins), then try again.`;
const AUTH_TEXT = "Zotero rejected the access token. The token in Claude's extension settings for HC Zotero MCP "
	+ "must match extensions.hc-zotero-mcp.token in Zotero's Config Editor.";

const log = (...a) => console.error("[hc-zotero-mcp]", ...a);

class HttpStatusError extends Error {
	constructor(status, body) {
		super(`HTTP ${status}`);
		this.status = status;
		this.body = body;
	}
}

async function post(msg) {
	const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
	if (token) headers.Authorization = `Bearer ${token}`;
	const res = await fetch(endpoint, {
		method: "POST",
		headers,
		body: JSON.stringify(msg),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
	});
	const text = await res.text();
	if (res.status === 202) return null;
	if (res.status !== 200) throw new HttpStatusError(res.status, text);
	return JSON.parse(text);
}

function rpcError(id, code, message) {
	return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

// Reply locally when the plugin can't be reached (or refuses us)
function localReply(msg, problemText) {
	if (!msg || typeof msg !== "object" || !("id" in msg) || !("method" in msg)) return null;
	const { id, method } = msg;
	const params = msg.params || {};
	switch (method) {
		case "initialize": {
			const init = fallback.initialize;
			const protocolVersion = fallback.supportedVersions.includes(params.protocolVersion)
				? params.protocolVersion : fallback.supportedVersions[0];
			return { jsonrpc: "2.0", id, result: { ...init, protocolVersion } };
		}
		case "ping":
			return { jsonrpc: "2.0", id, result: {} };
		case "tools/list":
			return { jsonrpc: "2.0", id, result: { tools: fallback.tools } };
		case "tools/call":
			return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: problemText }], isError: true } };
		case "resources/list":
			return { jsonrpc: "2.0", id, result: { resources: [] } };
		case "resources/templates/list":
			return { jsonrpc: "2.0", id, result: { resourceTemplates: [] } };
		case "prompts/list":
			return { jsonrpc: "2.0", id, result: { prompts: [] } };
		default:
			return rpcError(id, -32603, problemText);
	}
}

async function handle(msg) {
	try {
		return await post(msg);
	}
	catch (e) {
		if (e instanceof HttpStatusError) {
			if (e.status === 401) return localReply(msg, AUTH_TEXT);
			log(`Zotero replied ${e.status}: ${String(e.body).slice(0, 300)}`);
			return localReply(msg, `Zotero replied with HTTP ${e.status}: ${String(e.body).slice(0, 300)}`);
		}
		log(`Can't reach ${endpoint}: ${e && (e.cause && e.cause.code || e.message) || e}`);
		return localReply(msg, OFFLINE_TEXT);
	}
}

function write(obj) {
	if (obj == null || (Array.isArray(obj) && !obj.length)) return;
	process.stdout.write(JSON.stringify(obj) + "\n");
}

// When stdin closes, the process exits by itself once in-flight requests finish. (Calling
// process.exit() while fetch sockets are still closing trips a libuv assertion on Windows.)
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
	if (!line.trim()) return;
	let msg;
	try {
		msg = JSON.parse(line);
	}
	catch (e) {
		write(rpcError(null, -32700, "Parse error"));
		return;
	}
	const job = Array.isArray(msg)
		? Promise.all(msg.map(handle)).then(r => r.filter(Boolean))
		: handle(msg);
	job.then(write, (e) => log("Unexpected error:", e && e.stack || e));
});

log(`Bridging stdio to ${endpoint}${token ? " (with token)" : ""}`);
