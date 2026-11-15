"""Pictures -> raw 96 x 134 RGB cards, the way the first spike made its base (the pictures are downloaded data: run with python3 -I).
python3 -I decode.py <list file: one picture path per line> <out file>
Writes <out file> (38 592 bytes per picture, in the list's order, zeros where a picture is unreadable) and <out file>.ok (one byte per picture: 1 = read)."""
import sys
from PIL import Image

W, H = 96, 134
paths = [l.rstrip("\n") for l in open(sys.argv[1]) if l.strip()]
buf, ok, bad = bytearray(), bytearray(), 0
for p in paths:
    try:
        im = Image.open(p).convert("RGB").resize((W, H), Image.LANCZOS)
        buf += im.tobytes()
        ok.append(1)
    except Exception:
        buf += bytes(W * H * 3)
        ok.append(0)
        bad += 1
open(sys.argv[2], "wb").write(buf)
open(sys.argv[2] + ".ok", "wb").write(ok)
print("decoded", len(paths) - bad, "unreadable", bad)
