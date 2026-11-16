// The previous build, read back: from a folder (a rehearsal, or the checkout of the site) or from the live site's address. Every shard is checked against the index's hash before it is trusted;
// anything that does not fit THROWS (a job that cannot read its own state stops, it never starts a base again from nothing by accident: only --bootstrap does that).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { USER_AGENT } from "./bulk.mjs";
import { gunzip, rowsOfRaw, sha256 } from "./rows.mjs";
import { indexMoved, parseIndex } from "./plugin.bundle.mjs";

async function bytesFromUrl(url, fetchImpl, pauseMs = 5000) {
	let last;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT, "Cache-Control": "no-cache" } });
			if (!res.ok) throw new Error(`${url} answered ${res.status}`);
			return Buffer.from(await res.arrayBuffer());
		} catch (e) {
			last = e;
			await new Promise((r) => setTimeout(r, pauseMs * (attempt + 1)));
		}
	}
	throw last; // the job stops: it never starts the base again from nothing on its own
}

/** { index, rows, previous, moved } (moved: the address the previous index pointed to, or null) where previous = [{ file, raw, gz }] by shard position (what `buildShards` may reuse), or null when `source` has no index at all (a folder without index.json). */
export async function readState({ dir, url, fetchImpl = fetch, pauseMs = 5000 }) {
	let get;
	if (dir) {
		if (!existsSync(join(dir, "index.json"))) return null;
		get = async (name) => readFileSync(join(dir, name));
	} else if (url) {
		const base = url.replace(/\/+$/, "");
		if (!/^https:\/\//.test(base)) throw new Error("the state address must be https");
		get = (name) => bytesFromUrl(`${base}/${name}`, fetchImpl, pauseMs);
	} else throw new Error("readState needs a dir or a url");
	const rawIndex = JSON.parse((await get("index.json")).toString("utf8"));
	const index = parseIndex(rawIndex);
	if (!index) throw new Error("the previous index is not one this job reads");
	const rows = [];
	const previous = [];
	for (const info of index.shards) {
		const gz = await get(info.file);
		if (sha256(gz) !== info.sha256) throw new Error(`the previous ${info.file} does not match its hash`);
		const raw = gunzip(gz);
		rows.push(...rowsOfRaw(raw, info.rows));
		previous.push({ file: info.file, raw, gz });
	}
	if (rows.length !== index.n) throw new Error("the previous index counts the wrong number of rows");
	return { index, rows, previous, moved: indexMoved(rawIndex) };
}
