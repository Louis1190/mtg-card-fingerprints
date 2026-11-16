// The safety gates of the job, run on the files it is about to publish, READ BACK from disk (not on what is in memory): a build that fails one is not published and the job fails loudly.
// Refuse rather than publish something doubtful.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DESCRIPTORS, DESCRIPTOR_DIMS, indexMoved, parseIndex } from "./plugin.bundle.mjs";
import { gunzip, rowsOfRaw, sha256 } from "./rows.mjs";

export const MIN_ROWS = 45_000; // the first base had 50 541 once the repeated illustrations were left out
export const MAX_FAILED_PICTURES_SHARE = 0.01;
/** The mean 4-bit value of each descriptor over the whole base, as measured on the first base (10.120 / 7.499 / 7.496: HOG values are never negative, the two others are standardised), with room. */
export const MEAN_NIBBLE_BAND = { hog: [9.5, 10.7], tinylum: [7.0, 8.0], dct: [7.0, 8.0] };

/** Throws an Error naming the first gate that fails; returns what it read. `minRows` and `bands` are overridable for the tests only. */
export function runGates({ dir, previousIndex, failedPictures = 0, newRows = 0, minRows = MIN_ROWS, bands = MEAN_NIBBLE_BAND }) {
	const rawIndex = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
	const index = parseIndex(rawIndex);
	if (!index) throw new Error("gate: index.json is not an index the plugin reads");
	// a `moved` address is where devices send their requests: it must be one the plugin follows, written the way the plugin reads it (or devices would ignore it, or follow another thing than was meant)
	if (rawIndex.moved !== undefined && indexMoved(rawIndex) !== rawIndex.moved) throw new Error("gate: the index's moved address is not one the plugin follows");
	if (index.n < minRows) throw new Error(`gate: only ${index.n} rows (the floor is ${minRows})`);
	if (previousIndex && index.n < previousIndex.n) throw new Error(`gate: the base shrank, ${previousIndex.n} -> ${index.n} (rows are only ever added)`);
	if (previousIndex && JSON.stringify(index.m) !== JSON.stringify(previousIndex.m)) throw new Error("gate: the quantisation ranges changed (they are fixed for ever)");
	const attempted = newRows + failedPictures;
	if (attempted > 0 && failedPictures / attempted > MAX_FAILED_PICTURES_SHARE) throw new Error(`gate: ${failedPictures} of ${attempted} new pictures could not be had`);
	const ids = new Set();
	const sums = Object.fromEntries(DESCRIPTORS.map((n) => [n, 0]));
	let flat = 0;
	let rowsSeen = 0;
	for (const info of index.shards) {
		const gz = readFileSync(join(dir, info.file));
		if (sha256(gz) !== info.sha256) throw new Error(`gate: ${info.file} does not match its hash`);
		const rows = rowsOfRaw(gunzip(gz), info.rows); // throws when the length is not what the rows take
		for (const r of rows) {
			if (ids.has(r.id)) throw new Error(`gate: the id ${r.id} is in the base twice`);
			ids.add(r.id);
			for (const n of DESCRIPTORS) {
				for (let d = 0; d < DESCRIPTOR_DIMS[n]; d++) sums[n] += r.q[n][d];
				// a card whose three vectors are one repeated value is a picture that did not decode
				if (r.q[n].every((v) => v === r.q[n][0])) flat++;
			}
			rowsSeen++;
		}
	}
	if (rowsSeen !== index.n) throw new Error("gate: the shards hold a different number of rows than the index says");
	for (const n of DESCRIPTORS) {
		const mean = sums[n] / (rowsSeen * DESCRIPTOR_DIMS[n]);
		const [lo, hi] = bands[n];
		if (mean < lo || mean > hi) throw new Error(`gate: the ${n} values are not spread as expected (mean nibble ${mean.toFixed(3)}, expected ${lo} to ${hi})`);
	}
	if (flat > rowsSeen * 0.001) throw new Error(`gate: ${flat} flat vectors (pictures that did not decode?)`);
	return { index, rowsSeen, flat };
}
