// Packs plugin/ into dist/hc-zotero-mcp-<version>.xpi (a zip with forward-slash paths), packs
// extension/ into dist/hc-zotero-mcp-<version>.mcpb (Claude Desktop extension), then wraps both in
// dist/hc-zotero-mcp-<version>.zip for release downloads (browsers try to install a bare .xpi as a
// browser extension).
// No dependencies: uses Node's zlib for deflate + crc32.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const root = path.join(__dirname, "..");
const src = path.join(root, "plugin");
const version = JSON.parse(fs.readFileSync(path.join(src, "manifest.json"), "utf8")).version;
const base = `hc-zotero-mcp-${version}`;
const xpiOut = path.join(root, "dist", `${base}.xpi`);
const zipOut = path.join(root, "dist", `${base}.zip`);

function walk(dir, prefix = "") {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const rel = prefix ? `${prefix}/${e.name}` : e.name;
		return e.isDirectory() ? walk(path.join(dir, e.name), rel) : [rel];
	}).sort();
}

// entries: [{ name: "a/b.js", data: Buffer }] -> zip Buffer
function makeZip(entries) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const { name, data } of entries) {
		const comp = zlib.deflateRawSync(data, { level: 9 });
		const crc = zlib.crc32(data);
		const nameBuf = Buffer.from(name, "utf8");
		const h = Buffer.alloc(30);
		h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);
		h.writeUInt16LE(0, 10); h.writeUInt16LE(0x21, 12); h.writeUInt32LE(crc, 14);
		h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nameBuf.length, 26); h.writeUInt16LE(0, 28);
		locals.push(h, nameBuf, comp);
		const c = Buffer.alloc(46);
		// "Version made by" = 3.0 on UNIX (0x031E) so extractors honor the rw-r--r-- mode below
		c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(0x031E, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
		c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20);
		c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nameBuf.length, 28);
		c.writeUInt32LE(((0o100644 << 16) >>> 0), 38); c.writeUInt32LE(offset, 42);
		centrals.push(c, nameBuf);
		offset += 30 + nameBuf.length + comp.length;
	}
	const cd = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, cd, end]);
}

// ---- Zotero plugin (.xpi)
const files = walk(src);
const xpi = makeZip(files.map(name => ({ name, data: fs.readFileSync(path.join(src, ...name.split("/"))) })));
fs.mkdirSync(path.dirname(xpiOut), { recursive: true });
fs.writeFileSync(xpiOut, xpi);
console.log(`Built ${path.relative(root, xpiOut)} (${files.length} files: ${files.join(", ")})`);

// ---- Claude Desktop extension (.mcpb)
// Snapshot the plugin's initialize result and tool list so the bridge can answer them while
// Zotero is closed. Tool definitions are static, so a stub env is enough.
async function buildExtension() {
	globalThis.ZMCPTools = require(path.join(src, "content", "tools.js"));
	const ZMCPProtocol = require(path.join(src, "content", "mcp.js"));
	const tools = globalThis.ZMCPTools.create({});
	const protocol = ZMCPProtocol.create({
		tools,
		serverInfo: { name: "hc-zotero-mcp", title: "HC Zotero MCP", version }
	});
	const init = (await protocol.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).result;
	const list = (await protocol.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" })).result;
	delete init.protocolVersion;
	const fallback = { supportedVersions: ZMCPProtocol.SUPPORTED_VERSIONS, initialize: init, tools: list.tools };

	const extSrc = path.join(root, "extension");
	const manifest = JSON.parse(fs.readFileSync(path.join(extSrc, "manifest.json"), "utf8"));
	manifest.version = version;
	manifest.tools = list.tools.map(t => ({ name: t.name, description: t.title }));
	const entries = [
		{ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2) + "\n") },
		{ name: "server/index.js", data: fs.readFileSync(path.join(extSrc, "server", "index.js")) },
		{ name: "server/fallback.json", data: Buffer.from(JSON.stringify(fallback, null, 2) + "\n") }
	];
	if (fs.existsSync(path.join(extSrc, "icon.png"))) {
		manifest.icon = "icon.png";
		entries[0].data = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
		entries.push({ name: "icon.png", data: fs.readFileSync(path.join(extSrc, "icon.png")) });
	}
	return makeZip(entries);
}

buildExtension().then((mcpb) => {
	const mcpbOut = path.join(root, "dist", `${base}.mcpb`);
	fs.writeFileSync(mcpbOut, mcpb);
	console.log(`Built ${path.relative(root, mcpbOut)} (Claude Desktop extension)`);

	// ---- Release download: both files in one .zip
	fs.writeFileSync(zipOut, makeZip([
		{ name: `${base}.xpi`, data: xpi },
		{ name: `${base}.mcpb`, data: mcpb }
	]));
	console.log(`Built ${path.relative(root, zipOut)} (release download: .xpi + .mcpb)`);
}).catch((e) => {
	console.error(e);
	process.exit(1);
});
