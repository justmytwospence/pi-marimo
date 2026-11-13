"""Draws the demo video's captions in a band above the terminal window.

Usage: annotate.py IN.mp4 IN.cast CAPTIONS.json FONT.ttf OUT.mp4

The take's asciicast (foley's `.cast` output) timestamps everything the terminal received, including
the hidden prelude before the tape's first `Show`. Two anchors map it onto the video's clock:
- The video starts when Pi's footer first shows the model name ("scripted"), the text the tape waits
  on before its first `Show`.
- demo/captions.ts writes an OSC 2 marker each time the tape presses Insert (inside Hide/Show, so
  the hidden cut around it is a single keystroke long). Marker n starts caption n; caption 0 shows
  from the first frame.
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

MARKER = "\x1b]2;pi-marimo-demo-caption\x07"
ANCHOR = "scripted"
BAND = 210  # pixels above the window, at the video's 2x scale
BACKGROUND = (17, 17, 27)
ACCENT = (245, 169, 127)
TITLE = (235, 237, 245)
BODY = (166, 173, 200)


def probe(path: str) -> tuple[int, int, float]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", path],
        check=True, capture_output=True, text=True,
    ).stdout
    data = json.loads(out)
    return data["streams"][0]["width"], data["streams"][0]["height"], float(data["format"]["duration"])


def cues(cast: str) -> tuple[float, list[float]]:
    lines = Path(cast).read_text().splitlines()[1:]
    events = [json.loads(line) for line in lines if line.strip()]
    start = next(t for t, kind, text in events if kind == "o" and ANCHOR in text)
    return start, [t - start for t, kind, text in events if kind == "o" and MARKER in text]


def card(width: int, title: str, body: str, font_path: str, out: Path) -> None:
    image = Image.new("RGB", (width, BAND), BACKGROUND)
    draw = ImageDraw.Draw(image)
    heading = ImageFont.truetype(font_path, 58)
    heading.set_variation_by_name("SemiBold")
    text = ImageFont.truetype(font_path, 42)
    text.set_variation_by_name("Regular")
    left = 120
    draw.rounded_rectangle((left - 40, 62, left - 28, BAND - 50), radius=6, fill=ACCENT)
    draw.text((left, 48), title, font=heading, fill=TITLE)
    draw.text((left, 122), body, font=text, fill=BODY)
    image.save(out)


def main() -> None:
    video, cast, captions_path, font_path, output = sys.argv[1:6]
    captions = json.loads(Path(captions_path).read_text())
    width, height, duration = probe(video)
    _, markers = cues(cast)
    if len(markers) != len(captions) - 1:
        sys.exit(f"annotate: {len(markers)} caption markers for {len(captions)} captions")
    starts = [0.0, *markers]
    ends = [*markers, duration]
    with tempfile.TemporaryDirectory() as tmp:
        inputs: list[str] = []
        chain = [f"[0:v]pad={width}:{height + BAND}:0:{BAND}:color=0x{bytes(BACKGROUND).hex()}[v0]"]
        for i, caption in enumerate(captions):
            png = Path(tmp) / f"caption{i}.png"
            card(width, caption["title"], caption["body"], font_path, png)
            inputs += ["-i", str(png)]
            chain.append(f"[v{i}][{i + 1}:v]overlay=0:0:enable='between(t,{starts[i]:.3f},{ends[i]:.3f})'[v{i + 1}]")
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", video, *inputs, "-filter_complex", ";".join(chain), "-map", f"[v{len(captions)}]",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-preset", "slow", "-movflags", "+faststart", output],
            check=True,
        )
    for i, caption in enumerate(captions):
        print(f"annotate: {starts[i]:6.2f}s  {caption['title']}")


if __name__ == "__main__":
    main()
