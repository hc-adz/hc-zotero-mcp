/*
 * HC Zotero MCP — minimal HTTP/1.1 server on a loopback-only nsIServerSocket.
 *
 * Fully asynchronous: requests are read with nsIAsyncInputStream.asyncWait (no polling, no
 * blocking the UI thread) and responses are written with an asyncWait-driven write loop. One request per
 * connection (Connection: close), which is all MCP Streamable HTTP clients need.
 *
 * Expects in scope: Components, Services, ChromeUtils, TextEncoder, TextDecoder, setTimeout, clearTimeout
 */
var ZMCPHttp = (function () {
	"use strict";

	const Cc = Components.classes;
	const Ci = Components.interfaces;

	const MAX_HEADER_BYTES = 64 * 1024;
	const MAX_BODY_BYTES = 4 * 1024 * 1024;
	const READ_TIMEOUT_MS = 20000;
	const WRITE_TIMEOUT_MS = 60000;
	const REASONS = {
		200: "OK", 202: "Accepted", 204: "No Content", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
		404: "Not Found", 405: "Method Not Allowed", 408: "Request Timeout", 413: "Payload Too Large",
		415: "Unsupported Media Type", 421: "Misdirected Request", 431: "Request Header Fields Too Large",
		500: "Internal Server Error", 503: "Service Unavailable"
	};

	const encoder = new TextEncoder();
	const decoder = new TextDecoder("utf-8");

	class HttpError extends Error {
		constructor(status, message) {
			super(message);
			this.status = status;
		}
	}

	function concat(a, b) {
		const out = new Uint8Array(a.length + b.length);
		out.set(a, 0);
		out.set(b, a.length);
		return out;
	}

	function indexOfCRLFCRLF(buf, from) {
		for (let i = Math.max(0, from); i + 3 < buf.length; i++) {
			if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i;
		}
		return -1;
	}

	function latin1(buf) {
		let s = "";
		for (let i = 0; i < buf.length; i += 8192) s += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
		return s;
	}

	// Returns null if more bytes are needed, else the parsed request
	function tryParse(buf) {
		const end = indexOfCRLFCRLF(buf, 0);
		if (end === -1) {
			if (buf.length > MAX_HEADER_BYTES) throw new HttpError(431, "Headers too large");
			return null;
		}
		const lines = latin1(buf.subarray(0, end)).split("\r\n");
		const m = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(lines[0]);
		if (!m) throw new HttpError(400, "Malformed request line");
		const headers = {};
		for (let i = 1; i < lines.length; i++) {
			const idx = lines[i].indexOf(":");
			if (idx > 0) headers[lines[i].slice(0, idx).trim().toLowerCase()] = lines[i].slice(idx + 1).trim();
		}
		const bodyStart = end + 4;
		let body;
		if (/chunked/i.test(headers["transfer-encoding"] || "")) {
			const parts = [];
			let pos = bodyStart;
			let total = 0;
			for (;;) {
				let lineEnd = -1;
				for (let i = pos; i + 1 < buf.length; i++) {
					if (buf[i] === 13 && buf[i + 1] === 10) { lineEnd = i; break; }
				}
				if (lineEnd === -1) return null;
				const size = parseInt(latin1(buf.subarray(pos, lineEnd)).split(";")[0].trim(), 16);
				if (!Number.isFinite(size) || size < 0) throw new HttpError(400, "Bad chunk size");
				if (size === 0) {
					// Need the final CRLF (ignoring trailers)
					if (indexOfCRLFCRLF(buf, lineEnd) === -1 && !(buf[lineEnd + 2] === 13 && buf[lineEnd + 3] === 10)) return null;
					break;
				}
				total += size;
				if (total > MAX_BODY_BYTES) throw new HttpError(413, "Body too large");
				if (buf.length < lineEnd + 2 + size + 2) return null;
				parts.push(buf.subarray(lineEnd + 2, lineEnd + 2 + size));
				pos = lineEnd + 2 + size + 2;
			}
			body = new Uint8Array(total);
			let o = 0;
			for (const p of parts) { body.set(p, o); o += p.length; }
		}
		else {
			const len = headers["content-length"] ? parseInt(headers["content-length"], 10) : 0;
			if (!Number.isFinite(len) || len < 0) throw new HttpError(400, "Bad Content-Length");
			if (len > MAX_BODY_BYTES) throw new HttpError(413, "Body too large");
			if (buf.length < bodyStart + len) return null;
			body = buf.subarray(bodyStart, bodyStart + len);
		}
		const target = m[2];
		const q = target.indexOf("?");
		return {
			method: m[1],
			path: q === -1 ? target : target.slice(0, q),
			headers,
			body: decoder.decode(body)
		};
	}

	function readRequest(input) {
		const bin = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
		bin.setInputStream(input);
		return new Promise((resolve, reject) => {
			let buf = new Uint8Array(0);
			let done = false;
			let idle = 0;
			const finish = (err, req) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				err ? reject(err) : resolve(req);
			};
			const timer = setTimeout(() => finish(new HttpError(408, "Timed out reading request")), READ_TIMEOUT_MS);
			const callback = {
				onInputStreamReady() {
					if (done) return;
					let avail;
					try {
						avail = input.available();
					}
					catch (e) {
						return finish(new HttpError(0, "Connection closed"));
					}
					try {
						if (avail > 0) {
							idle = 0;
							if (buf.length + avail > MAX_HEADER_BYTES + MAX_BODY_BYTES) throw new HttpError(413, "Request too large");
							const ab = new ArrayBuffer(avail);
							bin.readArrayBuffer(avail, ab);
							buf = concat(buf, new Uint8Array(ab));
							const req = tryParse(buf);
							if (req) return finish(null, req);
						}
						else if (++idle > 50) {
							return finish(new HttpError(0, "Connection closed"));
						}
						input.asyncWait(callback, 0, 0, Services.tm.mainThread);
					}
					catch (e) {
						finish(e instanceof HttpError ? e : new HttpError(400, String(e)));
					}
				}
			};
			input.asyncWait(callback, 0, 0, Services.tm.mainThread);
		});
	}

	function buildResponse(status, headers, body) {
		const bodyBytes = body == null ? new Uint8Array(0) : encoder.encode(body);
		let head = `HTTP/1.1 ${status} ${REASONS[status] || "Status"}\r\n`;
		const h = Object.assign({
			"Content-Length": String(bodyBytes.length),
			"Cache-Control": "no-store",
			"Connection": "close"
		}, headers);
		if (body != null && !h["Content-Type"]) h["Content-Type"] = "application/json; charset=utf-8";
		for (const k in h) head += `${k}: ${h[k]}\r\n`;
		head += "\r\n";
		return concat(encoder.encode(head), bodyBytes);
	}

	const WRITE_CHUNK = 65536;
	const NS_BASE_STREAM_WOULD_BLOCK = 0x80470007;

	/**
	 * Write all bytes to the (non-blocking) socket output stream, waiting for writability with
	 * asyncWait whenever the socket buffer is full, then close the output stream. Resolves when
	 * every byte has been handed to the OS; rejects on a socket error.
	 */
	function writeAll(output, bytes) {
		const out = output.QueryInterface(Ci.nsIAsyncOutputStream);
		const data = latin1(bytes); // nsIOutputStream.write takes a byte string
		let off = 0;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				try { out.closeWithStatus(Components.results.NS_ERROR_NET_TIMEOUT); } catch (e) {}
				reject(new Error(`Timed out writing response (${off}/${data.length} bytes)`));
			}, WRITE_TIMEOUT_MS);
			const step = {
				onOutputStreamReady() {
					try {
						while (off < data.length) {
							const len = Math.min(WRITE_CHUNK, data.length - off);
							const n = out.write(data.substring(off, off + len), len);
							if (!n) break;
							off += n;
						}
					}
					catch (e) {
						if (e.result !== NS_BASE_STREAM_WOULD_BLOCK) {
							clearTimeout(timer);
							reject(new Error(`Socket write failed at ${off}/${data.length} bytes: ${e.message || e}`));
							return;
						}
					}
					if (off < data.length) {
						out.asyncWait(step, 0, 0, Services.tm.mainThread);
						return;
					}
					clearTimeout(timer);
					try { out.close(); } catch (e) {}
					resolve();
				}
			};
			step.onOutputStreamReady();
		});
	}

	// Resolve when the peer closes its end (or on timeout), discarding anything it still sends
	function waitForPeerClose(input, ms) {
		return new Promise((resolve) => {
			let done = false;
			const finish = () => {
				if (!done) { done = true; clearTimeout(timer); resolve(); }
			};
			const timer = setTimeout(finish, ms);
			const bin = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
			bin.setInputStream(input);
			let idle = 0;
			const cb = {
				onInputStreamReady() {
					if (done) return;
					try {
						const n = input.available();
						if (n > 0) { idle = 0; bin.readBytes(Math.min(n, 65536)); }
						else if (++idle > 50) return finish();
						input.asyncWait(cb, 0, 0, Services.tm.mainThread);
					}
					catch (e) {
						finish(); // closed by peer
					}
				}
			};
			try { input.asyncWait(cb, 0, 0, Services.tm.mainThread); } catch (e) { finish(); }
		});
	}

	function isLoopbackHost(hostname) {
		return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
	}

	/**
	 * @param {Object} opts
	 * @param {number} opts.port
	 * @param {string} [opts.token]          if set, require "Authorization: Bearer <token>"
	 * @param {Object} opts.protocol        ZMCPProtocol instance
	 * @param {Object} opts.health          object returned by GET /health
	 * @param {Function} opts.log
	 */
	function create(opts) {
		let socket = null;
		const open = new Set();

		const recentErrors = [];
		function noteError(msg) {
			recentErrors.push({ time: new Date().toISOString(), error: String(msg).slice(0, 300) });
			if (recentErrors.length > 20) recentErrors.shift();
			opts.log(msg, true);
		}

		async function handle(transport) {
			const conn = { transport, input: null, output: null };
			open.add(conn);
			let status = 0;
			try {
				conn.input = transport.openInputStream(0, 0, 0).QueryInterface(Ci.nsIAsyncInputStream);
				conn.output = transport.openOutputStream(0, 0, 0);
				let res;
				try {
					const req = await readRequest(conn.input);
					res = await route(req);
				}
				catch (e) {
					if (e instanceof HttpError) {
						if (!e.status) {
							noteError(`Request not received: ${e.message}`);
							return;
						}
						res = { status: e.status, body: JSON.stringify({ error: e.message }) };
					}
					else {
						noteError(`HTTP handler error: ${e && e.stack || e}`);
						res = { status: 500, body: JSON.stringify({ error: "Internal server error" }) };
					}
				}
				status = res.status;
				await writeAll(conn.output, buildResponse(res.status, res.headers || {}, res.body));
			}
			catch (e) {
				noteError(`Response ${status} not delivered: ${e && e.message || e}`);
			}
			finally {
				// Lingering close: closing a socket while the client is still receiving can turn into a
				// reset that discards data in flight. The client closes as soon as it has Content-Length
				// bytes (we send Connection: close), so wait for that EOF (bounded) before closing.
				if (conn.input && status) await waitForPeerClose(conn.input, 10000);
				try { conn.input && conn.input.close(); } catch (e) {}
				try { transport.close(0); } catch (e) {}
				open.delete(conn);
			}
		}

		async function route(req) {
			// DNS-rebinding protection: only accept loopback Host / Origin
			const host = (req.headers.host || "").replace(/:\d+$/, "");
			if (host && !isLoopbackHost(host)) return { status: 421, body: JSON.stringify({ error: "Invalid Host header" }) };
			if (req.headers.origin && req.headers.origin !== "null") {
				let ok = false;
				try { ok = isLoopbackHost(new URL(req.headers.origin).hostname); } catch (e) {}
				if (!ok) return { status: 403, body: JSON.stringify({ error: "Origin not allowed" }) };
			}

			const path = req.path.replace(/\/+$/, "") || "/";
			if (path === "/health" || path === "/") {
				if (req.method !== "GET") return { status: 405, headers: { Allow: "GET" }, body: null };
				return { status: 200, body: JSON.stringify({ ...opts.health(), recentErrors }) };
			}
			if (path !== "/mcp") return { status: 404, body: JSON.stringify({ error: "Not found. MCP endpoint is /mcp" }) };

			if (opts.token) {
				const auth = req.headers.authorization || "";
				const given = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
				let diff = given.length ^ opts.token.length;
				for (let i = 0; i < opts.token.length; i++) diff |= (given.charCodeAt(i) || 0) ^ opts.token.charCodeAt(i);
				if (diff) return { status: 401, headers: { "WWW-Authenticate": "Bearer" }, body: JSON.stringify({ error: "Unauthorized" }) };
			}

			if (req.method === "POST") {
				const ct = req.headers["content-type"] || "";
				if (ct && !/json/i.test(ct)) return { status: 415, body: JSON.stringify({ error: "Content-Type must be application/json" }) };
				const res = await opts.protocol.handleBody(req.body);
				return { status: res.status, body: res.body };
			}
			// Stateless server: no SSE stream (GET) and no sessions to terminate (DELETE)
			return { status: 405, headers: { Allow: "POST" }, body: null };
		}

		return {
			start() {
				if (socket) return;
				socket = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
				// loopbackOnly = true -> binds 127.0.0.1 only; never reachable from the network
				socket.init(opts.port, true, -1);
				socket.asyncListen({
					onSocketAccepted: (_server, transport) => { handle(transport); },
					onStopListening: () => {}
				});
				opts.log(`Listening on http://127.0.0.1:${opts.port}/mcp`);
			},
			stop() {
				if (socket) {
					try { socket.close(); } catch (e) {}
					socket = null;
				}
				for (const c of open) {
					try { c.transport.close(0); } catch (e) {}
				}
				open.clear();
			},
			get running() { return !!socket; }
		};
	}

	return { create, _tryParse: tryParse };
})();
