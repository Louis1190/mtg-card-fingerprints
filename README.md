# mtg-card-fingerprints

Small numeric fingerprints of Magic: The Gathering card illustrations, published as static files on GitHub Pages
(`https://louis1190.github.io/mtg-card-fingerprints/fp/`). A reader that holds a photo of a card computes the same fingerprint from the photo and finds the closest
illustrations, without reading any text on the card.

It exists for a [personal Obsidian plugin](https://github.com/Louis1190/obsidian-mtg-collection-tracker) that tracks a physical collection. It is **not a service with guarantees**: the files are
rebuilt from Scryfall's data every week and may change shape or disappear.

## What is in it, and what is not

For each artwork Scryfall knows (about 50 500 in paper) one row: **Scryfall's `illustration_id`** and **583 small integers** (0 to 15) computed from the artwork of the card's "small" picture
reduced to 96 x 134 pixels (a gradient histogram, a coarse luminance grid and a DCT of the artwork area). **No picture, no card name, no text, no set, no price**: nothing that
can be read back as a card. A reader asks Scryfall, at the time of use, what the card is.

## Files

```
fp/index.json      { "v": 1, "date": "2026-11-11", "n": 50541,
                     "m": { "hog": 0.187988, "tinylum": 3.553086, "dct": 0.869309 },
                     "shards": [ { "file": "s0.bin.gz", "rows": 6400, "sha256": "<hex of the .gz file>" }, ... ],
                     "moved": "https://..." }        (only when the files moved: see "Moving the files")
fp/s<n>.bin.gz     the rows, in order, 6 400 per shard (the last one fewer), about 1.3 MB each; gzip of:
                       rows x 16 bytes   the illustration_id of each row (the 32 hex digits of the UUID, as bytes)
                       then one block per descriptor, in this order: hog (192 values per row), tinylum (280), dct (111).
                       A block is rows x dimensions 4-bit values, two to a byte, the LOW nibble first, padded to a whole byte.
status.json        what the last run did (also keeps this repository's scheduled job alive)
```

A value `q` (0 to 15) stands for `q / 15 * 2m - m`, with `m` the descriptor's entry in `index.json`. **The three ranges `m` never change**, and rows are only ever added at the end
(a shard that is full never changes again), so a reader that holds a shard keeps its meaning and downloads only the shards whose hash changed. `index.json` is what a reader fetches first;
every shard is checked against the hash it lists. Format version `v` is 1: a reader that meets another version should ignore the files.

## How it is made

`scripts/build.mjs` runs every Monday (GitHub Actions, `.github/workflows/weekly.yml`). It follows what Scryfall's API documentation asks of anyone who needs many card images: **one call to
`/bulk-data`, the "Unique Artwork" bulk file for the list of illustrations, and the image servers for the pictures** (no card search endpoint is used). It reads the previous base back from the
site, checks every shard against its hash, describes only the illustrations the base does not hold yet, and appends them. The descriptors are computed by the same code the plugin runs on a
photo (`scripts/lib/plugin.bundle.mjs`, generated from the plugin's source), and the pictures are decoded with Pillow (pinned).

It publishes only after its own checks pass, run on the files it is about to publish, read back from disk: the index is one the plugin reads, every shard matches its hash and unpacks to exactly
the rows it declares, no id appears twice, the number of rows has not dropped, the three ranges have not changed, almost no new picture was missing, the values are spread as on the first base, and
200 rows drawn at random are described again from their pictures and must come out nibble for nibble the same. A run with nothing new publishes nothing. The first run, with `bootstrap`, builds
everything (about 15 minutes); afterwards a run reads the published base and stops if it cannot.

`node scripts/selftest.mjs` runs the tests of the job (the formats against the plugin's own reader, and every check shown able to fail).

## Moving the files

If these files ever have to live at another address, the plugin can be told: put the new address (https, one line) in `moved-to.txt` at the root of this repository (lines starting with `#` are
comments), then run the `weekly` workflow (a changed address counts as something to publish). `index.json` then carries `"moved": "<address>"`. A reader that finds it asks that address for its
own `index.json` (once; a pointer there is followed one step at the next load, never in a chain), uses the files found there, and keeps the address on its device. If the new address does not
answer, it keeps using the files where it found them. **This only works while the old address still answers**: GitHub does not redirect a Pages site when a repository or an account is renamed.
The job refuses an address a reader would not follow (a typo stops the run instead of publishing nothing).

## Questions and removal requests

Issues are turned off on this repository on purpose (it is generated by a script and holds nothing to discuss). To ask a question, or to ask for something to be changed or removed
(**including a request from Scryfall**), open an issue on the plugin's repository, <https://github.com/Louis1190/obsidian-mtg-collection-tracker/issues>, with a title that starts with
`mtg-card-fingerprints:`. The author's GitHub profile is <https://github.com/Louis1190>. A removal request is honoured promptly: this repository can be unpublished at any time. A plugin that never
downloaded the files then reads the card's title instead; **a device that already downloaded them keeps its copy** (in the plugin's own folder, files named `fp-*`) until the person deletes it or updates the plugin.

## Credits and terms

- The numbers are computed from card pictures provided by [Scryfall](https://scryfall.com), fetched the way its API documentation describes. This project is not affiliated with or endorsed by Scryfall.
- Magic: The Gathering is a trademark of Wizards of the Coast LLC. This project is unofficial Fan Content permitted under the Fan Content Policy and is not approved or endorsed by Wizards of the Coast.
  Portions of the materials used are property of Wizards of the Coast. (c) Wizards of the Coast LLC. See `NOTICE`.
- The scripts are MIT licensed (`LICENSE`).
