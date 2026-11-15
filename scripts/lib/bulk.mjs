// Scryfall's "Unique Artwork" bulk file and the list of pictures the base is made of. The way Scryfall's rules ask for it: ONE call to
// /bulk-data, the bulk file (jsonl.gz) for the list, the image CDN (*.scryfall.io, no rate limit) for the pictures. Nothing here talks to the card search endpoints.
import { createReadStream, createWriteStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const USER_AGENT = "ObsidianMTGCollectionTracker-FingerprintData/1.0 (+https://github.com/Louis1190/obsidian-mtg-collection-tracker)";
export const ACCEPT = "application/json;q=0.9,*/*;q=0.8";
/**
 * Layouts that are not a card you collect: no picture of them is described. TOKENS ARE NOT IN THIS LIST (2026-11-11): a token is a physical card people hold and scan, its illustration is unique,
 * and Scryfall's illustration search returns it (checked live: `illustration_id:<id> game:paper` lists the token printings). With the tokens left out the base had nothing to find for a
 * token photo and answered the nearest ordinary card (a "partial" match) instead of reading the corner.
 */
export const EXCLUDED_LAYOUTS = new Set(["emblem", "art_series", "scheme", "planar", "phenomenon", "vanguard", "host", "augment"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SMALL_PICTURE = /^https:\/\/cards\.scryfall\.io\/small\/[a-z0-9/_.-]+\.jpg(\?\d+)?$/;

/** The bulk item of the "Unique Artwork" file: { name, updated_at, uri } (the uri is the jsonl.gz one). */
export async function fetchBulkItem(fetchImpl = fetch) {
	const res = await fetchImpl("https://api.scryfall.com/bulk-data", { headers: { "User-Agent": USER_AGENT, Accept: ACCEPT } });
	if (!res.ok) throw new Error(`bulk-data answered ${res.status}`);
	const item = (await res.json()).data.find((d) => d.type === "unique_artwork");
	if (!item) throw new Error("no unique_artwork bulk item");
	const uri = item.jsonl_download_uri ?? item.download_uri;
	if (typeof uri !== "string" || !uri.startsWith("https://data.scryfall.io/")) throw new Error("unexpected bulk file address: " + uri);
	return { name: item.name, updated_at: item.updated_at, uri, size: item.compressed_size };
}

export async function downloadBulk(uri, file, fetchImpl = fetch) {
	const res = await fetchImpl(uri, { headers: { "User-Agent": USER_AGENT, Accept: "*/*" } });
	if (!res.ok) throw new Error(`bulk file answered ${res.status}`);
	await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
}

/**
 * The pictures to describe, one per illustration, in the file's order: { illustration, uri }. A paper card of a standard layout gives its picture; a double-faced card one per face (each face has
 * its own illustration). The first picture of an illustration wins (57 repeated ones in the 50 598 of the first spike). Counts what it left out, never throws on a card it cannot use.
 */
export async function listPictures(bulkFile) {
	const pictures = [];
	const seen = new Set();
	const stats = { cards: 0, notPaper: 0, excludedLayout: 0, noPicture: 0, badPicture: 0, noIllustration: 0, repeated: 0 };
	const rl = createInterface({ input: createReadStream(bulkFile).pipe(createGunzip()), crlfDelay: Infinity });
	for await (const line of rl) {
		if (!line.trim()) continue;
		const c = JSON.parse(line);
		stats.cards++;
		if (!(c.games ?? []).includes("paper")) {
			stats.notPaper++;
			continue;
		}
		if (EXCLUDED_LAYOUTS.has(c.layout)) {
			stats.excludedLayout++;
			continue;
		}
		const faces = c.image_uris ? [{ uri: c.image_uris.small, illustration: c.illustration_id }] : (c.card_faces ?? []).filter((f) => f.image_uris).map((f) => ({ uri: f.image_uris.small, illustration: f.illustration_id ?? c.illustration_id }));
		if (!faces.length || !faces[0].uri) {
			stats.noPicture++;
			continue;
		}
		for (const f of faces) {
			if (typeof f.illustration !== "string" || !UUID.test(f.illustration)) {
				stats.noIllustration++;
				continue;
			}
			if (typeof f.uri !== "string" || !SMALL_PICTURE.test(f.uri)) {
				stats.badPicture++;
				continue;
			}
			if (seen.has(f.illustration)) {
				stats.repeated++;
				continue;
			}
			seen.add(f.illustration);
			pictures.push({ illustration: f.illustration, uri: f.uri });
		}
	}
	return { pictures, stats };
}
