# HC Zotero MCP

A small, fast, **read-only** [MCP](https://modelcontextprotocol.io) server that runs inside Zotero as
a plugin. It lets AI assistants such as Claude search your Zotero library, read your notes and
annotations, and find your PDFs on disk without changing anything in your library.

Once installed, it serves MCP at:

```
http://127.0.0.1:37119/mcp
```

## Requirements

- **Zotero 10 or newer is strongly recommended.** Zotero 10 has a faster full-text index and
  built-in accent- and case-insensitive search columns, so full-text search is quicker and more
  accurate.
- Zotero 7, 8, and 9 also work. The plugin switches to Zotero's older word index automatically,
  so full-text search is slower and less precise there.
- Zotero 6 and older are **not** supported.
- Windows, macOS, or Linux.

To check your Zotero version:

- **Windows / Linux:** **Help → About Zotero**
- **macOS:** **Zotero → About Zotero**

To update, use **Help → Check for Updates…**, or download the latest version from
<https://www.zotero.org/download/>.

## Install

The plugin comes as a `.xpi` file inside a `.zip`. It's zipped because some browsers try to
install `.xpi` files as browser extensions, which won't work.

### Step 1: Download

1. Go to the [Releases page](https://github.com/hc-adz/hc-zotero-mcp/releases/latest).
2. Under **Assets**, click `hc-zotero-mcp-<version>.zip` to download it.

### Step 2: Unzip

**Windows**

1. Open your **Downloads** folder in File Explorer.
2. Right-click `hc-zotero-mcp-<version>.zip` and choose **Extract All…**, then click **Extract**.
3. A folder opens containing `hc-zotero-mcp-<version>.xpi`. Leave the window open.

**macOS**

1. Open your **Downloads** folder in Finder.
2. If Safari already unzipped the download, you'll see `hc-zotero-mcp-<version>.xpi`. Skip to Step 3.
3. Otherwise, double-click `hc-zotero-mcp-<version>.zip`. The `.xpi` appears next to it.

**Linux**

1. Open your **Downloads** folder in your file manager, right-click the `.zip`, and choose
   **Extract Here**. You can also run this in a terminal:

   ```bash
   cd ~/Downloads && unzip hc-zotero-mcp-*.zip
   ```

2. If you installed Zotero as a **Flatpak** or **Snap** and the file picker in Step 3 can't see
   your Downloads folder, move the `.xpi` into your home folder first.

### Step 3: Install in Zotero

These steps are the same on all three systems.

1. Open Zotero.
2. Go to **Tools → Plugins**.
3. Click the **gear icon** (⚙) in the top-right of the Plugins window and choose
   **Install Plugin From File…**.
4. Select `hc-zotero-mcp-<version>.xpi` and click **Open**. If Zotero asks for confirmation, click
   **Install**.
5. **HC Zotero MCP** now appears in the plugin list. You don't need to restart Zotero.

> **Upgrading from "Zotero MCP Lite"?** Remove it first in **Tools → Plugins**. Both use port
> 37119, so they can't run at the same time.

### Step 4: Check that it's running

With Zotero open, visit <http://127.0.0.1:37119/health> in your web browser. You should see
something like:

```json
{"status":"ok","server":"hc-zotero-mcp","version":"1.2.0", ...}
```

If the page doesn't load, see [Troubleshooting](#troubleshooting).

**Zotero must be open** whenever you want your AI assistant to use your library.

## Connect your AI assistant

### Claude Code

Run this in a terminal (any operating system):

```bash
claude mcp add --transport http zotero http://127.0.0.1:37119/mcp
```

### Claude Desktop

Claude Desktop connects to local servers through a small bridge, which needs
[Node.js](https://nodejs.org) (the LTS version is fine).

1. Install Node.js if you don't have it.
2. In Claude Desktop, open **Settings → Developer → Edit Config**. This opens
   `claude_desktop_config.json`:
   - **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
   - **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
3. Add a `zotero` entry under `mcpServers`. If the file is empty, paste this whole block:

   ```json
   {
     "mcpServers": {
       "zotero": {
         "command": "npx",
         "args": ["-y", "mcp-remote", "http://127.0.0.1:37119/mcp"]
       }
     }
   }
   ```

4. Save the file and restart Claude Desktop.

### Other clients (Cursor, VS Code, and others)

Most clients accept an HTTP server entry like this:

```json
{ "mcpServers": { "zotero": { "type": "http", "url": "http://127.0.0.1:37119/mcp" } } }
```

Clients that only support stdio can use the same `npx -y mcp-remote http://127.0.0.1:37119/mcp`
bridge as Claude Desktop.

Use `127.0.0.1` rather than `localhost`. The server listens on IPv4 only, and on macOS and Linux
`localhost` often goes to the IPv6 address first.

## Troubleshooting

**The health page doesn't load**

- Make sure Zotero is open and **HC Zotero MCP** is enabled in **Tools → Plugins**.
- Make sure "Zotero MCP Lite" isn't also installed.
- Another program may be using port 37119. To check, open **Tools → Developer → Error Console** in
  Zotero and look for a line starting with `[HC Zotero MCP] Could not listen`. To fix it,
  [change the port](#configuration).
- **Windows only:** Hyper-V, WSL, and Docker sometimes reserve blocks of ports. To see the reserved
  ranges, run this in PowerShell:

  ```powershell
  netsh int ipv4 show excludedportrange protocol=tcp
  ```

  If 37119 falls inside one of the listed ranges, [change the port](#configuration).

**The assistant finds items but can't open the PDFs (macOS)**

macOS may block apps from reading the Documents, Desktop, or Downloads folders. If your Zotero data
or linked files are stored there, open **System Settings → Privacy & Security → Files and Folders**
(or **Full Disk Access**) and allow your AI app.

**Zotero says the plugin isn't compatible**

This plugin supports Zotero 7 through 12. Check your version and update Zotero if needed.

## Tools

All results are compact JSON.

| Tool | Purpose |
|---|---|
| `search_items` | Ranked topic search, plus browse/filter when you leave out `query` |
| `get_items` | Full metadata, creators, tags, collections, related items, child notes as plain text, and attachments with file paths. Takes up to 50 keys per call |
| `get_attachments` | Absolute `path`, `exists`, size, content type, `fulltextCachePath` |
| `get_annotations` | Reader highlights, notes, and images, in page order, with comments and tags |
| `list_collections` | Flat list of collections with full paths, keys, and counts |
| `list_tags` | Tags by frequency. Useful for learning the library's vocabulary before a search |
| `library_info` | Libraries, counts, data and storage directories |

The server returns file locations, and the AI client reads the files itself. Every indexed
attachment also has Zotero's own plain-text extract (`fulltextCachePath`), so no PDF parsing is
needed.

### Search

`search_items` looks in titles, abstracts, creators, tags, publication, other fields, notes, PDF
annotations, and Zotero's full-text index:

- **Folding:** matching ignores case and accents, using Zotero's own normalization. `gasevic` finds *Gašević*.
- **Stemming and prefix matching:** `experimental` also finds *experiment* and *experiments*, and `teaching` finds *teach* and *teacher*. A mid-word hit counts for less. Set `stem: false` to turn stemming off.
- **Concepts:** pass `concepts`, a list of concepts where each concept is a list of synonyms, for example `[["experiment","randomized","RCT"],["AI","ChatGPT","LLM"],["teaching","students","classroom"]]`. The tool description tells the model to expand topical questions this way.
- **`query` syntax:** an alternative to `concepts`.
  - Each space-separated term is a concept.
  - Use `"exact phrase"` for phrases.
  - Use `a|b|"c d"` or `a OR b` to give synonyms for one concept.
  - Use `-term` to exclude.
  - Common stopwords are dropped.
- **Best-match ranking (default `mode: "best"`):** items matching every concept come first. They're followed by items matching at least half of the concepts, each flagged with `coverage` (for example `"2/3"`). The response reports `fullMatches`. Use `mode: "all"` for strict AND or `mode: "any"` for OR. Within that, fields are weighted (title > tags > creators > abstract > notes/annotations > publication > full text > other). Several synonyms of one concept hitting the same item add a little extra weight. Each result's `matched` shows which fields each term hit.
- **Screening for recall:** browse a filtered set (for example one year or one collection) with `includeAbstract: true`. Each item comes with its abstract or, if it has none, an `excerpt` from Zotero's extracted full text. The model can then judge relevance itself, which finds items that never use the query's words.
- **Filters:** `collection` (key or name, subcollections included), `tags`, `itemTypes`, `excludeItemTypes`, `yearFrom`/`yearTo`, `addedAfter`, `libraryID`, `includeTrashed`. You can also restrict `fields` (for example `["title","abstract","tags"]`) or set `fulltext: false` for metadata-only matching.
- **Sorting:** `relevance`, `dateAdded`, `dateModified`, `year`, `yearAsc`, or `title`, with `limit`/`offset` paging.

## Safety

- **SELECT only.** Every statement is hard-coded and passed through a guard that rejects anything that isn't a single `SELECT`. The guard checks for write keywords, `PRAGMA`, `ATTACH`, and statement separators. User input only ever reaches SQL as bound parameters. The only values inlined into SQL are integer IDs that have been validated.
- **No new connections.** Queries run on Zotero's own connection (`Zotero.DB`) and never inside a transaction. Zotero opens `zotero.sqlite` with an exclusive lock, so this plugin can't add lock contention or open a competing connection.
- **No file writes.** The plugin never writes files. It only checks whether attachment files exist and how big they are.
- **Loopback only.** The socket binds to `127.0.0.1`, so other computers can't reach it. Requests with a non-loopback `Host` header or a foreign `Origin` header are rejected, which protects against DNS rebinding.
- **Optional bearer token.** See [Configuration](#configuration).

## Configuration

Open the Config Editor, change a setting, then restart Zotero:

- **Windows / Linux:** **Edit → Settings → Advanced → Config Editor**
- **macOS:** **Zotero → Settings → Advanced → Config Editor**

Search for `hc-zotero-mcp` to find these settings:

| Pref | Default | Purpose |
|---|---|---|
| `extensions.hc-zotero-mcp.port` | `37119` | Port the server listens on. If you change it, update the URL in your AI client too |
| `extensions.hc-zotero-mcp.token` | empty | If set, clients must send `Authorization: Bearer <token>` |

The default port, 37119, doesn't collide with Zotero (23119), Better BibTeX, or other Zotero MCP
plugins (23120), and it's outside the Windows ephemeral port range (49152–65535).

## Compatibility

Developed and tested against Zotero 10's schema, which uses an FTS5 full-text index in
`fulltext.sqlite` and normalized search columns. On Zotero 7–9 it falls back automatically to the
legacy word index, and those versions have no normalized columns. Zotero 7 through 12 are allowed.

## Development

Requires Node.js 22.5 or newer.

```bash
node scripts/build.cjs
```

Builds `dist/hc-zotero-mcp-<version>.xpi` and `dist/hc-zotero-mcp-<version>.zip` (the release
download).

```bash
node test/run-node.cjs <dir-with-copy-of-zotero.sqlite-and-fulltext.sqlite> [zoteroDataDir]
```

Runs every tool against a *copy* of a database (opened read-only via `node:sqlite`).
`node test/eval-recall.cjs <same dir>` runs a recall benchmark for one conceptual query.

```bash
node test/smoke-live.cjs
```

Runs an end-to-end test against the plugin running in Zotero.

Layout: `plugin/content/tools.js` contains the tool logic and has no I/O of its own. `mcp.js` handles
JSON-RPC and the MCP protocol. `zenv.js` adapts the Zotero API. `http.js` is the async socket server.
