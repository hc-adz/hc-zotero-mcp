/*
 * HC Zotero MCP — environment adapter that backs tools.js with Zotero's own APIs.
 *
 * All SQL runs through Zotero.DB (the single connection Zotero itself uses — zotero.sqlite is
 * opened with an exclusive lock, so no second connection is possible). Only SELECTs are issued
 * (enforced again in tools.js), never inside a transaction, so nothing can be written or locked.
 */
var ZMCPZoteroEnv = (function () {
	"use strict";

	const Cc = Components.classes;
	const Ci = Components.interfaces;

	function fallbackNormalize(s) {
		if (!s) return s || "";
		return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
			.replace(/[‘’‚‛′]/g, "'")
			.replace(/[“”„‟″]/g, '"')
			.replace(/[‐-―−]/g, "-")
			.normalize("NFC");
	}

	function create({ pluginVersion }) {
		const normalize = (Zotero.Utilities.Internal && Zotero.Utilities.Internal.normalizeForSearch)
			? (s => Zotero.Utilities.Internal.normalizeForSearch(s || "") || "")
			: fallbackNormalize;

		function localFile(path) {
			const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
			f.initWithPath(path);
			return f;
		}

		return {
			async query(sql, params, cols, opts) {
				const out = [];
				const n = cols.length;
				await Zotero.DB.queryAsync(sql, params, {
					noCache: !!opts.noCache,
					debug: false,
					onRow: (row) => {
						const o = {};
						for (let i = 0; i < n; i++) o[cols[i]] = row.getResultByIndex(i);
						out.push(o);
					}
				});
				return out;
			},

			normalize,

			get storageDir() {
				return Zotero.getStorageDirectory().path;
			},

			resolveRelativePath(path) {
				try {
					return Zotero.Attachments.resolveRelativePath(path) || null;
				}
				catch (e) {
					return null;
				}
			},

			joinPath(base, ...parts) {
				const f = localFile(base);
				for (const p of parts) {
					for (const seg of String(p).split(/[\\/]/)) {
						if (seg && seg !== "." && seg !== "..") f.append(seg);
					}
				}
				return f.path;
			},

			fileInfo(path) {
				try {
					const f = localFile(path);
					if (!f.exists()) return { exists: false, size: null };
					return { exists: true, size: f.isFile() ? f.fileSize : null };
				}
				catch (e) {
					return { exists: false, size: null };
				}
			},

			async readTextPrefix(path, maxBytes) {
				if (!this.fileInfo(path).exists) return null;
				const bytes = await IOUtils.read(path, { maxBytes });
				return new TextDecoder("utf-8").decode(bytes);
			},

			annotationImagePath(libraryID, groupID, key) {
				try {
					const parts = libraryID === Zotero.Libraries.userLibraryID ? ["library"] : ["groups", String(groupID)];
					return this.joinPath(Zotero.DataDirectory.dir, "cache", ...parts, key + ".png");
				}
				catch (e) {
					return null;
				}
			},

			async fulltextItemIDs(term, libraryID) {
				const FT = Zotero.FullText;
				// Zotero 10+: FTS5 index in the attached fulltext.sqlite
				if (FT && typeof FT.findItemsWithContent === "function") {
					const ids = await FT.findItemsWithContent(term, libraryID ?? null);
					if (ids) return ids;
				}
				// Zotero 7–9: word index tables in zotero.sqlite (prefix match on each word)
				const words = term.split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 2);
				if (!words.length) return null;
				let ids = null;
				for (const w of words) {
					const rows = await this.query(
						"SELECT DISTINCT FIW.itemID FROM fulltextWords W JOIN fulltextItemWords FIW ON FIW.wordID=W.wordID "
						+ "WHERE W.word >= ? AND W.word < ?",
						[w, w + "￿"], ["itemID"], { noCache: false }
					).catch(() => null);
					if (!rows) return null;
					const set = new Set(rows.map(r => r.itemID));
					ids = ids ? ids.filter(id => set.has(id)) : [...set];
					if (!ids.length) break;
				}
				return ids;
			},

			async noteMatchSQL(term) {
				const FT = Zotero.FullText;
				if (FT && typeof FT.getNoteContentSQL === "function") {
					return FT.getNoteContentSQL(term);
				}
				return null;
			},

			info() {
				return {
					server: { name: "hc-zotero-mcp", version: pluginVersion },
					zoteroVersion: Zotero.version,
					dataDir: Zotero.DataDirectory.dir,
					storageDir: Zotero.getStorageDirectory().path,
					linkedAttachmentBaseDir: Zotero.Prefs.get("baseAttachmentPath") || null,
					fulltextIndex: !!(Zotero.FullText && typeof Zotero.FullText.findItemsWithContent === "function") ? "fts5" : "legacy"
				};
			}
		};
	}

	return { create };
})();
