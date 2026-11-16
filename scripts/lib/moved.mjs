// The address devices are sent to when the files move (`moved-to.txt` at the root of the data repository, read by build.mjs). The one rule is the PLUGIN's own (`parseMovedAddress`, from the bundle):
// what this job writes is exactly what the plugin will accept, in the form it compares. Blank lines and lines starting with # are comments; no file, or nothing but comments, means "not moved".
import { existsSync, readFileSync } from "node:fs";
import { parseMovedAddress } from "./plugin.bundle.mjs";

/** The canonical address in `file`, or null when there is none. Throws on a file that has something in it the plugin would not follow (a typo must stop the job, not silently publish nothing). */
export function readMovedFile(file) {
	if (!file || !existsSync(file)) return null;
	const lines = readFileSync(file, "utf8")
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l !== "" && !l.startsWith("#"));
	if (lines.length === 0) return null;
	if (lines.length > 1) throw new Error(`${file}: one address only, found ${lines.length} lines`);
	const address = parseMovedAddress(lines[0]);
	if (!address) throw new Error(`${file}: "${lines[0]}" is not an address the plugin follows (https, a named host with a dot, no credentials, query or fragment, 300 characters at most)`);
	return address;
}
