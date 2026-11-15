// Rows of the base and their files: the 4-bit quantisation with FIXED ranges, the shard format (the plugin's `database.ts` is the reader and the authority: ids, then one 4-bit
// block per descriptor, LOW nibble first, each block padded to a whole byte), and the append-only way a new build is put after the previous one.
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { DESCRIPTORS, DESCRIPTOR_DIMS, shardSize, unpackShard } from "./plugin.bundle.mjs";

export const ID_BYTES = 16;
export const ROWS_PER_SHARD = 6400;
/** The quantisation ranges of the first base (the 99.9th percentile of |value| of the 50 599 pictures of the first spike). NEVER changed: a row written with them keeps its meaning forever. */
export const FIXED_M = { hog: 0.187988, tinylum: 3.553086, dct: 0.869309 };

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const uuidToBytes = (u) => Buffer.from(u.replace(/-/g, ""), "hex");
export function bytesToUuid(b) {
	const h = Buffer.from(b).toString("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function quantize(value, m) {
	return Math.min(15, Math.max(0, Math.round(((value + m) / (2 * m)) * 15)));
}
/** A row = { id: uuid string, q: { hog: Uint8Array(192), tinylum: Uint8Array(280), dct: Uint8Array(111) } } with values 0..15. */
export function rowOf(id, descriptors, m) {
	const q = {};
	for (const name of DESCRIPTORS) {
		const a = new Uint8Array(DESCRIPTOR_DIMS[name]);
		for (let d = 0; d < a.length; d++) a[d] = quantize(descriptors[name][d], m[name]);
		q[name] = a;
	}
	return { id, q };
}

/** The raw (gunzipped) bytes of a shard holding `rows`. */
export function packShardRaw(rows) {
	const parts = [Buffer.concat(rows.map((r) => uuidToBytes(r.id)))];
	for (const name of DESCRIPTORS) {
		const dim = DESCRIPTOR_DIMS[name];
		const packed = Buffer.alloc(Math.ceil((rows.length * dim) / 2));
		let j = 0;
		for (const r of rows) for (let d = 0; d < dim; d++, j++) packed[j >> 1] |= j & 1 ? r.q[name][d] << 4 : r.q[name][d];
		parts.push(packed);
	}
	const raw = Buffer.concat(parts);
	if (raw.length !== shardSize(rows.length)) throw new Error("a packed shard has the wrong size");
	return raw;
}

/** The rows of a gunzipped shard, as the plugin's own reader sees them. */
export function rowsOfRaw(raw, nRows) {
	const part = unpackShard(raw, nRows);
	if (!part) throw new Error("a shard does not unpack");
	const rows = [];
	for (let i = 0; i < nRows; i++) {
		const q = {};
		for (const name of DESCRIPTORS) q[name] = part.values[name].slice(i * DESCRIPTOR_DIMS[name], (i + 1) * DESCRIPTOR_DIMS[name]);
		rows.push({ id: bytesToUuid(part.ids.subarray(i * ID_BYTES, (i + 1) * ID_BYTES)), q });
	}
	return rows;
}

/**
 * The shards of `rows` (in order, `perShard` each). A shard whose decompressed content is what the previous build had keeps the previous FILE BYTES: two zlib builds do not compress the same
 * content to the same bytes, and a new hash would make every device download a shard that did not change. `previous` = [{ file, raw (Buffer), gz (Buffer) }] by shard position, or [].
 */
export function buildShards(rows, perShard, previous = []) {
	const shards = [];
	for (let s = 0; s * perShard < rows.length; s++) {
		const slice = rows.slice(s * perShard, (s + 1) * perShard);
		const raw = packShardRaw(slice);
		const old = previous[s];
		const reuse = old && old.raw.length === raw.length && old.raw.equals(raw);
		const gz = reuse ? old.gz : gzipSync(raw, { level: 9 });
		shards.push({ file: `s${s}.bin.gz`, rows: slice.length, gz, raw, sha256: sha256(gz), reused: !!reuse });
	}
	return shards;
}

export function indexOf(shards, m, date) {
	return { v: 1, date, n: shards.reduce((n, s) => n + s.rows, 0), m, shards: shards.map((s) => ({ file: s.file, rows: s.rows, sha256: s.sha256 })) };
}

export const gunzip = (gz) => gunzipSync(gz);
