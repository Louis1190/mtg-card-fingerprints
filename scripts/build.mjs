// One run of the fingerprint data job: Scryfall's "Unique Artwork" bulk file -> the pictures that are new -> described with the
// PLUGIN'S OWN code -> a base in the format the plugin reads, ready to publish on a static site. Nothing is published by this script.
//   node build.mjs --out <dir> [--state <dir> | --state-url <https address>] [--bootstrap] [--bulk <unique_artwork.jsonl.gz>] [--cache <picture dir>]
//                  [--no-fetch] [--limit-new <n>] [--selftest-rows 200] [--rows-per-shard 6400]
// --bootstrap builds from nothing (the only way to start without a state); otherwise the previous base is read and ONLY the illustrations it lacks are added, in the bulk file's order, after the
// rows it has (rows are never removed or changed: a device that holds a shard keeps its meaning). --bulk uses a file already on disk (a rehearsal); without it ONE call to /bulk-data and one
// download. --cache is the picture folder (kept between runs by the workflow, so a rebuild fetches only what it lacks); --no-fetch refuses to fetch (a rehearsal on cached pictures).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadBulk, fetchBulkItem, listPictures } from "./lib/bulk.mjs";
import { fetchPictures, pictureFile } from "./lib/pictures.mjs";
import { runGates } from "./lib/gates.mjs";
import { FIXED_M, ROWS_PER_SHARD, buildShards, indexOf, rowOf } from "./lib/rows.mjs";
import { readState } from "./lib/state.mjs";
import { CARD_H, CARD_W, describeCard } from "./lib/plugin.bundle.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);

const out = resolve(opt("--out", ""));
if (!opt("--out")) throw new Error("usage: build.mjs --out <dir> [--state <dir> | --state-url <url>] [--bootstrap] ...");
const perShard = Number(opt("--rows-per-shard", ROWS_PER_SHARD));
const bootstrap = flag("--bootstrap");
const work = mkdtempSync(join(tmpdir(), "fpjob-"));
const cache = resolve(opt("--cache", join(work, "pictures")));
const log = (...a) => console.log(...a);
const PIC_BYTES = CARD_W * CARD_H * 3;

/** Decodes pictures (python, Pillow) in blocks of 2000 and describes them with the plugin's code; returns a Map illustration -> descriptors, and the illustrations that could not be read. */
function describePictures(list) {
	const described = new Map();
	const unreadable = [];
	for (let i = 0; i < list.length; i += 2000) {
		const block = list.slice(i, i + 2000);
		const listFile = join(work, "list.txt");
		const rawFile = join(work, "block.bin");
		writeFileSync(listFile, block.map((p) => pictureFile(cache, p.illustration)).join("\n"));
		execFileSync(process.env.FP_PYTHON ?? "python3", ["-I", join(here, "lib/decode.py"), listFile, rawFile], { stdio: ["ignore", "pipe", "inherit"] });
		const raw = readFileSync(rawFile);
		const ok = readFileSync(rawFile + ".ok");
		block.forEach((p, k) => {
			if (!ok[k]) unreadable.push(p.illustration);
			else described.set(p.illustration, describeCard(new Uint8Array(raw.buffer, raw.byteOffset + k * PIC_BYTES, PIC_BYTES)));
		});
	}
	return { described, unreadable };
}

try {
	// 1) the bulk file
	let bulkFile = opt("--bulk");
	let bulkInfo = { name: "file given", updated_at: "" };
	if (!bulkFile) {
		bulkInfo = await fetchBulkItem();
		bulkFile = join(work, "unique_artwork.jsonl.gz");
		log(`bulk file: ${bulkInfo.name}, ${bulkInfo.updated_at}, ${(bulkInfo.size / 1e6).toFixed(1)} MB`);
		await downloadBulk(bulkInfo.uri, bulkFile);
	}
	const { pictures, stats } = await listPictures(bulkFile);
	log(`bulk cards ${stats.cards}: not paper ${stats.notPaper}, excluded layout ${stats.excludedLayout}, no picture ${stats.noPicture}, bad picture ${stats.badPicture}, no illustration ${stats.noIllustration}, repeated ${stats.repeated} -> ${pictures.length} illustrations`);

	// 2) the previous build
	let state = null;
	if (!bootstrap) {
		state = await readState({ dir: opt("--state"), url: opt("--state-url") });
		if (!state) throw new Error("no previous base to continue from (pass --bootstrap to start one)");
		log(`previous base: ${state.index.n} rows, ${state.index.shards.length} shards, ${state.index.date}`);
	} else if (opt("--state") || opt("--state-url")) throw new Error("--bootstrap and a state do not go together");
	const m = state ? state.index.m : FIXED_M;
	const known = new Set((state?.rows ?? []).map((r) => r.id));
	const stillThere = new Set(pictures.map((p) => p.illustration));
	const gone = (state?.rows ?? []).filter((r) => !stillThere.has(r.id)).length;
	let todo = pictures.filter((p) => !known.has(p.illustration));
	if (opt("--limit-new")) todo = todo.slice(0, Number(opt("--limit-new")));
	log(`new illustrations: ${todo.length}${gone ? `; ${gone} rows of the base are no longer in the bulk file (kept)` : ""}`);

	// 3) their pictures, then the descriptors
	let failedPictures = 0;
	let newRows = [];
	if (todo.length) {
		if (flag("--no-fetch")) {
			const missing = todo.filter((p) => !existsSync(pictureFile(cache, p.illustration)));
			if (missing.length) throw new Error(`--no-fetch, but ${missing.length} pictures are not in the cache`);
		}
		const got = flag("--no-fetch") ? { fetched: 0, cached: todo.length, failed: [] } : await fetchPictures(todo, cache, { log });
		log(`pictures: ${got.fetched} fetched, ${got.cached} from the cache, ${got.failed.length} failed`);
		const usable = todo.filter((p) => !got.failed.includes(p.illustration));
		const { described, unreadable } = describePictures(usable);
		failedPictures = got.failed.length + unreadable.length;
		newRows = usable.filter((p) => described.has(p.illustration)).map((p) => rowOf(p.illustration, described.get(p.illustration), m));
		log(`described ${newRows.length} pictures, ${failedPictures} left out`);
	}

	// 4) the shards: the previous rows first, the new ones after them
	const rows = [...(state?.rows ?? []), ...newRows];
	const shards = buildShards(rows, perShard, state?.previous ?? []);
	mkdirSync(out, { recursive: true });
	const date = new Date().toISOString().slice(0, 10);
	const index = indexOf(shards, m, date);
	for (const s of shards) writeFileSync(join(out, s.file), s.gz);
	writeFileSync(join(out, "index.json"), JSON.stringify(index));
	log(`wrote ${shards.length} shards (${shards.filter((s) => s.reused).length} kept as they were), n ${index.n}`);

	// 5) the gates, on what was written; then the self-test of the rows against the pictures
	const gates = runGates({ dir: out, previousIndex: state?.index, failedPictures, newRows: newRows.length });
	log(`gates passed: ${gates.rowsSeen} rows, ids unique, hashes match, ${gates.flat} flat vectors`);
	const sample = Number(opt("--selftest-rows", 200));
	if (sample > 0) {
		const { selfTest } = await import("./lib/selftest-rows.mjs");
		const res = await selfTest({ out, cache, pictures, sample, describePictures, m, fetchPictures, log });
		log(`self-test: ${res.same} of ${res.checked} sampled rows are exactly what their picture gives (${res.refetched} pictures fetched again), ${res.different} differ`);
		if (res.checked >= 20 && res.different / res.checked > 0.02) throw new Error(`self-test: ${res.different} of ${res.checked} sampled rows differ from their picture`);
	}
	// `changed` is what the workflow publishes on: something was added, or a shard's content is not what the previous base held
	const changed = !state || newRows.length > 0 || shards.some((s) => !s.reused) || index.n !== state.index.n;
	writeFileSync(join(out, "build-info.json"), JSON.stringify({ built: new Date().toISOString(), bulk: bulkInfo.updated_at, n: index.n, added: newRows.length, bootstrap, changed }));
	log(changed ? "the base changed: it can be published" : "nothing new: nothing to publish");
	log("done");
} finally {
	rmSync(work, { recursive: true, force: true });
}
