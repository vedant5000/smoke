#!/usr/bin/env python3
"""
Build docs/screenshots/demo.gif: the whole Smoke loop, start to share link.

    python3 docs/screenshots/make-gif.py

Composed, not captured, for the same reasons as shoot.sh. Smoke hides its own
windows from every screen recorder, and pointing a camera at a real session
would put somebody's actual desktop into a public repo. Chrome renders the real
renderer pages in fixed states over a synthetic desktop, and the movement
between states is tweened here with the same easing the CSS uses.

Needs Google Chrome and Pillow (python3 -m pip install Pillow).
"""

import os
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

CANVAS = (1920, 1080)
GIF_W = 900


# ----------------------------------------------------------------- staging
def stage(tmp):
    """The real renderer with the mock bridge injected, exactly as shoot.sh does."""
    shutil.copytree(os.path.join(ROOT, "renderer"), os.path.join(tmp, "renderer"))
    shutil.copy(os.path.join(SRC, "demo-bridge.js"), os.path.join(tmp, "renderer"))
    for f in ("compose.html", "desktop.html", "avatar.html"):
        shutil.copy(os.path.join(SRC, f), tmp)
    os.makedirs(os.path.join(tmp, "assets"), exist_ok=True)
    os.makedirs(os.path.join(tmp, "media"), exist_ok=True)
    shutil.copy(os.path.join(ROOT, "assets", "mark-black.png"), os.path.join(tmp, "assets"))

    d = os.path.join(tmp, "renderer")
    for f in os.listdir(d):
        if f.endswith(".html"):
            p = os.path.join(d, f)
            s = open(p).read()
            open(p, "w").write(
                s.replace("<head>", '<head>\n<script src="demo-bridge.js"></script>', 1))

    p = os.path.join(tmp, "desktop.html")
    s = open(p).read()
    open(p, "w").write(s.replace("../../../assets/mark-black.png", "assets/mark-black.png"))


def render(url, out, size=CANVAS, tries=3):
    for _ in range(tries):
        subprocess.run([
            CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
            "--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required",
            "--virtual-time-budget=9000", "--force-device-scale-factor=1",
            f"--window-size={size[0]},{size[1]}", f"--screenshot={out}", url,
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if os.path.exists(out) and os.path.getsize(out) > 5000:
            return Image.open(out).convert("RGB")
    raise RuntimeError(f"Chrome kept failing on {url}")


# ----------------------------------------------------------------- easing
def cubic_bezier(x1, y1, x2, y2):
    def curve(t, a, b):
        return 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3

    def at(x):
        lo, hi = 0.0, 1.0
        for _ in range(40):
            mid = (lo + hi) / 2
            if curve(mid, x1, x2) < x:
                lo = mid
            else:
                hi = mid
        return curve((lo + hi) / 2, y1, y2)
    return at


EASE_OUT = cubic_bezier(.22, 1, .36, 1)     # things arriving


def slide_up(base, panel, dy_from, steps):
    """Tween a window arriving from below, the way the panel actually appears."""
    out = []
    for i in range(steps):
        p = EASE_OUT((i + 1) / steps)
        dy = int(round(dy_from * (1 - p)))
        frame = base.copy()
        shifted = Image.new("RGB", base.size, (0, 0, 0))
        shifted.paste(panel, (0, dy))
        # only the panel moves, so blend it in over the desktop by its own delta
        mask = Image.new("L", base.size, 0)
        diff = Image.new("L", base.size, int(255 * min(1, p * 1.6)))
        mask.paste(diff, (0, 0))
        frame = Image.composite(shifted, frame, mask)
        out.append(frame)
    return out


def crossfade(a, b, steps):
    return [Image.blend(a, b, (i + 1) / (steps + 1)) for i in range(steps)]


# ----------------------------------------------------------------- gif out
def write_gif(frames, durations, path, width=GIF_W):
    scaled = [f.resize((width, round(f.height * width / f.width)), Image.LANCZOS)
              for f in frames]
    step = max(1, len(scaled) // 10)
    sample = scaled[::step]
    strip = Image.new("RGB", (scaled[0].width, scaled[0].height * len(sample)))
    for i, f in enumerate(sample):
        strip.paste(f, (0, i * scaled[0].height))
    pal = strip.quantize(colors=200, method=Image.MEDIANCUT)
    q = [f.quantize(palette=pal, dither=Image.Dither.NONE) for f in scaled]
    q[0].save(path, save_all=True, append_images=q[1:], duration=durations,
              loop=0, optimize=True, disposal=1)
    print(f"   {os.path.basename(path)}  {q[0].width}x{q[0].height}  "
          f"{len(q)} frames  {os.path.getsize(path)/1e6:.1f} MB")


def main():
    if not os.path.exists(CHROME):
        sys.exit(f"Google Chrome not found at {CHROME}")
    tmp = tempfile.mkdtemp(prefix="smoke-gif-")
    try:
        print("==> staging")
        stage(tmp)

        print("==> rendering the frames the editor opens")
        render(f"file://{tmp}/desktop.html", f"{tmp}/media/frame.png")
        render(f"file://{tmp}/avatar.html", f"{tmp}/media/avatar.png", (720, 720))

        base = f"file://{tmp}/compose.html"
        jobs = {
            "desk":     f"file://{tmp}/desktop.html",
            "recorder": f"{base}?shot=recorder",
            "cd3":      f"{base}?shot=countdown&count=3",
            "cd2":      f"{base}?shot=countdown&count=2",
            "cd1":      f"{base}?shot=countdown&count=1",
            "rec03":    f"{base}?shot=recording&elapsed=3000",
            "rec19":    f"{base}?shot=recording&elapsed=19000",
            "rec47":    f"{base}?shot=recording&elapsed=47000",
            "studio":   f"{base}?shot=studio",
            "publish":  f"{base}?shot=publish",
        }
        print(f"==> rendering {len(jobs)} states")

        def one(item):
            k, url = item
            return k, render(url, f"{tmp}/state-{k}.png")

        with ThreadPoolExecutor(max_workers=3) as pool:
            shots = dict(pool.map(one, jobs.items()))

        print("==> assembling")
        seq = []            # (image, hold ms)

        seq.append((shots["desk"], 900))
        for f in slide_up(shots["desk"], shots["recorder"], 90, 6):
            seq.append((f, 40))
        seq.append((shots["recorder"], 1500))

        for k in ("cd3", "cd2", "cd1"):
            seq.append((shots[k], 520))

        seq.append((shots["rec03"], 700))
        seq.append((shots["rec19"], 600))
        seq.append((shots["rec47"], 900))

        for f in crossfade(shots["rec47"], shots["studio"], 4):
            seq.append((f, 45))
        seq.append((shots["studio"], 2100))

        for f in crossfade(shots["studio"], shots["publish"], 3):
            seq.append((f, 45))
        seq.append((shots["publish"], 2600))

        write_gif([f for f, _ in seq], [d for _, d in seq],
                  os.path.join(HERE, "demo.gif"))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("==> done")


if __name__ == "__main__":
    main()
