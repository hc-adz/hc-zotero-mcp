/*
 * HC Zotero MCP — MCP (JSON-RPC 2.0) protocol layer for the Streamable HTTP transport.
 * Stateless: no sessions, no server-initiated messages, every POST gets a single JSON response.
 */
var ZMCPProtocol = (function () {
	"use strict";

	const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

	const INSTRUCTIONS = "Read-only access to the user's local Zotero library. Search is lexical, so for topical "
		+ "questions expand each concept into many synonyms (search_items `concepts`), and when filters (year, collection, "
		+ "item type, tags) narrow the library to a manageable set, also browse that set with includeAbstract=true and "
		+ "judge relevance yourself — this finds items that never use the query's words. Run several searches with "
		+ "different vocabularies before concluding something is absent. Then: get_items for metadata/notes, "
		+ "get_attachments for absolute file paths. To read a document, prefer the attachment's `fulltextCachePath` "
		+ "(Zotero's extracted plain text) and fall back to `path`. All responses are JSON. Item keys are 8-character strings.";

	function create({ tools, serverInfo, log }) {
		const rpcError = (id, code, message, data) =>
			({ jsonrpc: "2.0", id: id ?? null, error: data === undefined ? { code, message } : { code, message, data } });
		const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });

		async function handleMessage(msg) {
			if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
				return rpcError(msg && msg.id, -32600, "Invalid Request");
			}
			const isNotification = !("id" in msg);
			// Responses from the client (we never send requests) and notifications need no reply
			if (!("method" in msg)) return null;
			if (isNotification) return null;

			const { id, method } = msg;
			const params = msg.params || {};
			try {
				switch (method) {
					case "initialize": {
						const requested = params.protocolVersion;
						const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
						return rpcResult(id, {
							protocolVersion,
							capabilities: { tools: { listChanged: false } },
							serverInfo,
							instructions: INSTRUCTIONS
						});
					}
					case "ping":
						return rpcResult(id, {});
					case "tools/list":
						return rpcResult(id, {
							tools: tools.definitions.map(d => ({
								name: d.name,
								title: d.title,
								description: d.description,
								inputSchema: d.inputSchema,
								annotations: d.annotations
							}))
						});
					case "tools/call": {
						const name = params.name;
						if (typeof name !== "string" || !tools.definitions.some(d => d.name === name)) {
							return rpcError(id, -32602, `Unknown tool: ${name}`);
						}
						const t0 = Date.now();
						try {
							const result = await tools.call(name, params.arguments || {});
							log && log(`${name} ok in ${Date.now() - t0} ms`);
							return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(result) }], isError: false });
						}
						catch (e) {
							const expected = e instanceof ZMCPTools.ToolError;
							if (!expected && log) log(`${name} failed: ${e && e.stack || e}`, true);
							return rpcResult(id, {
								content: [{ type: "text", text: JSON.stringify({ error: String(e && e.message || e) }) }],
								isError: true
							});
						}
					}
					case "resources/list":
						return rpcResult(id, { resources: [] });
					case "resources/templates/list":
						return rpcResult(id, { resourceTemplates: [] });
					case "prompts/list":
						return rpcResult(id, { prompts: [] });
					default:
						return rpcError(id, -32601, `Method not found: ${method}`);
				}
			}
			catch (e) {
				log && log(`Internal error in ${method}: ${e && e.stack || e}`, true);
				return rpcError(id, -32603, "Internal error", String(e && e.message || e));
			}
		}

		/** @return {Promise<{status:number, body:string|null}>} */
		async function handleBody(text) {
			let parsed;
			try {
				parsed = JSON.parse(text);
			}
			catch (e) {
				return { status: 400, body: JSON.stringify(rpcError(null, -32700, "Parse error")) };
			}
			if (Array.isArray(parsed)) {
				if (!parsed.length) return { status: 400, body: JSON.stringify(rpcError(null, -32600, "Invalid Request")) };
				const out = (await Promise.all(parsed.map(handleMessage))).filter(Boolean);
				return out.length ? { status: 200, body: JSON.stringify(out) } : { status: 202, body: null };
			}
			const res = await handleMessage(parsed);
			return res ? { status: 200, body: JSON.stringify(res) } : { status: 202, body: null };
		}

		return { handleBody, handleMessage };
	}

	return { create, SUPPORTED_VERSIONS };
})();

if (typeof module !== "undefined") module.exports = ZMCPProtocol;
