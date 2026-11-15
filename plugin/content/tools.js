/*
 * HC Zotero MCP — tool implementations.
 *
 * Pure logic: every database / filesystem / Zotero call goes through the injected `env`, so this
 * file runs unchanged inside Zotero (see zenv.js) and under Node for testing (see test/).
 *
 * SAFETY: this module only ever issues static, hard-coded SELECT statements. User input is
 * passed exclusively as bound parameters; the only values ever inlined into SQL are integer IDs
 * that were validated with Number.isSafeInteger. Every statement is additionally checked by
 * assertReadOnly() before it reaches the database.
 *
 * env contract:
 *   env.query(sql, params, cols, {noCache}) -> Promise<Object[]>   rows mapped by `cols` order
 *   env.normalize(str) -> str              case/diacritic folding identical to Zotero's search
 *   env.storageDir                         absolute path of <dataDir>/storage
 *   env.resolveRelativePath(path)          "attachments:..." -> absolute path, or null
 *   env.joinPath(...parts) -> string
 *   env.fileInfo(path) -> {exists, size}
 *   env.annotationImagePath(libraryID, groupID, key) -> string|null
 *   env.fulltextItemIDs(term, libraryID) -> Promise<int[]|null>   attachment IDs (null = n/a)
 *   env.noteMatchSQL(term) -> Promise<{sql, params}|null>          clause over itemNotes.itemID
 *   env.info() -> Object                                          version/path info
 */
var ZMCPTools = (function () {
	"use strict";

	const LINK_MODES = ["imported_file", "imported_url", "linked_file", "linked_url", "embedded_image"];
	const ANNOTATION_TYPES = { 1: "highlight", 2: "note", 3: "image", 4: "ink", 5: "underline", 6: "text" };
	const WRITE_KEYWORDS = /\b(INSERT|UPDATE|DELETE|REPLACE|UPSERT|DROP|ALTER|CREATE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|ANALYZE|SAVEPOINT|RELEASE|BEGIN|COMMIT|ROLLBACK|END)\b/i;
	const KEY_RE = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/;

	// Small English stopword list: dropped from unquoted multi-word queries so that substring
	// matching on e.g. "of"/"on" doesn't flood results.
	const STOPWORDS = new Set(("a an and are as at be by for from has have in into is it its of on or "
		+ "that the their this to was were which with about between over under vs versus via").split(" "));

	// Search field groups and their relevance weights
	const W = {
		title: 10, shortTitle: 8, tags: 7, creatorsLast: 6, creatorsFirst: 3, abstract: 5,
		publication: 3, series: 2, other: 1, notes: 3, noteTitle: 6, annotations: 3, fulltext: 2,
		attachmentTitle: 1
	};
	const ALL_FIELD_GROUPS = ["title", "abstract", "creators", "tags", "publication", "other",
		"notes", "annotations", "fulltext"];

	// Light suffix stripping for single unquoted words, so a term matches its morphological family
	// via prefix matching: experimental -> experiment, practices -> practic, teaching -> teach.
	// Deliberately conservative (stem must keep >= 4 letters); a stem only ever widens a match.
	const SUFFIXES = ["izations", "ization", "ational", "ations", "ation", "ments", "ment", "ness", "ities", "ity",
		"ically", "ical", "ally", "ings", "ing", "ers", "er", "ed", "es", "al", "ly", "s"];
	function stem(word) {
		if (!/^[a-z]+$/.test(word) || word.length < 5) return word;
		for (const suf of SUFFIXES) {
			if (word.endsWith(suf) && word.length - suf.length >= 4) {
				// "ss" endings (class, process) are not plurals
				if (suf === "s" && /(ss|us|is)$/.test(word)) return word;
				return word.slice(0, -suf.length);
			}
		}
		return word;
	}

	const TITLE_COLLATOR =new Intl.Collator(undefined, { sensitivity: "base", ignorePunctuation: true, numeric: true });

	class ToolError extends Error {}

	function assertReadOnly(sql) {
		if (!/^\s*(SELECT|WITH)\b/i.test(sql) || sql.includes(";") || WRITE_KEYWORDS.test(sql)) {
			throw new Error("Internal safety check failed: refusing to run non-SELECT SQL");
		}
	}

	function idList(ids) {
		const out = [];
		for (const id of ids) {
			if (!Number.isSafeInteger(id)) throw new Error("Invalid internal ID");
			out.push(id);
		}
		return out.join(",");
	}

	function escapeLike(s) {
		return s.replace(/[\\%_]/g, "\\$&");
	}

	function chunk(arr, n) {
		const out = [];
		for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
		return out;
	}

	function escapeRegExp(s) {
		return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}

	function htmlToText(html) {
		if (!html) return "";
		return html
			.replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, "")
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre)>/gi, "\n")
			.replace(/<li[^>]*>/gi, "• ")
			.replace(/<[^>]+>/g, "")
			.replace(/&nbsp;/g, " ")
			.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
			.replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'")
			.replace(/&#(\d+);/g, (m, d) => safeCodePoint(parseInt(d, 10), m))
			.replace(/&#x([0-9a-f]+);/gi, (m, h) => safeCodePoint(parseInt(h, 16), m))
			.replace(/&amp;/g, "&")
			.replace(/[ \t]+\n/g, "\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
	}

	function safeCodePoint(n, fallback) {
		try { return String.fromCodePoint(n); } catch (e) { return fallback; }
	}

	// Zotero stores dates as "YYYY-MM-DD original" (multipart)
	function parseMultipartDate(v) {
		if (typeof v !== "string") return { str: v, year: null };
		const m = /^(\d{4})-(\d{2})-(\d{2}) ([\s\S]*)$/.exec(v);
		if (!m) return { str: v, year: null };
		return { str: m[4], year: m[1] === "0000" ? null : parseInt(m[1], 10) };
	}

	function truncate(s, n) {
		if (s == null) return s;
		if (n <= 0) return "";
		return s.length > n ? s.slice(0, n) + "…" : s;
	}

	// ----- argument helpers -----
	function intArg(v, def, min, max) {
		if (v === undefined || v === null || v === "") return def;
		const n = Math.floor(Number(v));
		if (!Number.isFinite(n)) throw new ToolError(`Expected a number, got ${JSON.stringify(v)}`);
		return Math.max(min, Math.min(max, n));
	}
	function strArray(v, name) {
		if (v === undefined || v === null) return [];
		if (typeof v === "string") return [v];
		if (!Array.isArray(v) || v.some(x => typeof x !== "string")) {
			throw new ToolError(`'${name}' must be a string or an array of strings`);
		}
		return v;
	}
	function keysArg(v, max) {
		const keys = strArray(v, "keys").map(k => k.trim().toUpperCase()).filter(Boolean);
		if (!keys.length) throw new ToolError("At least one item key is required");
		if (keys.length > max) throw new ToolError(`At most ${max} keys per call`);
		for (const k of keys) {
			if (!KEY_RE.test(k)) throw new ToolError(`'${k}' is not a valid Zotero item key (8 characters, e.g. "ABCD2345")`);
		}
		return [...new Set(keys)];
	}

	// ======================================================================================

	function create(env) {
		let metaPromise = null;

		async function q(sql, params, cols, opts) {
			assertReadOnly(sql);
			return env.query(sql, params || [], cols, opts || {});
		}

		async function columnExists(table, col) {
			try {
				await q(`SELECT ${col} FROM ${table} LIMIT 0`, [], [col]);
				return true;
			}
			catch (e) {
				return false;
			}
		}

		// Lookup tables are tiny and only change with schema updates: load once per session.
		function meta() {
			if (!metaPromise) {
				metaPromise = loadMeta().catch((e) => { metaPromise = null; throw e; });
			}
			return metaPromise;
		}

		async function loadMeta() {
			const m = {
				fieldName: new Map(), fieldID: new Map(), typeName: new Map(), typeID: new Map(),
				creatorType: new Map()
			};
			for (const r of await q("SELECT fieldID, fieldName FROM fieldsCombined", [], ["fieldID", "fieldName"])) {
				m.fieldName.set(r.fieldID, r.fieldName);
				m.fieldID.set(r.fieldName, r.fieldID);
			}
			for (const r of await q("SELECT itemTypeID, typeName FROM itemTypesCombined", [], ["itemTypeID", "typeName"])) {
				m.typeName.set(r.itemTypeID, r.typeName);
				m.typeID.set(r.typeName, r.itemTypeID);
			}
			for (const r of await q("SELECT creatorTypeID, creatorType FROM creatorTypes", [], ["creatorTypeID", "creatorType"])) {
				m.creatorType.set(r.creatorTypeID, r.creatorType);
			}
			const mapped = async (base) => {
				const id = m.fieldID.get(base);
				if (id === undefined) return [];
				const rows = await q("SELECT DISTINCT fieldID FROM baseFieldMappingsCombined WHERE baseFieldID=?", [id], ["fieldID"]);
				return [id, ...rows.map(r => r.fieldID)];
			};
			m.titleIDs = new Set(await mapped("title"));
			m.dateIDs = new Set(await mapped("date"));
			m.pubIDs = new Set(await mapped("publicationTitle"));
			m.ids = (...names) => names.map(n => m.fieldID.get(n)).filter(x => x !== undefined);

			// Field -> search group/weight
			m.fieldGroup = new Map();
			for (const [id, name] of m.fieldName) {
				let g;
				if (m.titleIDs.has(id)) g = ["title", W.title];
				else if (name === "shortTitle") g = ["title", W.shortTitle];
				else if (name === "abstractNote") g = ["abstract", W.abstract];
				else if (m.pubIDs.has(id)) g = ["publication", W.publication];
				else if (/^(series|seriesTitle|conferenceName|proceedingsTitle)$/.test(name)) g = ["publication", W.series];
				else if (name === "date" || /Date$/.test(name) || m.dateIDs.has(id)) g = null;
				// Not topical: URLs/catalog boilerplate would only add noise
				else if (/^(url|libraryCatalog|rights|archiveLocation|callNumber|accessDate)$/.test(name)) g = null;
				else g = ["other", W.other];
				if (g) m.fieldGroup.set(id, g);
			}

			// Newer schemas store case/diacritic-folded copies (NULL when equal to the ASCII-lowercased
			// value). Use them when present, exactly like Zotero's own search does.
			const norm = async (table, col, alias) =>
				(await columnExists(table, col + "Normalized")) ? `COALESCE(${alias}.${col}Normalized, ${alias}.${col})` : `${alias}.${col}`;
			m.sqlValue = await norm("itemDataValues", "value", "V");
			m.sqlTag = await norm("tags", "name", "T");
			m.sqlLast = await norm("creators", "lastName", "C");
			m.sqlFirst = await norm("creators", "firstName", "C");
			m.sqlAnnText = await norm("itemAnnotations", "text", "AN");
			m.sqlAnnComment = await norm("itemAnnotations", "comment", "AN");
			m.hasFulltextItems = await columnExists("fulltextItems", "indexedPages");
			return m;
		}

		async function libraries() {
			const rows = await q(
				"SELECT L.libraryID, L.type, L.editable, G.name AS groupName, G.groupID, F.name AS feedName "
				+ "FROM libraries L LEFT JOIN groups G ON G.libraryID=L.libraryID "
				+ "LEFT JOIN feeds F ON F.libraryID=L.libraryID",
				[], ["libraryID", "type", "editable", "groupName", "groupID", "feedName"]
			);
			return rows.map(r => ({
				libraryID: r.libraryID,
				type: r.type,
				name: r.type === "user" ? "My Library" : (r.groupName || r.feedName || r.type),
				groupID: r.groupID ?? null,
				editable: !!r.editable
			}));
		}

		// Resolve item keys -> rows. Keys are unique per library; without libraryID, all
		// non-feed libraries are searched.
		async function resolveKeys(keys, libraryID) {
			const params = [...keys];
			let sql = "SELECT I.itemID, I.key, I.libraryID, I.itemTypeID, I.dateAdded, I.dateModified, "
				+ "(I.itemID IN (SELECT itemID FROM deletedItems)) AS trashed "
				+ "FROM items I JOIN libraries L ON L.libraryID=I.libraryID "
				+ `WHERE I.key IN (${keys.map(() => "?").join(",")}) AND L.type != 'feed'`;
			if (libraryID !== undefined && libraryID !== null) {
				sql += " AND I.libraryID=?";
				params.push(intArg(libraryID, 1, 0, 1e9));
			}
			return q(sql, params, ["itemID", "key", "libraryID", "itemTypeID", "dateAdded", "dateModified", "trashed"], { noCache: true });
		}

		function libExtra(libraryID, obj) {
			if (libraryID !== 1) obj.libraryID = libraryID;
			return obj;
		}

		// ---------------------------------------------------------------- collections
		async function allCollections(libraryID) {
			const params = [];
			let sql = "SELECT C.collectionID, C.key, C.collectionName, C.parentCollectionID, C.libraryID, "
				+ "(SELECT COUNT(*) FROM collectionItems CI WHERE CI.collectionID=C.collectionID "
				+ "AND CI.itemID NOT IN (SELECT itemID FROM deletedItems)) AS n "
				+ "FROM collections C WHERE C.collectionID NOT IN (SELECT collectionID FROM deletedCollections)";
			if (libraryID !== undefined && libraryID !== null) {
				sql += " AND C.libraryID=?";
				params.push(libraryID);
			}
			const rows = await q(sql, params, ["collectionID", "key", "collectionName", "parentCollectionID", "libraryID", "n"]);
			const byID = new Map(rows.map(r => [r.collectionID, r]));
			const pathOf = (r, depth = 0) => {
				if (r._path) return r._path;
				const parent = r.parentCollectionID ? byID.get(r.parentCollectionID) : null;
				r._path = parent && depth < 100 ? pathOf(parent, depth + 1) + " / " + r.collectionName : r.collectionName;
				return r._path;
			};
			const children = new Map();
			for (const r of rows) {
				pathOf(r);
				if (r.parentCollectionID) {
					if (!children.has(r.parentCollectionID)) children.set(r.parentCollectionID, []);
					children.get(r.parentCollectionID).push(r.collectionID);
				}
			}
			return { rows, byID, children };
		}

		async function collectionScope(key, libraryID, recursive) {
			const c = await allCollections(libraryID);
			const k = String(key).trim();
			let root = c.rows.find(r => r.key === k.toUpperCase());
			if (!root) {
				// Accept a collection name or path as a convenience
				const nk = env.normalize(k);
				const matches = c.rows.filter(r => env.normalize(r.collectionName) === nk || env.normalize(r._path) === nk);
				if (matches.length === 1) root = matches[0];
				else if (matches.length > 1) {
					throw new ToolError(`Collection name '${k}' is ambiguous; use one of these keys: `
						+ matches.map(r => `${r.key} (${r._path})`).join(", "));
				}
			}
			if (!root) throw new ToolError(`Collection '${k}' not found. Use list_collections to get collection keys.`);
			const ids = [root.collectionID];
			if (recursive) {
				for (let i = 0; i < ids.length; i++) {
					for (const ch of c.children.get(ids[i]) || []) ids.push(ch);
				}
			}
			return { ids, root };
		}

		async function listCollections(args) {
			const libraryID = args.libraryID != null ? intArg(args.libraryID, 1, 0, 1e9) : null;
			const c = await allCollections(libraryID);
			let rows = c.rows;
			if (args.query) {
				const nq = env.normalize(String(args.query));
				rows = rows.filter(r => env.normalize(r._path).includes(nq));
			}
			rows.sort((a, b) => a.libraryID - b.libraryID || a._path.localeCompare(b._path));
			const limit = intArg(args.limit, 500, 1, 5000);
			return {
				total: rows.length,
				collections: rows.slice(0, limit).map(r => libExtra(r.libraryID, {
					key: r.key,
					name: r.collectionName,
					path: r._path,
					parentKey: r.parentCollectionID ? (c.byID.get(r.parentCollectionID) || {}).key || null : null,
					items: r.n
				}))
			};
		}

		// ---------------------------------------------------------------- tags
		async function listTags(args) {
			const m = await meta();
			const params = [];
			const where = ["IT.itemID NOT IN (SELECT itemID FROM deletedItems)",
				"I.libraryID NOT IN (SELECT libraryID FROM libraries WHERE type='feed')"];
			if (args.libraryID != null) {
				where.push("I.libraryID=?");
				params.push(intArg(args.libraryID, 1, 0, 1e9));
			}
			if (args.query) {
				where.push(`${m.sqlTag} LIKE ? ESCAPE '\\'`);
				params.push("%" + escapeLike(env.normalize(String(args.query))) + "%");
			}
			if (args.includeAutomatic === false) where.push("IT.type=0");
			const limit = intArg(args.limit, 100, 1, 2000);
			const rows = await q(
				"SELECT T.name AS name, COUNT(DISTINCT IT.itemID) AS n, MIN(IT.type) AS type, COUNT(*) OVER () AS total "
				+ "FROM tags T JOIN itemTags IT ON IT.tagID=T.tagID JOIN items I ON I.itemID=IT.itemID "
				+ "WHERE " + where.join(" AND ") + " GROUP BY T.tagID ORDER BY n DESC, T.name COLLATE NOCASE LIMIT ?",
				[...params, limit], ["name", "n", "type", "total"]
			);
			return {
				total: rows.length ? rows[0].total : 0,
				tags: rows.map(r => (r.type ? { tag: r.name, items: r.n, automatic: true } : { tag: r.name, items: r.n }))
			};
		}

		// ---------------------------------------------------------------- attachments
		async function attachmentRows(where, ids) {
			const m = await meta();
			const [titleID] = m.ids("title");
			const [urlID] = m.ids("url");
			const ft = m.hasFulltextItems
				? "F.indexedPages, F.totalPages, F.indexedChars, F.totalChars"
				: "NULL, NULL, NULL, NULL";
			const rows = await q(
				"SELECT A.itemID, I.key, I.libraryID, A.parentItemID, A.linkMode, A.contentType, A.path, "
				+ "(SELECT V.value FROM itemData D JOIN itemDataValues V ON V.valueID=D.valueID WHERE D.itemID=A.itemID AND D.fieldID=?) AS title, "
				+ "(SELECT V.value FROM itemData D JOIN itemDataValues V ON V.valueID=D.valueID WHERE D.itemID=A.itemID AND D.fieldID=?) AS url, "
				+ ft + ", "
				+ "(SELECT COUNT(*) FROM itemAnnotations AN WHERE AN.parentItemID=A.itemID) AS annotations, "
				+ "G.groupID "
				+ "FROM itemAttachments A JOIN items I ON I.itemID=A.itemID "
				+ (m.hasFulltextItems ? "LEFT JOIN fulltextItems F ON F.itemID=A.itemID " : "")
				+ "LEFT JOIN groups G ON G.libraryID=I.libraryID "
				+ `WHERE (${where.replace(/\$IDS/g, idList(ids))}) AND A.itemID NOT IN (SELECT itemID FROM deletedItems) `
				+ "ORDER BY A.parentItemID, (A.contentType='application/pdf') DESC, I.dateAdded",
				[titleID ?? -1, urlID ?? -1],
				["itemID", "key", "libraryID", "parentItemID", "linkMode", "contentType", "path", "title", "url",
					"indexedPages", "totalPages", "indexedChars", "totalChars", "annotations", "groupID"],
				{ noCache: true }
			);
			return rows.map(formatAttachment);
		}

		function formatAttachment(r) {
			const linkMode = LINK_MODES[r.linkMode] || String(r.linkMode);
			const out = { key: r.key, title: r.title || null, contentType: r.contentType || null, linkMode };
			if (r.libraryID !== 1) out.libraryID = r.libraryID;
			let path = null;
			if (r.linkMode === 3) {
				out.url = r.url || null;
			}
			else if (r.path) {
				if (r.path.startsWith("storage:")) {
					path = env.joinPath(env.storageDir, r.key, r.path.slice(8));
				}
				else if (r.path.startsWith("attachments:")) {
					path = env.resolveRelativePath(r.path);
					if (!path) out.pathError = "Relative path but no Linked Attachment Base Directory is set in Zotero";
				}
				else {
					path = r.path;
				}
				if (r.linkMode === 1 && r.url) out.url = r.url;
			}
			if (path) {
				out.path = path;
				const fi = env.fileInfo(path);
				out.exists = fi.exists;
				if (fi.exists && fi.size != null) out.sizeBytes = fi.size;
			}
			// Zotero's extracted full text (plain UTF-8) lives next to the file
			if (r.linkMode !== 3) {
				const cache = env.joinPath(env.storageDir, r.key, ".zotero-ft-cache");
				if (env.fileInfo(cache).exists) out.fulltextCachePath = cache;
			}
			if (r.indexedChars != null || r.indexedPages != null) {
				out.indexed = {};
				if (r.totalPages != null) out.indexed.pages = `${r.indexedPages ?? "?"}/${r.totalPages}`;
				if (r.indexedChars != null) out.indexed.chars = r.indexedChars;
			}
			if (r.annotations) out.annotations = r.annotations;
			out._parentItemID = r.parentItemID;
			out._itemID = r.itemID;
			return out;
		}

		function stripInternal(o) {
			delete o._parentItemID;
			delete o._itemID;
			return o;
		}

		async function getAttachments(args) {
			const keys = keysArg(args.keys ?? args.key, 50);
			const rows = await resolveKeys(keys, args.libraryID);
			const found = new Map(rows.map(r => [r.key, r]));
			const ids = rows.map(r => r.itemID);
			const atts = ids.length ? await attachmentRows("A.parentItemID IN ($IDS) OR A.itemID IN ($IDS)", ids) : [];
			const results = [];
			for (const key of keys) {
				const r = found.get(key);
				if (!r) {
					results.push({ key, error: "Item not found" });
					continue;
				}
				const list = atts.filter(a => a._parentItemID === r.itemID || a._itemID === r.itemID).map(a => stripInternal({ ...a }));
				results.push({ key, attachments: list });
			}
			return { items: results };
		}

		// ---------------------------------------------------------------- item summaries
		function creatorString(list) {
			if (!list || !list.length) return null;
			const names = list.map(c => (c.fieldMode === 1 ? c.lastName : c.lastName || c.firstName)).filter(Boolean);
			if (names.length <= 3) return names.join(", ");
			return names.slice(0, 3).join(", ") + " et al.";
		}

		// Compact records for a page of results (a handful of batched queries, no per-item loops)
		async function summaries(itemIDs, opts) {
			if (!itemIDs.length) return [];
			const m = await meta();
			const ids = idList(itemIDs);
			const wanted = new Set([...m.titleIDs, ...m.dateIDs, ...m.pubIDs, ...m.ids("DOI")]);
			if (opts.includeAbstract) for (const id of m.ids("abstractNote")) wanted.add(id);

			const base = await q(
				`SELECT itemID, key, libraryID, itemTypeID, dateAdded FROM items WHERE itemID IN (${ids})`,
				[], ["itemID", "key", "libraryID", "itemTypeID", "dateAdded"], { noCache: true }
			);
			const recs = new Map(base.map(r => [r.itemID, { r, fields: {}, creators: [], tags: [] }]));

			const fieldRows = await q(
				"SELECT D.itemID, D.fieldID, V.value FROM itemData D JOIN itemDataValues V ON V.valueID=D.valueID "
				+ `WHERE D.itemID IN (${ids}) AND D.fieldID IN (${idList([...wanted])})`,
				[], ["itemID", "fieldID", "value"], { noCache: true }
			);
			for (const f of fieldRows) {
				const rec = recs.get(f.itemID);
				if (m.titleIDs.has(f.fieldID)) rec.fields.title = f.value;
				else if (m.dateIDs.has(f.fieldID)) rec.fields.date = f.value;
				else if (m.pubIDs.has(f.fieldID)) rec.fields.publication = f.value;
				else rec.fields[m.fieldName.get(f.fieldID)] = f.value;
			}
			const creatorRows = await q(
				"SELECT IC.itemID, C.firstName, C.lastName, C.fieldMode FROM itemCreators IC "
				+ `JOIN creators C ON C.creatorID=IC.creatorID WHERE IC.itemID IN (${ids}) ORDER BY IC.itemID, IC.orderIndex`,
				[], ["itemID", "firstName", "lastName", "fieldMode"], { noCache: true }
			);
			for (const c of creatorRows) recs.get(c.itemID).creators.push(c);

			const attRows = await q(
				"SELECT parentItemID, SUM(contentType='application/pdf') AS pdf, COUNT(*) AS n FROM itemAttachments "
				+ `WHERE parentItemID IN (${ids}) AND linkMode != 3 AND itemID NOT IN (SELECT itemID FROM deletedItems) GROUP BY parentItemID`,
				[], ["parentItemID", "pdf", "n"], { noCache: true }
			);
			const atts = new Map(attRows.map(a => [a.parentItemID, a]));

			const noteRows = await q(
				`SELECT itemID, title FROM itemNotes WHERE itemID IN (${ids})`, [], ["itemID", "title"], { noCache: true }
			);
			const noteTitles = new Map(noteRows.map(n => [n.itemID, n.title]));

			if (opts.includeTags) {
				const tagRows = await q(
					`SELECT IT.itemID, T.name FROM itemTags IT JOIN tags T ON T.tagID=IT.tagID WHERE IT.itemID IN (${ids})`,
					[], ["itemID", "name"], { noCache: true }
				);
				for (const t of tagRows) recs.get(t.itemID).tags.push(t.name);
			}

			// Items without an abstract (web pages, reports, blog posts...): use the opening of
			// Zotero's extracted text instead, so the model can still judge relevance.
			const excerpts = new Map();
			if (opts.includeAbstract && env.readTextPrefix) {
				const missing = itemIDs.filter(id => recs.has(id) && !recs.get(id).fields.abstractNote);
				if (missing.length) {
					const attRows2 = await q(
						"SELECT COALESCE(A.parentItemID, A.itemID) AS top, I.key FROM itemAttachments A JOIN items I ON I.itemID=A.itemID "
						+ `WHERE (A.parentItemID IN (${idList(missing)}) OR A.itemID IN (${idList(missing)})) AND A.linkMode != 3 `
						+ "AND A.itemID NOT IN (SELECT itemID FROM deletedItems) "
						+ "ORDER BY (A.contentType='application/pdf') DESC, I.dateAdded",
						[], ["top", "key"], { noCache: true }
					);
					const firstAtt = new Map();
					for (const a of attRows2) {
						if (!firstAtt.has(a.top)) firstAtt.set(a.top, []);
						firstAtt.get(a.top).push(a.key);
					}
					const chars = opts.abstractChars || 1500;
					await Promise.all([...firstAtt].map(async ([top, keys]) => {
						for (const key of keys) {
							const text = await env.readTextPrefix(env.joinPath(env.storageDir, key, ".zotero-ft-cache"), chars * 4 + 512)
								.catch(() => null);
							if (text && text.trim()) {
								excerpts.set(top, truncate(text.replace(/\s+/g, " ").trim(), chars));
								return;
							}
						}
					}));
				}
			}

			const out = [];
			for (const id of itemIDs) {
				const rec = recs.get(id);
				if (!rec) continue;
				const { r, fields } = rec;
				const type = m.typeName.get(r.itemTypeID);
				const o = { key: r.key, type };
				if (r.libraryID !== 1) o.libraryID = r.libraryID;
				o.title = fields.title ?? noteTitles.get(id) ?? null;
				const cs = creatorString(rec.creators);
				if (cs) o.creators = cs;
				if (fields.date) {
					const d = parseMultipartDate(fields.date);
					if (d.year) o.year = d.year;
					else if (d.str) o.date = d.str;
				}
				if (fields.publication) o.publication = fields.publication;
				if (fields.DOI) o.doi = fields.DOI;
				const a = atts.get(id);
				if (a) o.files = a.pdf ? { pdf: a.pdf, other: a.n - a.pdf } : { other: a.n };
				if (opts.includeTags && rec.tags.length) o.tags = rec.tags;
				if (opts.includeAbstract && fields.abstractNote) o.abstract = truncate(fields.abstractNote, opts.abstractChars || 1500);
				else if (excerpts.has(id)) o.excerpt = excerpts.get(id);
				if (opts.extra) Object.assign(o, opts.extra(id));
				out.push(o);
			}
			return out;
		}

		// ---------------------------------------------------------------- get_items
		async function getItems(args) {
			const m = await meta();
			const keys = keysArg(args.keys ?? args.key, 50);
			const noteChars = intArg(args.noteChars, 2000, 0, 200000);
			const rows = await resolveKeys(keys, args.libraryID);
			const byKey = new Map(rows.map(r => [r.key, r]));
			const ids = rows.map(r => r.itemID);
			if (!ids.length) return { items: keys.map(key => ({ key, error: "Item not found" })) };
			const idsSQL = idList(ids);

			const fieldRows = await q(
				"SELECT D.itemID, D.fieldID, V.value FROM itemData D JOIN itemDataValues V ON V.valueID=D.valueID "
				+ `WHERE D.itemID IN (${idsSQL})`, [], ["itemID", "fieldID", "value"], { noCache: true }
			);
			const creatorRows = await q(
				"SELECT IC.itemID, C.firstName, C.lastName, C.fieldMode, IC.creatorTypeID FROM itemCreators IC "
				+ `JOIN creators C ON C.creatorID=IC.creatorID WHERE IC.itemID IN (${idsSQL}) ORDER BY IC.itemID, IC.orderIndex`,
				[], ["itemID", "firstName", "lastName", "fieldMode", "creatorTypeID"], { noCache: true }
			);
			const tagRows = await q(
				`SELECT IT.itemID, T.name, IT.type FROM itemTags IT JOIN tags T ON T.tagID=IT.tagID WHERE IT.itemID IN (${idsSQL}) ORDER BY T.name COLLATE NOCASE`,
				[], ["itemID", "name", "type"], { noCache: true }
			);
			const collRows = await q(
				"SELECT CI.itemID, C.key, C.collectionName FROM collectionItems CI JOIN collections C ON C.collectionID=CI.collectionID "
				+ `WHERE CI.itemID IN (${idsSQL}) AND C.collectionID NOT IN (SELECT collectionID FROM deletedCollections)`,
				[], ["itemID", "key", "collectionName"], { noCache: true }
			);
			const relRows = await q(
				"SELECT R.itemID, P.predicate, R.object FROM itemRelations R JOIN relationPredicates P ON P.predicateID=R.predicateID "
				+ `WHERE R.itemID IN (${idsSQL}) AND P.predicate='dc:relation'`,
				[], ["itemID", "predicate", "object"], { noCache: true }
			);
			// Child notes, plus the item's own note if it is a note
			const noteRows = await q(
				"SELECT N.itemID, N.parentItemID, N.note, N.title, I.key FROM itemNotes N JOIN items I ON I.itemID=N.itemID "
				+ `WHERE (N.parentItemID IN (${idsSQL}) OR N.itemID IN (${idsSQL})) AND N.itemID NOT IN (SELECT itemID FROM deletedItems) `
				+ "ORDER BY I.dateAdded",
				[], ["itemID", "parentItemID", "note", "title", "key"], { noCache: true }
			);
			const parentRows = await q(
				"SELECT X.itemID, P.key FROM (SELECT itemID, parentItemID FROM itemAttachments WHERE parentItemID IS NOT NULL "
				+ "UNION ALL SELECT itemID, parentItemID FROM itemNotes WHERE parentItemID IS NOT NULL "
				+ "UNION ALL SELECT itemID, parentItemID FROM itemAnnotations) X JOIN items P ON P.itemID=X.parentItemID "
				+ `WHERE X.itemID IN (${idsSQL})`,
				[], ["itemID", "key"], { noCache: true }
			);
			const parents = new Map(parentRows.map(r => [r.itemID, r.key]));
			const atts = await attachmentRows("A.parentItemID IN ($IDS) OR A.itemID IN ($IDS)", ids);

			const items = [];
			for (const key of keys) {
				const r = byKey.get(key);
				if (!r) {
					items.push({ key, error: "Item not found" });
					continue;
				}
				const id = r.itemID;
				const o = { key, itemType: m.typeName.get(r.itemTypeID) };
				if (r.libraryID !== 1) o.libraryID = r.libraryID;
				if (r.trashed) o.inTrash = true;
				if (parents.has(id)) o.parentKey = parents.get(id);
				const fields = {};
				for (const f of fieldRows) {
					if (f.itemID !== id) continue;
					const name = m.fieldName.get(f.fieldID) || String(f.fieldID);
					if (m.dateIDs.has(f.fieldID)) {
						const d = parseMultipartDate(f.value);
						fields[name] = d.str;
						if (d.year) o.year = d.year;
					}
					else {
						fields[name] = f.value;
					}
				}
				o.fields = fields;
				const creators = creatorRows.filter(c => c.itemID === id).map((c) => {
					const type = m.creatorType.get(c.creatorTypeID) || "author";
					return c.fieldMode === 1 ? { name: c.lastName, type } : { last: c.lastName, first: c.firstName, type };
				});
				if (creators.length) o.creators = creators;
				const tags = tagRows.filter(t => t.itemID === id).map(t => t.name);
				if (tags.length) o.tags = tags;
				const colls = collRows.filter(c => c.itemID === id).map(c => ({ key: c.key, name: c.collectionName }));
				if (colls.length) o.collections = colls;
				const related = relRows.filter(x => x.itemID === id)
					.map(x => (/\/items\/([A-Z0-9]{8})$/.exec(x.object) || [])[1]).filter(Boolean);
				if (related.length) o.relatedKeys = related;
				o.dateAdded = r.dateAdded;
				o.dateModified = r.dateModified;

				const own = noteRows.find(n => n.itemID === id);
				if (own) {
					const text = htmlToText(own.note);
					o.note = { title: own.title, chars: text.length, text: truncate(text, noteChars) };
				}
				const childAtts = atts.filter(a => a._parentItemID === id || a._itemID === id).map(a => stripInternal({ ...a }));
				if (childAtts.length) o.attachments = childAtts;
				const notes = noteRows.filter(n => n.parentItemID === id).map((n) => {
					const text = htmlToText(n.note);
					const no = { key: n.key, title: n.title, chars: text.length };
					if (noteChars > 0) no.text = truncate(text, noteChars);
					return no;
				});
				if (notes.length) o.notes = notes;
				o.zoteroUri = r.libraryID === 1 ? `zotero://select/library/items/${key}` : undefined;
				items.push(o);
			}
			return { items };
		}

		// ---------------------------------------------------------------- annotations
		async function getAnnotations(args) {
			const m = await meta();
			const keys = keysArg(args.keys ?? args.key, 20);
			const limit = intArg(args.limit, 300, 1, 5000);
			const offset = intArg(args.offset, 0, 0, 1e9);
			const rows = await resolveKeys(keys, args.libraryID);
			if (!rows.length) throw new ToolError("Item not found");
			const ids = idList(rows.map(r => r.itemID));
			const params = [];
			let extra = "";
			if (args.query) {
				extra = ` AND (${m.sqlAnnText} LIKE ? ESCAPE '\\' OR ${m.sqlAnnComment} LIKE ? ESCAPE '\\')`;
				const p = "%" + escapeLike(env.normalize(String(args.query))) + "%";
				params.push(p, p);
			}
			const types = strArray(args.types, "types");
			if (types.length) {
				const tids = Object.entries(ANNOTATION_TYPES).filter(([, n]) => types.includes(n)).map(([i]) => +i);
				extra += ` AND AN.type IN (${idList(tids.length ? tids : [-1])})`;
			}
			const annRows = await q(
				"SELECT AN.itemID, I.key, AI.key AS attachmentKey, PI.key AS parentKey, AN.type, AN.text, AN.comment, AN.color, "
				+ "AN.pageLabel, AN.authorName, I.dateModified, I.libraryID, G.groupID, COUNT(*) OVER () AS total "
				+ "FROM itemAnnotations AN JOIN items I ON I.itemID=AN.itemID "
				+ "JOIN itemAttachments A ON A.itemID=AN.parentItemID JOIN items AI ON AI.itemID=A.itemID "
				+ "LEFT JOIN items PI ON PI.itemID=A.parentItemID LEFT JOIN groups G ON G.libraryID=I.libraryID "
				+ `WHERE (A.itemID IN (${ids}) OR A.parentItemID IN (${ids}) OR AN.itemID IN (${ids})) `
				+ "AND AN.itemID NOT IN (SELECT itemID FROM deletedItems) AND A.itemID NOT IN (SELECT itemID FROM deletedItems)"
				+ extra + " ORDER BY AN.parentItemID, AN.sortIndex LIMIT ? OFFSET ?",
				[...params, limit, offset],
				["itemID", "key", "attachmentKey", "parentKey", "type", "text", "comment", "color", "pageLabel",
					"authorName", "dateModified", "libraryID", "groupID", "total"],
				{ noCache: true }
			);
			const tagMap = new Map();
			if (annRows.length) {
				const tagRows = await q(
					"SELECT IT.itemID, T.name FROM itemTags IT JOIN tags T ON T.tagID=IT.tagID "
					+ `WHERE IT.itemID IN (${idList(annRows.map(a => a.itemID))})`,
					[], ["itemID", "name"], { noCache: true }
				);
				for (const t of tagRows) {
					if (!tagMap.has(t.itemID)) tagMap.set(t.itemID, []);
					tagMap.get(t.itemID).push(t.name);
				}
			}
			return {
				total: annRows.length ? annRows[0].total : 0,
				offset,
				annotations: annRows.map((a) => {
					const o = { key: a.key, attachmentKey: a.attachmentKey, type: ANNOTATION_TYPES[a.type] || String(a.type) };
					if (a.parentKey) o.parentKey = a.parentKey;
					if (a.pageLabel) o.page = a.pageLabel;
					if (a.text) o.text = a.text;
					if (a.comment) o.comment = a.comment;
					if (a.color) o.color = a.color;
					if (a.authorName) o.author = a.authorName;
					if (tagMap.has(a.itemID)) o.tags = tagMap.get(a.itemID);
					if (a.type === 3 || a.type === 4) {
						const p = env.annotationImagePath(a.libraryID, a.groupID, a.key);
						if (p && env.fileInfo(p).exists) o.imagePath = p;
					}
					o.dateModified = a.dateModified;
					return o;
				})
			};
		}

		// ---------------------------------------------------------------- search
		/**
		 * Query syntax:
		 *   words              all must match (anywhere in the chosen fields)
		 *   "exact phrase"     phrase match
		 *   a|b|"c d"          alternatives (synonyms) for one concept; also `a OR b`
		 *   -word / -"phrase"  exclude items whose metadata/notes match
		 */
		function parseQuery(query, opts = {}) {
			const chunks = String(query).match(/-?(?:"[^"]*"?|[^\s"])+/g) || [];
			const clauses = [];
			const excludes = [];
			let pendingOr = false;
			const unquotedCount = chunks.filter(c => !c.includes('"')).length;
			for (let raw of chunks) {
				if (raw === "OR" || raw === "|") { pendingOr = true; continue; }
				if (raw === "AND" || raw === "&&") continue;
				let neg = false;
				if (raw.length > 1 && raw.startsWith("-")) { neg = true; raw = raw.slice(1); }
				const alts = [];
				for (const part of raw.match(/"[^"]*"?|[^|]+/g) || []) {
					const quoted = part.startsWith('"');
					const text = env.normalize(part.replace(/"/g, "").trim());
					if (!text) continue;
					if (!quoted && !neg && STOPWORDS.has(text) && chunks.length > 1 && unquotedCount > 1) continue;
					alts.push({ text, quoted, match: quoted || opts.stem === false ? text : stem(text) });
				}
				if (!alts.length) continue;
				if (neg) excludes.push(...alts);
				else if (pendingOr && clauses.length) clauses[clauses.length - 1].push(...alts);
				else clauses.push(alts);
				pendingOr = false;
			}
			return { clauses, excludes };
		}

		// Word-start test on normalized text: "learn" fully matches "learning", "e-learning"; a
		// mid-word hit ("earn" in "learning") counts less. Short terms (<3) must match whole words.
		function matchQuality(text, term) {
			if (!text) return 0;
			const t = env.normalize(text);
			const idx = t.indexOf(term);
			if (idx === -1) return 0.5; // matched by SQL LIKE on a differently-folded form
			const re = term.length < 3
				? new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(term)}($|[^\\p{L}\\p{N}])`, "u")
				: new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(term)}`, "u");
			if (re.test(t)) return 1;
			return term.length < 3 ? 0 : 0.35;
		}

		// Returns Map(topLevelItemID -> {s: score, f: {group: weight}}) for one term
		async function termHits(term, groups, ctx) {
			const cacheKey = term.match + "\u0000" + [...groups].join(",");
			if (ctx.cache.has(cacheKey)) return ctx.cache.get(cacheKey);
			const m = await meta();
			const pattern = "%" + escapeLike(term.match) + "%";
			const hits = new Map();
			const add = (id, group, w) => {
				if (w <= 0 || id == null) return;
				let h = hits.get(id);
				if (!h) hits.set(id, h = { f: {} });
				if (!(h.f[group] >= w)) h.f[group] = w;
			};
			const jobs = [];

			const wantFields = ["title", "abstract", "publication", "other"].some(g => groups.has(g));
			if (wantFields) {
				jobs.push(q(
					"SELECT D.itemID, D.fieldID, V.value, "
					+ "(SELECT parentItemID FROM itemAttachments WHERE itemID=D.itemID) AS parent "
					+ `FROM itemDataValues V JOIN itemData D ON D.valueID=V.valueID WHERE ${m.sqlValue} LIKE ? ESCAPE '\\'`,
					[pattern], ["itemID", "fieldID", "value", "parent"]
				).then((rows) => {
					for (const r of rows) {
						const g = m.fieldGroup.get(r.fieldID);
						if (!g || !groups.has(g[0])) continue;
						const quality = matchQuality(r.value, term.match);
						if (r.parent != null) {
							// Title of a child attachment: weak signal for the parent
							add(r.parent, "attachmentTitle", W.attachmentTitle * quality);
							continue;
						}
						add(r.itemID, g[0], g[1] * quality);
						if (g[0] === "title" && g[1] === W.title) ctx.titles.set(r.itemID, r.value);
						else if (g[0] === "abstract") ctx.abstracts.set(r.itemID, r.value);
					}
				}));
			}
			if (groups.has("creators")) {
				jobs.push(q(
					"SELECT IC.itemID, C.lastName, C.firstName FROM creators C JOIN itemCreators IC ON IC.creatorID=C.creatorID "
					+ `WHERE ${m.sqlLast} LIKE ? ESCAPE '\\' OR ${m.sqlFirst} LIKE ? ESCAPE '\\'`,
					[pattern, pattern], ["itemID", "lastName", "firstName"]
				).then((rows) => {
					for (const r of rows) {
						add(r.itemID, "creators", Math.max(
							W.creatorsLast * matchQuality(r.lastName, term.match),
							W.creatorsFirst * matchQuality(r.firstName, term.match)
						));
					}
				}));
			}
			if (groups.has("tags")) {
				jobs.push(q(
					"SELECT COALESCE((SELECT A.parentItemID FROM itemAttachments A WHERE A.itemID=IT.itemID), "
					+ "(SELECT N.parentItemID FROM itemNotes N WHERE N.itemID=IT.itemID), "
					+ "(SELECT COALESCE(A2.parentItemID, A2.itemID) FROM itemAnnotations AN JOIN itemAttachments A2 ON A2.itemID=AN.parentItemID WHERE AN.itemID=IT.itemID), "
					+ "IT.itemID) AS top, T.name "
					+ `FROM tags T JOIN itemTags IT ON IT.tagID=T.tagID WHERE ${m.sqlTag} LIKE ? ESCAPE '\\'`,
					[pattern], ["top", "name"]
				).then((rows) => {
					for (const r of rows) {
						const exact = env.normalize(r.name) === term.text ? 1.3 : 1;
						add(r.top, "tags", W.tags * matchQuality(r.name, term.match) * exact);
					}
				}));
			}
			if (groups.has("notes")) {
				jobs.push((async () => {
					let clause = null;
					try {
						clause = env.noteMatchSQL ? await env.noteMatchSQL(term.match) : null;
					}
					catch (e) { clause = null; }
					const where = clause ? clause.sql : "(note LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')";
					const params = clause ? clause.params : [pattern, pattern];
					const rows = await q(
						`SELECT itemID, parentItemID, title FROM itemNotes WHERE ${where}`,
						params, ["itemID", "parentItemID", "title"], { noCache: true }
					);
					for (const r of rows) {
						if (r.parentItemID != null) {
							add(r.parentItemID, "notes", W.notes);
						}
						else {
							// Standalone note: its title is effectively its item title
							const tq = matchQuality(r.title, term.match);
							add(r.itemID, "notes", tq > 0.5 ? W.noteTitle * tq : W.notes);
						}
					}
				})());
			}
			if (groups.has("annotations")) {
				jobs.push(q(
					"SELECT DISTINCT COALESCE(A.parentItemID, A.itemID) AS top FROM itemAnnotations AN "
					+ "JOIN itemAttachments A ON A.itemID=AN.parentItemID "
					+ `WHERE ${m.sqlAnnText} LIKE ? ESCAPE '\\' OR ${m.sqlAnnComment} LIKE ? ESCAPE '\\'`,
					[pattern, pattern], ["top"]
				).then((rows) => {
					for (const r of rows) add(r.top, "annotations", W.annotations);
				}));
			}
			if (groups.has("fulltext") && term.match.length >= 3 && env.fulltextItemIDs) {
				jobs.push((async () => {
					let ids = null;
					try {
						ids = await env.fulltextItemIDs(term.match, ctx.libraryID);
					}
					catch (e) {
						ctx.warnings.add("Full-text index query failed: " + (e && e.message || e));
					}
					if (!ids || !ids.length) return;
					for (const part of chunk(ids, 5000)) {
						const rows = await q(
							`SELECT COALESCE(parentItemID, itemID) AS top FROM itemAttachments WHERE itemID IN (${idList(part)})`,
							[], ["top"], { noCache: true }
						);
						for (const r of rows) add(r.top, "fulltext", W.fulltext);
					}
				})());
			}
			await Promise.all(jobs);
			for (const h of hits.values()) {
				let s = 0;
				for (const k in h.f) s += h.f[k];
				h.s = s;
			}
			ctx.cache.set(cacheKey, hits);
			return hits;
		}

		// concepts: [["experiment","randomized","rct"], ["generative ai","chatgpt"], ...] or ["a|b", "c"]
		function conceptsArg(v) {
			if (v === undefined || v === null) return [];
			if (!Array.isArray(v)) throw new ToolError("'concepts' must be an array; each entry is a synonym list (array) or a 'a|b|c' string");
			return v.map((c) => {
				if (typeof c === "string") return c.split("|");
				if (Array.isArray(c) && c.every(x => typeof x === "string")) return c;
				throw new ToolError("Each concept must be an array of strings or a 'a|b|c' string");
			}).filter(c => c.length);
		}

		function groupsArg(v) {
			const list = strArray(v, "fields");
			if (!list.length) return new Set(ALL_FIELD_GROUPS);
			const bad = list.filter(g => !ALL_FIELD_GROUPS.includes(g));
			if (bad.length) throw new ToolError(`Unknown field group(s): ${bad.join(", ")}. Valid: ${ALL_FIELD_GROUPS.join(", ")}`);
			return new Set(list);
		}

		// SQL filter over items I (top-level, non-feed, optionally non-trashed + user filters)
		async function filterSQL(args, m) {
			const where = [
				"I.itemID NOT IN (SELECT itemID FROM itemAttachments WHERE parentItemID IS NOT NULL)",
				"I.itemID NOT IN (SELECT itemID FROM itemNotes WHERE parentItemID IS NOT NULL)",
				"I.itemID NOT IN (SELECT itemID FROM itemAnnotations)",
				"I.libraryID NOT IN (SELECT libraryID FROM libraries WHERE type='feed')"
			];
			const params = [];
			const info = {};
			if (!args.includeTrashed) where.push("I.itemID NOT IN (SELECT itemID FROM deletedItems)");
			if (args.libraryID != null) {
				where.push("I.libraryID=?");
				params.push(intArg(args.libraryID, 1, 0, 1e9));
			}
			const types = strArray(args.itemTypes, "itemTypes");
			if (types.length) {
				const tids = types.map((t) => {
					const id = m.typeID.get(t);
					if (id === undefined) {
						throw new ToolError(`Unknown item type '${t}'. Valid types: ${[...m.typeID.keys()].filter(x => x !== "annotation").sort().join(", ")}`);
					}
					return id;
				});
				where.push(`I.itemTypeID IN (${idList(tids)})`);
			}
			const excludeTypes = strArray(args.excludeItemTypes, "excludeItemTypes");
			if (excludeTypes.length) {
				const tids = excludeTypes.map(t => m.typeID.get(t)).filter(x => x !== undefined);
				if (tids.length) where.push(`I.itemTypeID NOT IN (${idList(tids)})`);
			}
			if (args.collection) {
				const scope = await collectionScope(args.collection, args.libraryID != null ? intArg(args.libraryID, 1, 0, 1e9) : null,
					args.includeSubcollections !== false);
				where.push(`I.itemID IN (SELECT itemID FROM collectionItems WHERE collectionID IN (${idList(scope.ids)}))`);
				info.collection = { key: scope.root.key, path: scope.root._path, collectionsSearched: scope.ids.length };
			}
			for (const tag of strArray(args.tags, "tags")) {
				// LIKE without wildcards = case-insensitive equality against the folded tag
				where.push(`I.itemID IN (SELECT IT.itemID FROM itemTags IT JOIN tags T ON T.tagID=IT.tagID WHERE ${m.sqlTag} LIKE ? ESCAPE '\\')`);
				params.push(escapeLike(env.normalize(tag)));
			}
			const yearExpr = `(SELECT CAST(SUBSTR(V.value,1,4) AS INTEGER) FROM itemData D JOIN itemDataValues V ON V.valueID=D.valueID `
				+ `WHERE D.itemID=I.itemID AND D.fieldID IN (${idList([...m.dateIDs])}) LIMIT 1)`;
			if (args.yearFrom != null) {
				where.push(`${yearExpr} >= ?`);
				params.push(intArg(args.yearFrom, 0, 0, 9999));
			}
			if (args.yearTo != null) {
				where.push(`${yearExpr} BETWEEN 1 AND ?`);
				params.push(intArg(args.yearTo, 9999, 0, 9999));
			}
			if (args.addedAfter) {
				const d = String(args.addedAfter);
				if (!/^\d{4}-\d{2}-\d{2}/.test(d)) throw new ToolError("addedAfter must be a date like 2024-01-31");
				where.push("I.dateAdded >= ?");
				params.push(d);
			}
			return { where: where.join(" AND "), params, yearExpr, info };
		}

		const SORTS = {
			dateAdded: "I.dateAdded DESC",
			dateModified: "I.dateModified DESC",
			year: "y DESC, I.dateAdded DESC",
			yearAsc: "y IS NULL, y ASC, I.dateAdded DESC",
			title: "t IS NULL, t COLLATE NOCASE ASC"
		};

		async function searchItems(args) {
			const m = await meta();
			const t0 = Date.now();
			const limit = intArg(args.limit, 25, 1, 200);
			const offset = intArg(args.offset, 0, 0, 1e9);
			let sort = args.sort || "relevance";
			if (sort !== "relevance" && !SORTS[sort]) throw new ToolError(`Unknown sort '${sort}'. Valid: relevance, ${Object.keys(SORTS).join(", ")}`);
			const groups = groupsArg(args.fields);
			if (args.fulltext === false) groups.delete("fulltext");
			const mode = ["all", "any", "best"].includes(args.mode) ? args.mode : "best";
			const parsed = parseQuery(args.query || "", { stem: args.stem });
			for (const concept of conceptsArg(args.concepts)) {
				const alts = concept.map((t) => {
					const text = env.normalize(t.trim());
					const quoted = /\s/.test(text);
					return { text, quoted, match: quoted || args.stem === false ? text : stem(text) };
				}).filter(a => a.text);
				if (alts.length) parsed.clauses.push(alts);
			}
			const filter = await filterSQL(args, m);
			const sumOpts = {
				includeAbstract: !!args.includeAbstract, includeTags: !!args.includeTags,
				abstractChars: intArg(args.abstractChars, 1500, 50, 100000)
			};
			const titleExpr = `(SELECT V.value FROM itemData D JOIN itemDataValues V ON V.valueID=D.valueID `
				+ `WHERE D.itemID=I.itemID AND D.fieldID IN (${idList([...m.titleIDs])}) LIMIT 1)`;

			// ---- Browse mode (no query): pure SQL with ORDER BY/LIMIT
			if (!parsed.clauses.length) {
				if (sort === "relevance") sort = "dateAdded";
				const rows = await q(
					`SELECT I.itemID, ${filter.yearExpr} AS y, ${titleExpr} AS t, COUNT(*) OVER () AS total FROM items I `
					+ `WHERE ${filter.where} ORDER BY ${SORTS[sort]} LIMIT ? OFFSET ?`,
					[...filter.params, limit, offset], ["itemID", "y", "t", "total"], { noCache: true }
				);
				const total = rows.length ? rows[0].total : 0;
				return {
					total, offset, sort,
					...filter.info,
					items: await summaries(rows.map(r => r.itemID), sumOpts),
					ms: Date.now() - t0
				};
			}

			// ---- Query mode
			const ctx = {
				cache: new Map(), titles: new Map(), abstracts: new Map(), warnings: new Set(),
				libraryID: args.libraryID != null ? intArg(args.libraryID, 1, 0, 1e9) : null
			};
			const clauseHits = [];
			for (const alts of parsed.clauses) {
				const merged = new Map();
				const perAlt = await Promise.all(alts.map(a => termHits(a, groups, ctx)));
				perAlt.forEach((hits, i) => {
					for (const [id, h] of hits) {
						const cur = merged.get(id);
						if (!cur) merged.set(id, { best: h.s, sum: h.s, f: { ...h.f }, terms: [alts[i].text] });
						else {
							cur.best = Math.max(cur.best, h.s);
							cur.sum += h.s;
							cur.terms.push(alts[i].text);
							for (const k in h.f) if (!(cur.f[k] >= h.f[k])) cur.f[k] = h.f[k];
						}
					}
				});
				// Several synonyms of one concept hitting the same item is extra evidence, with diminishing returns
				for (const h of merged.values()) h.s = Math.min(h.best * 1.5, h.best + 0.3 * (h.sum - h.best));
				clauseHits.push(merged);
			}
			const excluded = new Set();
			if (parsed.excludes.length) {
				const exGroups = new Set([...groups].filter(g => g !== "fulltext"));
				for (const ex of parsed.excludes) {
					for (const id of (await termHits(ex, exGroups, ctx)).keys()) excluded.add(id);
				}
			}

			const n = clauseHits.length;
			// all: every concept must match. any: at least one. best (default): enough concepts to be
			// on-topic (all of 1-2, half of 3+), ranked so full matches lead.
			const minCoverage = mode === "all" ? n : mode === "any" ? 1 : (n <= 2 ? 1 : Math.ceil(n / 2));
			const scores = new Map();
			const counts = new Map();
			for (const ch of clauseHits) for (const id of ch.keys()) counts.set(id, (counts.get(id) || 0) + 1);
			let fullMatches = 0;
			for (const [id, c] of counts) {
				if (excluded.has(id) || c < minCoverage) continue;
				let s = 0;
				const matched = {};
				for (let i = 0; i < n; i++) {
					const h = clauseHits[i].get(id);
					if (!h) continue;
					s += h.s;
					matched[h.terms.join("|")] = Object.keys(h.f);
				}
				// Coverage dominates: an item hitting more concepts outranks a strong single-concept hit
				s += 10 * c + (c === n ? 15 : 0);
				scores.set(id, { s, matched, c });
			}
			// Phrase bonus: the whole (first-alternative) query appearing verbatim in title/abstract
			if (n > 1) {
				const phrase = parsed.clauses.map(a => a[0].text).join(" ");
				for (const [id, v] of scores) {
					const t = ctx.titles.get(id);
					if (t && env.normalize(t).includes(phrase)) v.s += 8;
					const ab = ctx.abstracts.get(id);
					if (ab && env.normalize(ab).includes(phrase)) v.s += 3;
				}
			}
			const rows = await candidateRows([...scores.keys()]);
			for (const r of rows) if (scores.get(r.itemID).c === n) fullMatches++;

			async function candidateRows(ids) {
				const out = [];
				for (const part of chunk(ids, 20000)) {
					out.push(...await q(
						`SELECT I.itemID, ${filter.yearExpr} AS y, I.dateAdded, I.dateModified, ${sort === "title" ? titleExpr : "NULL"} AS t `
						+ `FROM items I WHERE I.itemID IN (${idList(part)}) AND ${filter.where}`,
						filter.params, ["itemID", "y", "dateAdded", "dateModified", "t"], { noCache: true }
					));
				}
				return out;
			}

			const cmp = {
				relevance: (a, b) => scores.get(b.itemID).s - scores.get(a.itemID).s || (b.y || 0) - (a.y || 0),
				dateAdded: (a, b) => (b.dateAdded > a.dateAdded ? 1 : b.dateAdded < a.dateAdded ? -1 : 0),
				dateModified: (a, b) => (b.dateModified > a.dateModified ? 1 : b.dateModified < a.dateModified ? -1 : 0),
				year: (a, b) => (b.y || 0) - (a.y || 0),
				yearAsc: (a, b) => (a.y || 99999) - (b.y || 99999),
				title: (a, b) => TITLE_COLLATOR.compare(String(a.t || "￿"), String(b.t || "￿"))
			}[sort];
			rows.sort(cmp);
			const page = rows.slice(offset, offset + limit);
			const items = await summaries(page.map(r => r.itemID), {
				...sumOpts,
				extra: (id) => {
					const sc = scores.get(id);
					const o = { score: Math.round(sc.s * 10) / 10 };
					o.matched = sc.matched;
					return o;
				}
			});
			const result = {
				total: rows.length, fullMatches, offset, sort, mode,
				interpreted: {
					all: parsed.clauses.map(a => (a.length > 1 ? a.map(x => x.text) : a[0].text)),
					...(parsed.excludes.length ? { exclude: parsed.excludes.map(x => x.text) } : {})
				},
				...filter.info,
				items,
				ms: Date.now() - t0
			};
			if (n > 1 && fullMatches < Math.min(limit, rows.length)) {
				result.note = `${fullMatches} item(s) matched all ${n} concepts; the rest match some (see coverage). `
					+ "If recall matters, add more synonyms per concept, or filter (year/collection/type) and screen with includeAbstract.";
			}
			if (ctx.warnings.size) result.warnings = [...ctx.warnings];
			return result;
		}

		// ---------------------------------------------------------------- library info
		async function libraryInfo() {
			const libs = await libraries();
			const counts = await q(
				"SELECT I.libraryID, COUNT(*) AS n FROM items I WHERE "
				+ "I.itemID NOT IN (SELECT itemID FROM itemAttachments WHERE parentItemID IS NOT NULL) "
				+ "AND I.itemID NOT IN (SELECT itemID FROM itemNotes WHERE parentItemID IS NOT NULL) "
				+ "AND I.itemID NOT IN (SELECT itemID FROM itemAnnotations) "
				+ "AND I.itemID NOT IN (SELECT itemID FROM deletedItems) GROUP BY I.libraryID",
				[], ["libraryID", "n"]
			);
			const byLib = new Map(counts.map(c => [c.libraryID, c.n]));
			const [att] = await q(
				"SELECT COUNT(*) AS n, SUM(contentType='application/pdf') AS pdf FROM itemAttachments WHERE linkMode != 3 "
				+ "AND itemID NOT IN (SELECT itemID FROM deletedItems)", [], ["n", "pdf"]
			);
			return {
				...env.info(),
				libraries: libs.filter(l => l.type !== "feed").map(l => ({ ...l, topLevelItems: byLib.get(l.libraryID) || 0 })),
				fileAttachments: att ? { total: att.n, pdf: att.pdf || 0 } : null
			};
		}

		// ======================================================================================
		const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
		const keysSchema = {
			oneOf: [
				{ type: "string", description: "8-character Zotero item key" },
				{ type: "array", items: { type: "string" }, maxItems: 50 }
			]
		};

		const definitions = [
			{
				name: "search_items",
				title: "Search Zotero library",
				description:
					"Ranked search over the local Zotero library: titles, abstracts, creators, tags, publication, other fields, "
					+ "notes, PDF annotations, and Zotero's full-text index of attachments. Case/accent-insensitive; words are "
					+ "stemmed and prefix-matched (\"experimental\" also finds \"experiment\", \"experiments\").\n"
					+ "This is a LEXICAL search, so for a topical question YOU supply the vocabulary: break the request into 2-4 "
					+ "concepts and give each concept 4-10 synonyms/related terms via `concepts`, e.g. for 'experimental evidence on "
					+ "teaching with AI': concepts=[[\"experiment\",\"randomized\",\"RCT\",\"quasi-experimental\",\"field study\",\"causal\",\"effect\",\"meta-analysis\"], "
					+ "[\"AI\",\"generative AI\",\"ChatGPT\",\"LLM\",\"chatbot\",\"GenAI\"], [\"teaching\",\"learning\",\"students\",\"classroom\",\"course\",\"education\",\"instruction\",\"feedback\",\"tutor\"]]. "
					+ "Default mode 'best' returns items matching all concepts first, then items matching most of them (`coverage`).\n"
					+ "For high recall when a filter makes the set small (e.g. one year or one collection, see `total`), browse it "
					+ "without a query using includeAbstract=true and judge relevance yourself: each item comes with its abstract or, "
					+ "when it has none, an `excerpt` of its full text. Reading 50-150 such entries is cheap and finds items "
					+ "that never use your words.\n"
					+ "`query` string syntax (alternative to concepts): space-separated concepts; a|b|\"c d\" synonyms; \"exact phrase\"; -term excludes. "
					+ "Each result has `matched` (which fields each term hit). Next: get_items for full metadata/notes, get_attachments for file paths.",
				inputSchema: {
					type: "object",
					properties: {
						query: { type: "string", description: "Search query (see syntax above). Optional when filters are given." },
						concepts: {
							type: "array",
							items: { oneOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] },
							description: "List of concepts, each a list of synonyms (or an 'a|b|c' string). Multi-word entries are phrases. Combined with `query` if both given."
						},
						mode: { type: "string", enum: ["best", "all", "any"], description: "best (default): all-concept matches first, then partial matches covering at least half the concepts. all: every concept required. any: at least one." },
						stem: { type: "boolean", description: "Stem single words (default true). Set false for exact word-prefix matching." },
						fields: {
							type: "array", items: { type: "string", enum: ALL_FIELD_GROUPS },
							description: "Restrict which fields are searched. Default: all. e.g. [\"title\",\"abstract\",\"tags\"] for a metadata-only search."
						},
						fulltext: { type: "boolean", description: "Include attachment full text (default true). Set false for tighter, metadata-only topical matches." },
						collection: { type: "string", description: "Collection key (or exact name/path) to restrict to." },
						includeSubcollections: { type: "boolean", description: "Default true." },
						tags: { type: "array", items: { type: "string" }, description: "Items must have ALL of these tags (exact, case-insensitive)." },
						itemTypes: { type: "array", items: { type: "string" }, description: "e.g. [\"journalArticle\",\"book\",\"bookSection\",\"conferencePaper\",\"thesis\",\"report\",\"webpage\",\"note\"]" },
						excludeItemTypes: { type: "array", items: { type: "string" }, description: "e.g. [\"note\",\"attachment\"] to drop standalone notes/files." },
						yearFrom: { type: "integer" },
						yearTo: { type: "integer" },
						addedAfter: { type: "string", description: "Only items added to Zotero on/after this date (YYYY-MM-DD)." },
						libraryID: { type: "integer", description: "Restrict to one library (1 = My Library). Default: all libraries." },
						includeTrashed: { type: "boolean", description: "Default false." },
						sort: { type: "string", enum: ["relevance", "dateAdded", "dateModified", "year", "yearAsc", "title"], description: "Default: relevance (query) / dateAdded (browse)." },
						limit: { type: "integer", minimum: 1, maximum: 200, description: "Default 25." },
						offset: { type: "integer", minimum: 0 },
						includeAbstract: { type: "boolean", description: "Include abstracts in results (default false)." },
						abstractChars: { type: "integer", description: "Max abstract length when includeAbstract (default 1500)." },
						includeTags: { type: "boolean", description: "Include each item's tags (default false)." }
					},
					additionalProperties: false
				},
				annotations: RO,
				handler: searchItems
			},
			{
				name: "get_items",
				title: "Get item details",
				description: "Full metadata for one or more items by key: all fields, creators, tags, collections, related items, "
					+ "child notes (as plain text), and attachments with absolute file paths. Batch up to 50 keys.",
				inputSchema: {
					type: "object",
					properties: {
						keys: keysSchema,
						noteChars: { type: "integer", description: "Max characters per note text (default 2000; 0 = omit note text)." },
						libraryID: { type: "integer", description: "Only needed if a key exists in several libraries." }
					},
					required: ["keys"],
					additionalProperties: false
				},
				annotations: RO,
				handler: getItems
			},
			{
				name: "get_attachments",
				title: "Get attachment files",
				description: "Attachment files for items (or attachment keys): absolute `path` on disk, whether it `exists`, size, "
					+ "content type, and `fulltextCachePath` — a plain-text file holding Zotero's already-extracted text of the "
					+ "PDF/EPUB/HTML, which is usually the cheapest way to read a document. Batch up to 50 keys.",
				inputSchema: {
					type: "object",
					properties: { keys: keysSchema, libraryID: { type: "integer" } },
					required: ["keys"],
					additionalProperties: false
				},
				annotations: RO,
				handler: getAttachments
			},
			{
				name: "get_annotations",
				title: "Get PDF/EPUB annotations",
				description: "Highlights, underlines, notes and image annotations made in Zotero's reader, for a parent item or "
					+ "an attachment key, in reading order, with page labels, comments, colors and tags.",
				inputSchema: {
					type: "object",
					properties: {
						keys: keysSchema,
						query: { type: "string", description: "Only annotations whose text or comment contains this." },
						types: { type: "array", items: { type: "string", enum: Object.values(ANNOTATION_TYPES) } },
						limit: { type: "integer", description: "Default 300." },
						offset: { type: "integer" },
						libraryID: { type: "integer" }
					},
					required: ["keys"],
					additionalProperties: false
				},
				annotations: RO,
				handler: getAnnotations
			},
			{
				name: "list_collections",
				title: "List collections",
				description: "All collections as a flat list with full paths, keys, parent keys and item counts.",
				inputSchema: {
					type: "object",
					properties: {
						query: { type: "string", description: "Filter by substring of the collection path." },
						libraryID: { type: "integer" },
						limit: { type: "integer", description: "Default 500." }
					},
					additionalProperties: false
				},
				annotations: RO,
				handler: listCollections
			},
			{
				name: "list_tags",
				title: "List tags",
				description: "Tags with item counts, most used first. Useful to discover the library's vocabulary for a topic before searching.",
				inputSchema: {
					type: "object",
					properties: {
						query: { type: "string", description: "Substring filter." },
						includeAutomatic: { type: "boolean", description: "Include automatic (imported) tags. Default true." },
						libraryID: { type: "integer" },
						limit: { type: "integer", description: "Default 100." }
					},
					additionalProperties: false
				},
				annotations: RO,
				handler: listTags
			},
			{
				name: "library_info",
				title: "Library info",
				description: "Libraries (IDs, names, item counts), Zotero data/storage directories and version info.",
				inputSchema: { type: "object", properties: {}, additionalProperties: false },
				annotations: RO,
				handler: libraryInfo
			}
		];

		return {
			definitions,
			async call(name, args) {
				const def = definitions.find(d => d.name === name);
				if (!def) throw new ToolError(`Unknown tool: ${name}`);
				if (args != null && (typeof args !== "object" || Array.isArray(args))) throw new ToolError("Arguments must be an object");
				return def.handler(args || {});
			},
			// exposed for tests
			_internal: { parseQuery, htmlToText, parseMultipartDate, assertReadOnly }
		};
	}

	return { create, ToolError };
})();

if (typeof module !== "undefined") module.exports = ZMCPTools;
