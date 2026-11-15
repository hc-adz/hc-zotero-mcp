// Node implementation of the tools.js `env` contract, for testing against a COPY of a Zotero
// data directory. Opens the databases read-only.
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

function normalize(s) {
	if (!s) return s || "";
	return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
		.replace(/[‘’‚‛′]/g, "'")
		.replace(/[“”„‟″]/g, '"')
		.replace(/[‐-―−]/g, "-")
		.normalize("NFC");
}

function createEnv({ dbPath, fulltextPath, dataDir }) {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	if (fulltextPath && fs.existsSync(fulltextPath)) {
		db.exec(`ATTACH DATABASE '${fulltextPath.replace(/'/g, "''")}' AS ftindex`);
	}
	const stmts = new Map();
	const queries = [];
	return {
		db,
		queries,
		async query(sql, params, cols) {
			queries.push(sql);
			let st = stmts.get(sql);
			if (!st) {
				st = db.prepare(sql);
				stmts.set(sql, st);
			}
			const rows = st.all(...params);
			return rows.map((r) => {
				const vals = Object.values(r);
				const o = {};
				cols.forEach((c, i) => { o[c] = vals[i]; });
				return o;
			});
		},
		normalize,
		storageDir: path.join(dataDir, "storage"),
		resolveRelativePath: () => null,
		joinPath: (...p) => path.join(...p),
		fileInfo(p) {
			try {
				const s = fs.statSync(p);
				return { exists: true, size: s.isFile() ? s.size : null };
			}
			catch (e) {
				return { exists: false, size: null };
			}
		},
		async readTextPrefix(p, maxBytes) {
			let fd;
			try {
				fd = fs.openSync(p, "r");
			}
			catch (e) {
				return null;
			}
			try {
				const buf = Buffer.alloc(maxBytes);
				const n = fs.readSync(fd, buf, 0, maxBytes, 0);
				return buf.subarray(0, n).toString("utf8");
			}
			finally {
				fs.closeSync(fd);
			}
		},
		annotationImagePath:(libraryID, groupID, key) =>
			path.join(dataDir, "cache", libraryID === 1 ? "library" : `groups/${groupID}`, key + ".png"),
		async fulltextItemIDs(term) {
			const toks = term.match(/[\p{L}\p{N}]+/gu);
			if (!toks) return null;
			try {
				return db.prepare("SELECT rowid AS id FROM ftindex.fulltextContent WHERE fulltextContent MATCH ?")
					.all('"' + toks.join(" ") + '"*').map(r => r.id);
			}
			catch (e) {
				return null;
			}
		},
		async noteMatchSQL(term) {
			if (term.length < 3) return null;
			return {
				sql: "itemID IN (SELECT rowid FROM ftindex.fulltextNotes WHERE fulltextNotes MATCH ?)",
				params: ['"' + term.replace(/"/g, '""') + '"']
			};
		},
		info: () => ({ server: { name: "hc-zotero-mcp", version: "test" }, dataDir })
	};
}

module.exports = { createEnv, normalize };
