#!/usr/bin/env python3
"""Remove APPn and comment segments from a JPEG, in place.

Phone photos carry GPS coordinates and device serials in EXIF. These files get
published to a public website, so every metadata segment is dropped before the
image is committed. Stdlib only, so the daily job has no install step.
"""
import sys


def strip(path):
    with open(path, "rb") as f:
        data = f.read()

    if data[:2] != b"\xff\xd8":
        return False

    out = bytearray(b"\xff\xd8")
    i, n = 2, len(data)

    while i < n - 1:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]

        # Standalone markers carry no payload.
        if marker == 0xD8 or marker == 0x01 or 0xD0 <= marker <= 0xD7:
            out += data[i:i + 2]
            i += 2
            continue
        # Fill byte.
        if marker == 0xFF:
            i += 1
            continue
        # Start of scan: everything after is entropy-coded image data.
        if marker == 0xDA:
            out += data[i:]
            break

        seg_len = int.from_bytes(data[i + 2:i + 4], "big")
        if seg_len < 2:
            return False
        end = i + 2 + seg_len
        is_metadata = 0xE0 <= marker <= 0xEF or marker == 0xFE
        if not is_metadata:
            out += data[i:end]
        i = end

    with open(path, "wb") as f:
        f.write(out)
    return True


if __name__ == "__main__":
    failed = [p for p in sys.argv[1:] if not strip(p)]
    for p in failed:
        print(f"strip_exif: not a JPEG, left untouched: {p}", file=sys.stderr)
    sys.exit(1 if failed else 0)
