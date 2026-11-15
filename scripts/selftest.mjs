// Tests of the fingerprint data job's own code, with synthetic data (no network, no picture): node tools/fingerprint-data/selftest.mjs
// Every gate is shown able to FAIL (a base broken on purpose must be refused), and the formats are checked against the plugin's own reader.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { listPictures } from "./lib/bulk.mjs";
import { runGates } from "./lib/gates.mjs";
import { FIXED_M, buildShards, indexOf, packShardRaw, quantize, rowOf, rowsOfRaw } from "./lib/rows.mjs";
import { readState } from "./lib/state.mjs";
import { DESCRIPTORS, DESCRIPTOR_DIMS, parseIndex } from "./lib/plugin.bundle.mjs";

let passed = 0;
const failures = [];
async function test(name, fn) {
	try {
		await fn();
		passed++;
		console.log("ok   ", name);
	} catch (e) {
		failures.push(name);
		console.log("FAIL ", name, "\n     ", String(e?.stack ?? e).split("\n").slice(0, 3).join("\n      "));
	}
}
const throwsWith = async (fn, re) => { let err; try { await fn(); } catch (e) { err = e; } assert.ok(err, "should have been refused"); assert.match(String(err.message), re); };

let seed = 12345;
const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
const uuid = (i) => { const h = (i + 1).toString(16).padStart(12, "0"); return `00000000-0000-4000-8000-${h}`; };
const randomRow = (i) => { const d = {}; for (const n of DESCRIPTORS) { d[n] = new Float32Array(DESCRIPTOR_DIMS[n]); for (let k = 0; k < d[n].length; k++) d[n][k] = (rnd() - 0.5) * 2 * FIXED_M[n] * 0.6; } return rowOf(uuid(i), d, FIXED_M); };
const rows = Array.from({ length: 50 }, (_, i) => randomRow(i));
const small = { minRows: 10, bands: { hog: [0, 15], tinylum: [0, 15], dct: [0, 15] } };
function writeBase(dir, rowList, perShard = 20, m = FIXED_M, previous = []) {
	mkdirSync(dir, { recursive: true });
	const shards = buildShards(rowList, perShard, previous);
	for (const s of shards) writeFileSync(join(dir, s.file), s.gz);
	writeFileSync(join(dir, "index.json"), JSON.stringify(indexOf(shards, m, "2026-11-11")));
	return shards;
}
const tmp = mkdtempSync(join(tmpdir(), "fpselftest-"));
let n = 0;
const fresh = () => join(tmp, "b" + n++);

await test("quantisation: clipped to 0..15, symmetric about the middle", () => {
	assert.equal(quantize(-10, 1), 0);
	assert.equal(quantize(10, 1), 15);
	assert.equal(quantize(0, 1), 8); // 7.5 rounds up
	assert.equal(quantize(1, 1), 15);
	assert.equal(quantize(-1, 1), 0);
});
await test("a shard packed here is read back by the PLUGIN's reader, nibble for nibble (low nibble first)", () => {
	const raw = packShardRaw(rows.slice(0, 7)); // 7 rows: an odd number of nibbles, so the padding is exercised
	const back = rowsOfRaw(raw, 7);
	back.forEach((r, i) => { assert.equal(r.id, rows[i].id); for (const d of DESCRIPTORS) assert.deepEqual([...r.q[d]], [...rows[i].q[d]]); });
});
await test("an index written here is accepted by the plugin's parser, and refused when it is not what the plugin reads", () => {
	const dir = fresh();
	writeBase(dir, rows);
	const idx = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
	assert.ok(parseIndex(idx));
	assert.equal(parseIndex({ ...idx, n: idx.n + 1 }), null);
	assert.equal(parseIndex({ ...idx, shards: [{ ...idx.shards[0], file: "../x" }] }), null);
});
await test("a shard whose content did not change keeps the previous file BYTES; one that changed does not", () => {
	const first = buildShards(rows, 20);
	const prev = first.map((s) => ({ file: s.file, raw: s.raw, gz: Buffer.from(gzipSync(s.raw, { level: 1 })) })); // a different compressor: same content, other bytes
	const again = buildShards(rows, 20, prev);
	again.forEach((s, i) => { assert.ok(s.reused); assert.ok(s.gz === prev[i].gz); });
	const changed = buildShards([...rows.slice(0, 49), randomRow(999)], 20, prev);
	assert.ok(changed[0].reused && changed[1].reused && !changed[2].reused);
});
await test("gates: a sound base passes", () => {
	const dir = fresh();
	writeBase(dir, rows);
	assert.equal(runGates({ dir, ...small }).rowsSeen, 50);
});
await test("gate: a flipped byte in a shard is refused (hash)", async () => {
	const dir = fresh();
	writeBase(dir, rows);
	const gz = readFileSync(join(dir, "s1.bin.gz"));
	gz[gz.length >> 1] ^= 0xff;
	writeFileSync(join(dir, "s1.bin.gz"), gz);
	await throwsWith(() => runGates({ dir, ...small }), /hash/);
});
await test("gate: an id twice is refused", async () => {
	const dir = fresh();
	writeBase(dir, [...rows.slice(0, 30), { ...rows[3] }, ...rows.slice(31)]);
	await throwsWith(() => runGates({ dir, ...small }), /twice/);
});
await test("gate: a base that shrank is refused", async () => {
	const dir = fresh();
	writeBase(dir, rows.slice(0, 40));
	const previousIndex = parseIndex(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")));
	const dir2 = fresh();
	writeBase(dir2, rows.slice(0, 35));
	await throwsWith(() => runGates({ dir: dir2, previousIndex, ...small }), /shrank/);
});
await test("gate: changed quantisation ranges are refused", async () => {
	const dir = fresh();
	writeBase(dir, rows);
	const previousIndex = { ...parseIndex(JSON.parse(readFileSync(join(dir, "index.json"), "utf8"))) };
	previousIndex.m = { ...previousIndex.m, hog: previousIndex.m.hog * 2 };
	await throwsWith(() => runGates({ dir, previousIndex, ...small }), /ranges changed/);
});
await test("gate: too many pictures that could not be had is refused", async () => {
	const dir = fresh();
	writeBase(dir, rows);
	await throwsWith(() => runGates({ dir, failedPictures: 5, newRows: 50, ...small }), /could not be had/);
	runGates({ dir, failedPictures: 0, newRows: 50, ...small });
});
await test("gate: fewer rows than the floor is refused", async () => {
	const dir = fresh();
	writeBase(dir, rows.slice(0, 8));
	await throwsWith(() => runGates({ dir, minRows: 10, bands: small.bands }), /floor/);
});
await test("gate: an index that counts another number of rows than its shards is refused", async () => {
	const dir = fresh();
	writeBase(dir, rows);
	const idx = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
	idx.n += 1;
	writeFileSync(join(dir, "index.json"), JSON.stringify(idx));
	await throwsWith(() => runGates({ dir, ...small }), /not an index/);
});
await test("gate: values that are not spread like the first base's are refused (a decoder that went wrong)", async () => {
	const dir = fresh();
	const grey = rows.map((r, i) => ({ id: r.id, q: Object.fromEntries(DESCRIPTORS.map((d) => [d, r.q[d].map(() => 15)])) }));
	writeBase(dir, grey);
	await throwsWith(() => runGates({ dir, minRows: 10, bands: { hog: [9.5, 10.7], tinylum: [7, 8], dct: [7, 8] } }), /not spread|flat/);
});
await test("gate: pictures that did not decode (flat vectors) are refused", async () => {
	const dir = fresh();
	const flat = rows.map((r, i) => (i < 5 ? { id: r.id, q: Object.fromEntries(DESCRIPTORS.map((d) => [d, r.q[d].map(() => 8)])) } : r));
	writeBase(dir, flat);
	await throwsWith(() => runGates({ dir, ...small }), /flat/);
});
await test("state: a previous base is read back; a missing index is null; a tampered shard stops the job", async () => {
	const dir = fresh();
	writeBase(dir, rows);
	const st = await readState({ dir });
	assert.equal(st.rows.length, 50);
	assert.equal(st.previous.length, 3);
	assert.equal(await readState({ dir: join(tmp, "nothing-here") }), null);
	const gz = readFileSync(join(dir, "s0.bin.gz"));
	gz[10] ^= 1;
	writeFileSync(join(dir, "s0.bin.gz"), gz);
	await throwsWith(() => readState({ dir }), /does not match its hash/);
});
await test("state from the site: a download that fails once is tried again; one that keeps failing STOPS the job; an http address is refused", async () => {
	const dir = fresh();
	writeBase(dir, rows);
	const calls = {};
	const site = (failFirst, failAlways) => async (url) => {
		const name = url.split("/").pop();
		calls[name] = (calls[name] ?? 0) + 1;
		if (failAlways && name === "s1.bin.gz") return { ok: false, status: 503 };
		if (failFirst && name === "s1.bin.gz" && calls[name] === 1) return { ok: false, status: 502 };
		return { ok: true, arrayBuffer: async () => { const b = readFileSync(join(dir, name)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); } };
	};
	const st = await readState({ url: "https://example.test/fp/", fetchImpl: site(true, false), pauseMs: 1 });
	assert.equal(st.rows.length, 50);
	assert.equal(calls["s1.bin.gz"], 2);
	await throwsWith(() => readState({ url: "https://example.test/fp", fetchImpl: site(false, true), pauseMs: 1 }), /503/);
	await throwsWith(() => readState({ url: "http://example.test/fp", fetchImpl: site(false, false), pauseMs: 1 }), /https/);
});
await test("bulk list: paper only, standard layouts and tokens, one picture per face, repeats and bad entries left out", async () => {
	const pic = (p) => `https://cards.scryfall.io/small/front/a/b/${p}.jpg?1700000000`;
	const cards = [
		{ id: "c1", layout: "normal", games: ["paper", "mtgo"], illustration_id: uuid(1), image_uris: { small: pic("one") } },
		{ id: "c2", layout: "normal", games: ["mtgo"], illustration_id: uuid(2), image_uris: { small: pic("two") } }, // not paper
		{ id: "c3", layout: "emblem", games: ["paper"], illustration_id: uuid(3), image_uris: { small: pic("three") } }, // an emblem: not a card you hold
		{ id: "c9", layout: "token", games: ["paper"], illustration_id: uuid(9), image_uris: { small: pic("nine") } }, // a token: a card you hold, its picture is described
		{ id: "c10", layout: "double_faced_token", games: ["paper"], card_faces: [{ illustration_id: uuid(10), image_uris: { small: pic("ten-a") } }, { illustration_id: uuid(11), image_uris: { small: pic("ten-b") } }] }, // a two-sided token: one picture per face
		{ id: "c4", layout: "transform", games: ["paper"], card_faces: [{ illustration_id: uuid(4), image_uris: { small: pic("four-a") } }, { illustration_id: uuid(5), image_uris: { small: pic("four-b") } }] },
		{ id: "c5", layout: "normal", games: ["paper"], illustration_id: uuid(1), image_uris: { small: pic("again") } }, // the same illustration again
		{ id: "c6", layout: "normal", games: ["paper"], image_uris: { small: pic("six") } }, // no illustration id
		{ id: "c7", layout: "normal", games: ["paper"], illustration_id: uuid(7), image_uris: { small: "http://evil.example/x.jpg" } }, // not the CDN
		{ id: "c8", layout: "normal", games: ["paper"], illustration_id: "not-a-uuid", image_uris: { small: pic("eight") } },
	];
	const file = join(tmp, "bulk.jsonl.gz");
	writeFileSync(file, gzipSync(cards.map((c) => JSON.stringify(c)).join("\n") + "\n"));
	const { pictures, stats } = await listPictures(file);
	assert.deepEqual(pictures.map((p) => p.illustration), [uuid(1), uuid(9), uuid(10), uuid(11), uuid(4), uuid(5)]);
	assert.equal(stats.notPaper, 1);
	assert.equal(stats.excludedLayout, 1);
	assert.equal(stats.repeated, 1);
	assert.equal(stats.badPicture, 1);
	assert.equal(stats.noIllustration, 2);
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
