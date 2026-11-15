// Runs the gates and the self-test on a base that is already on disk (what build.mjs does at its end), without building: for a rehearsal, or to check what the site is about to serve.
//   node verify.mjs <base dir> --bulk <unique_artwork.jsonl.gz> --cache <picture dir> [--selftest-rows 200] [--previous <dir>]
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listPictures } from "./lib/bulk.mjs";
import { runGates } from "./lib/gates.mjs";
import { fetchPictures, pictureFile } from "./lib/pictures.mjs";
import { rowOf } from "./lib/rows.mjs";
import { selfTest } from "./lib/selftest-rows.mjs";
import { parseIndex, describeCard, CARD_W, CARD_H } from "./lib/plugin.bundle.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const dir = resolve(args[0]);
const work = mkdtempSync(join(tmpdir(), "fpverify-"));
const cache = resolve(opt("--cache", join(work, "pictures")));
const PIC_BYTES = CARD_W * CARD_H * 3;
try {
	const previousIndex = opt("--previous") ? parseIndex(JSON.parse(readFileSync(join(resolve(opt("--previous")), "index.json"), "utf8"))) : null;
	const gates = runGates({ dir, previousIndex });
	console.log(`gates passed: ${gates.rowsSeen} rows`);
	const { pictures } = await listPictures(resolve(opt("--bulk")));
	const describePictures = (list) => {
		const described = new Map();
		const listFile = join(work, "list.txt"), rawFile = join(work, "block.bin");
		writeFileSync(listFile, list.map((p) => pictureFile(cache, p.illustration)).join("\n"));
		execFileSync(process.env.FP_PYTHON ?? "python3", ["-I", join(here, "lib/decode.py"), listFile, rawFile], { stdio: ["ignore", "pipe", "inherit"] });
		const raw = readFileSync(rawFile), ok = readFileSync(rawFile + ".ok");
		list.forEach((p, k) => { if (ok[k]) described.set(p.illustration, describeCard(new Uint8Array(raw.buffer, raw.byteOffset + k * PIC_BYTES, PIC_BYTES))); });
		return { described };
	};
	const index = parseIndex(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")));
	const res = await selfTest({ out: dir, cache, pictures, sample: Number(opt("--selftest-rows", 200)), describePictures, m: index.m, fetchPictures, log: console.log });
	console.log(`self-test: ${res.same} of ${res.checked} sampled rows are exactly what their picture gives, ${res.different} differ`);
	if (res.checked >= 20 && res.different / res.checked > 0.02) process.exit(1);
} finally {
	rmSync(work, { recursive: true, force: true });
}
