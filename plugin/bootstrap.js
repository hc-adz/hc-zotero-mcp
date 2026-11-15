/* global Zotero, Services, Components, ChromeUtils */
/*
 * HC Zotero MCP — bootstrap entry point.
 * Starts a read-only MCP server (Streamable HTTP) on 127.0.0.1:<port>/mcp.
 */

const PREF_PREFIX = "extensions.hc-zotero-mcp.";
var zmcp = null;

function log(msg, isError) {
	const line = "[HC Zotero MCP] " + msg;
	Zotero.debug(line, isError ? 1 : 3);
	if (isError) Zotero.logError(line);
}

function install() {}
function uninstall() {}

async function startup({ id, version, rootURI }) {
	await Zotero.initializationPromise;
	if (Zotero.Schema && Zotero.Schema.schemaUpdatePromise) await Zotero.Schema.schemaUpdatePromise;

	const scope = {
		Zotero, Services, Components, ChromeUtils,
		TextEncoder, TextDecoder, URL, IOUtils, setTimeout, clearTimeout
	};
	for (const f of ["tools.js", "mcp.js", "zenv.js", "http.js"]) {
		Services.scriptloader.loadSubScript(rootURI + "content/" + f, scope);
	}

	const port = Zotero.Prefs.get(PREF_PREFIX + "port", true) || 37119;
	const token = Zotero.Prefs.get(PREF_PREFIX + "token", true) || "";

	const env = scope.ZMCPZoteroEnv.create({ pluginVersion: version });
	const tools = scope.ZMCPTools.create(env);
	const protocol = scope.ZMCPProtocol.create({
		tools,
		serverInfo: { name: "hc-zotero-mcp", title: "HC Zotero MCP", version },
		log
	});
	const server = scope.ZMCPHttp.create({
		port,
		token,
		protocol,
		log,
		health: () => ({ status: "ok", server: "hc-zotero-mcp", version, endpoint: `http://127.0.0.1:${port}/mcp`, auth: !!token })
	});
	try {
		server.start();
	}
	catch (e) {
		log(`Could not listen on 127.0.0.1:${port} (${e}). Is another program using it? `
			+ `Change ${PREF_PREFIX}port in Settings > Advanced > Config Editor and restart Zotero.`, true);
	}
	zmcp = { server };
}

function shutdown() {
	if (zmcp) {
		try { zmcp.server.stop(); } catch (e) {}
		zmcp = null;
	}
}
