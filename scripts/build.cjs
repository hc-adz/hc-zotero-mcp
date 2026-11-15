// Packs plugin/ into dist/hc-zotero-mcp-<version>.xpi (a zip with forward-slash paths), then wraps
// that .xpi in dist/hc-zotero-mcp-<version>.zip for release downloads (browsers try to install a
// bare .xpi as a browser extension).
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

const files = walk(src);
const xpi = makeZip(files.map(name => ({ name, data: fs.readFileSync(path.join(src, ...name.split("/"))) })));
fs.mkdirSync(path.dirname(xpiOut), { recursive: true });
fs.writeFileSync(xpiOut, xpi);
fs.writeFileSync(zipOut, makeZip([{ name: `${base}.xpi`, data: xpi }]));
console.log(`Built ${path.relative(root, xpiOut)} (${files.length} files: ${files.join(", ")})`);
console.log(`Built ${path.relative(root, zipOut)} (release download containing the .xpi)`);
