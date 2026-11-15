// The "small" pictures (146 x 204 JPEG) from Scryfall's image CDN into a cache folder, 8 at a time, resumable (a picture already there is not fetched again). The CDN has no rate limit, but a 429 is
// still obeyed (a pause of 35 s). A picture that cannot be had is counted and left out, never replaced by zeros.
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { USER_AGENT } from "./bulk.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

export const pictureFile = (cacheDir, illustration) => join(cacheDir, illustration + ".jpg");

/** Fetches every picture of `todo` ([{illustration, uri}]) that is not in `cacheDir`; returns { fetched, cached, failed: [illustration] }. */
export async function fetchPictures(todo, cacheDir, { fetchImpl = fetch, concurrency = 8, log = console.log } = {}) {
	mkdirSync(cacheDir, { recursive: true });
	let next = 0;
	const out = { fetched: 0, cached: 0, failed: [], bytes: 0 };
	async function worker() {
		while (next < todo.length) {
			const p = todo[next++];
			const file = pictureFile(cacheDir, p.illustration);
			if (existsSync(file)) {
				out.cached++;
				continue;
			}
			let ok = false;
			for (let attempt = 0; attempt < 3 && !ok; attempt++) {
				try {
					const res = await fetchImpl(p.uri, { headers: { "User-Agent": USER_AGENT } });
					if (res.status === 429) {
						log("429 on a picture: pause 35 s");
						await sleep(35_000);
						continue;
					}
					if (!res.ok) throw new Error(String(res.status));
					const buf = Buffer.from(await res.arrayBuffer());
					if (buf.length < 500 || !JPEG_MAGIC.every((b, i) => buf[i] === b)) throw new Error("not a JPEG");
					writeFileSync(file + ".part", buf);
					renameSync(file + ".part", file);
					out.fetched++;
					out.bytes += buf.length;
					ok = true;
				} catch {
					if (attempt < 2) await sleep(1000);
				}
			}
			if (!ok) out.failed.push(p.illustration);
			if ((out.fetched + out.cached + out.failed.length) % 5000 === 0) log(`pictures ${out.fetched + out.cached + out.failed.length} / ${todo.length}`);
		}
	}
	await Promise.all(Array.from({ length: concurrency }, worker));
	return out;
}
