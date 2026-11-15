// Recall check for a conceptual query: "2026 articles with experimental evidence of good
// practices for teaching with AI". The relevant set was judged by hand from the 45 items dated
// 2026 in the test library (title + abstract). Run against a DB copy:
//   node test/eval-recall.cjs <dbCopyDir> [dataDir]
const path = require("node:path");
const { createEnv } = require("./node-env.cjs");
globalThis.ZMCPTools = require("../plugin/content/tools.js");

const RELEVANT = {
	"6EUTX3YS": "Presumed Effective (audit of AI-in-education meta-analyses)",
	"H5BUHFA8": "39 meta-analyses, 39 positive findings",
	"JE77JSML": "GenAI and educational outcomes: meta-analysis",
	"BXCDK3FR": "Faster Completion, Less Learning",
	"VGAPFLPP": "Same Feedback, Different Source (AI vs human feedback)",
	"76UVXXP2": "AI makes you smarter but none the wiser",
	"FJD5YRCA": "Thinking—Fast, Slow, and Artificial",
	"5YSS24LK": "Sycophantic AI promotes dependence",
	"V2Z7IQBK": "Collaborating with AI Agents: field experiments",
	"J5HTDNCP": "GenAI use and misuse call for assessment reform",
	"4ICRFFT9": "More Students Use AI for Homework (RAND panel)",
	"M442YNXP": "Largest study of AI use by undergrads",
	"FKP6PD49": "The Impact of AI on Learning Assessment",
	"4JBGQZB9": "Student GenAI Survey 2026",
	"4JMD4I25": "Student Voices on AI: guide for faculty",
	"AUZCVUGE": "GAITL committee recommendations"
};

(async () => {
	const dbDir = process.argv[2];
	const env = createEnv({
		dbPath: path.join(dbDir, "zotero.sqlite"),
		fulltextPath: path.join(dbDir, "fulltext.sqlite"),
		dataDir: process.argv[3] || dbDir
	});
	const t = ZMCPTools.create(env);
	const relevant = new Set(Object.keys(RELEVANT));
	const run = async (label, args, k) => {
		const r = await t.call("search_items", { yearFrom: 2026, yearTo: 2026, limit: k, ...args });
		const keys = r.items.map(i => i.key);
		const hits = keys.filter(x => relevant.has(x));
		console.log(`\n${label}\n  top-${k}: ${hits.length}/${relevant.size} relevant  (total ${r.total}, full matches ${r.fullMatches ?? "-"}, ${r.ms} ms, ${JSON.stringify(r).length} chars)`);
		for (const i of r.items) console.log(`   ${relevant.has(i.key) ? "✓" : " "} ${String(i.score ?? "").padStart(5)} ${i.coverage || "   "} ${i.title.slice(0, 80)}`);
		return { hits: hits.length, r };
	};
	await run("A. Literal words (what a naive model sends)", { query: "experimental evidence good practices teaching AI" }, 25);
	await run("B. Model-expanded concepts (as the tool description instructs)", {
		concepts: [
			["experiment", "randomized", "RCT", "quasi-experimental", "field study", "causal", "effect", "evidence", "meta-analysis", "study", "survey"],
			["AI", "generative AI", "ChatGPT", "LLM", "chatbot", "GenAI", "artificial intelligence"],
			["teaching", "learning", "students", "classroom", "course", "education", "instruction", "feedback", "tutor", "assessment"]
		]
	}, 25);
	const screen = await run("C. Screening: year filter, browse with abstracts/excerpts (model judges)", { includeAbstract: true, abstractChars: 300 }, 200);
	const withText = screen.r.items.filter(i => i.abstract || i.excerpt).length;
	console.log(`\n  screening payload: ${screen.r.items.length} items, ${withText} with abstract/excerpt, ~${Math.round(JSON.stringify(screen.r).length / 4)} tokens`);
})();
