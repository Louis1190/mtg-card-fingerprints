// The self-test of a build: `sample` rows drawn at random from the published base are described AGAIN from their pictures (the cache, or fetched again) and must equal what the base holds,
// nibble for nibble. It catches a base whose ids and vectors got out of step (a shuffled row, a shard written from the wrong slice) and a decoder that changed under the job. A picture that
// Scryfall has scanned again since the row was made may differ: the build tolerates 2 % of the sample.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseIndex } from "./plugin.bundle.mjs";
import { gunzip, rowOf, rowsOfRaw } from "./rows.mjs";
import { pictureFile } from "./pictures.mjs";
import { existsSync } from "node:fs";

/** A small deterministic generator, so a failing sample can be drawn again. */
function lcg(seed) {
	let s = seed >>> 0;
	return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

export async function selfTest({ out, cache, pictures, sample, describePictures, m, fetchPictures, log }) {
	const index = parseIndex(JSON.parse(readFileSync(join(out, "index.json"), "utf8")));
	const rows = index.shards.flatMap((s) => rowsOfRaw(gunzip(readFileSync(join(out, s.file))), s.rows));
	const byId = new Map(pictures.map((p) => [p.illustration, p]));
	const rnd = lcg(Number(index.date.replace(/-/g, "")));
	const chosen = [];
	for (let tries = 0; chosen.length < Math.min(sample, rows.length) && tries < sample * 20; tries++) {
		const r = rows[Math.floor(rnd() * rows.length)];
		if (byId.has(r.id) && !chosen.some((c) => c.id === r.id)) chosen.push(r);
	}
	const need = chosen.map((r) => byId.get(r.id)).filter((p) => !existsSync(pictureFile(cache, p.illustration)));
	const got = need.length ? await fetchPictures(need, cache, { log: () => {} }) : { failed: [] };
	const list = chosen.map((r) => byId.get(r.id)).filter((p) => !got.failed.includes(p.illustration));
	const { described } = describePictures(list);
	let same = 0;
	let different = 0;
	for (const r of chosen) {
		const d = described.get(r.id);
		if (!d) continue;
		const again = rowOf(r.id, d, m);
		const equal = ["hog", "tinylum", "dct"].every((n) => again.q[n].every((v, i) => v === r.q[n][i]));
		if (equal) same++;
		else different++;
	}
	return { checked: same + different, same, different, refetched: need.length - got.failed.length };
}
