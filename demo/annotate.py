"""Draws the demo video's captions above the terminal window and its shortcut keys below it.

Usage: annotate.py IN.mp4 IN.cast TAPE CAPTIONS.json FONT.ttf OUT.mp4

demo/captions.ts writes a marker into the terminal stream for every key Pi receives, and the take's
asciicast (foley's `.cast` output) timestamps them. The markers are matched, in order, to the keys
the tape sends after its first `Show` (a `Type` sends one key per character). Then:
- each Insert (pressed inside Hide/Show, so the hidden cut is one keystroke long) starts the next
  caption; caption 0 shows from the first frame;
- each command after a `# demo: show <keys>` line shows `<keys>` as keycaps from its first key to
  shortly after its last; other typing (commands, cell names, the prompt) is never shown.

The cast also includes the hidden prelude, so its clock starts earlier than the video's: the video
starts when Pi's footer first shows the model name ("scripted"), the text the tape waits on.
"""

import base64
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

KEY_MARKER = re.compile(r"\x1b\]2;pi-marimo-demo-key:([A-Za-z0-9+/=]*)\x07")
ANCHOR = "scripted"
TOP = 210  # caption band above the window, at the video's 2x scale
BOTTOM = 150  # keys band below it
HOLD = 1.4  # seconds a shortcut stays up after its last key
BACKGROUND = (17, 17, 27)
ACCENT = (245, 169, 127)
TITLE = (235, 237, 245)
BODY = (166, 173, 200)
CAP = (49, 50, 68)
CAP_EDGE = (88, 91, 112)
NAMED = {"Enter", "Space", "Escape", "Insert", "Tab", "Backspace", "Up", "Down", "Left", "Right"}


def probe(path: str) -> tuple[int, int, float]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", path],
        check=True, capture_output=True, text=True,
    ).stdout
    data = json.loads(out)
    return data["streams"][0]["width"], data["streams"][0]["height"], float(data["format"]["duration"])


def received(cast: str) -> list[float]:
    """The video time of every key Pi received; a chunk of plain text counts once per character."""
    events = [json.loads(line) for line in Path(cast).read_text().splitlines()[1:] if line.strip()]
    start = next(t for t, kind, text in events if kind == "o" and ANCHOR in text)
    times: list[float] = []
    for t, kind, text in events:
        if kind != "o":
            continue
        for match in KEY_MARKER.finditer(text):
            data = base64.b64decode(match.group(1)).decode("utf-8", "replace")
            times += [t - start] * (1 if data.startswith("\x1b") else max(1, len(data)))
    return times


def sent(tape: str) -> list[tuple[str, int, str | None]]:
    """The tape's key-sending commands after its first Show: (command, key count, keys to show)."""
    commands: list[tuple[str, int, str | None]] = []
    shown = False
    label: str | None = None
    for raw in Path(tape).read_text().splitlines():
        line = raw.strip()
        if line == "Show":
            shown = True
        if not shown or not line:
            continue
        if line.startswith("# demo: show "):
            label = line.removeprefix("# demo: show ").strip()
            continue
        if line.startswith("#"):
            continue
        word, _, rest = line.partition(" ")
        if word.startswith("Type"):
            count = len(rest.strip()[1:-1])
        elif word in NAMED:
            count = int(rest) if rest.strip().isdigit() else 1
        else:
            continue
        commands.append((word, count, label))
        label = None
    return commands


def caption_card(width: int, title: str, body: str, font_path: str, out: Path) -> None:
    image = Image.new("RGB", (width, TOP), BACKGROUND)
    draw = ImageDraw.Draw(image)
    heading = ImageFont.truetype(font_path, 58)
    heading.set_variation_by_name("SemiBold")
    text = ImageFont.truetype(font_path, 42)
    text.set_variation_by_name("Regular")
    left = 120
    draw.rounded_rectangle((left - 40, 62, left - 28, TOP - 50), radius=6, fill=ACCENT)
    draw.text((left, 48), title, font=heading, fill=TITLE)
    draw.text((left, 122), body, font=text, fill=BODY)
    image.save(out)


def keycaps(width: int, label: str, font_path: str, out: Path) -> None:
    image = Image.new("RGB", (width, BOTTOM), BACKGROUND)
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(font_path, 50)
    font.set_variation_by_name("SemiBold")
    x, top, bottom = 120, 32, BOTTOM - 32
    for token in label.split():
        left, _, right, _ = draw.textbbox((0, 0), token, font=font)
        cap = max(bottom - top, right - left + 48)
        draw.rounded_rectangle((x, top, x + cap, bottom), radius=14, fill=CAP, outline=CAP_EDGE, width=3)
        draw.text((x + cap / 2, (top + bottom) / 2), token, font=font, fill=TITLE, anchor="mm")
        x += cap + 18
    image.save(out)


def main() -> None:
    video, cast, tape, captions_path, font_path, output = sys.argv[1:7]
    captions = json.loads(Path(captions_path).read_text())
    width, height, duration = probe(video)
    times = received(cast)
    commands = sent(tape)
    if len(times) != sum(count for _, count, _ in commands):
        sys.exit(f"annotate: Pi received {len(times)} keys, the tape sends {sum(c for _, c, _ in commands)} after its first Show")

    cues: list[float] = []
    shortcuts: list[tuple[float, float, str]] = []
    i = 0
    for word, count, label in commands:
        span = times[i:i + count]
        i += count
        if word == "Insert":
            cues.append(span[0])
        if label and span:
            shortcuts.append((span[0], span[-1], label))
    if len(cues) != len(captions) - 1:
        sys.exit(f"annotate: {len(cues)} caption cues for {len(captions)} captions")

    overlays: list[tuple[Path, int, float, float]] = []  # image, y, from, to
    with tempfile.TemporaryDirectory() as tmp:
        starts = [0.0, *cues]
        # The last caption holds to the end: the encoder can extend the final frame past `duration`.
        ends = [*cues, duration + 3600]
        for n, caption in enumerate(captions):
            png = Path(tmp) / f"caption{n}.png"
            caption_card(width, caption["title"], caption["body"], font_path, png)
            overlays.append((png, 0, starts[n], ends[n]))
        for n, (first, last, label) in enumerate(shortcuts):
            png = Path(tmp) / f"keys{n}.png"
            keycaps(width, label, font_path, png)
            until = min(last + HOLD, shortcuts[n + 1][0] if n + 1 < len(shortcuts) else duration + 3600)
            overlays.append((png, TOP + height, first, until))

        inputs: list[str] = []
        chain = [f"[0:v]pad={width}:{TOP + height + BOTTOM}:0:{TOP}:color=0x{bytes(BACKGROUND).hex()}[v0]"]
        for n, (png, y, start, end) in enumerate(overlays):
            inputs += ["-i", str(png)]
            chain.append(f"[v{n}][{n + 1}:v]overlay=0:{y}:enable='between(t,{start:.3f},{end:.3f})'[v{n + 1}]")
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", video, *inputs, "-filter_complex", ";".join(chain), "-map", f"[v{len(overlays)}]",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-preset", "slow", "-movflags", "+faststart", output],
            check=True,
        )
    for n, caption in enumerate(captions):
        print(f"annotate: {starts[n]:6.2f}s  {caption['title']}")
    print(f"annotate: {len(shortcuts)} shortcuts shown")


if __name__ == "__main__":
    main()
