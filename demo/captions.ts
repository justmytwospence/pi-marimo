// Caption cues for the demo video. demo/demo.tape presses Insert inside Hide/Show at each beat; this
// writes a marker (an OSC 2 title the recording never shows) into the terminal stream, where foley's
// asciicast output timestamps it, and swallows the key. demo/annotate.py turns the markers into the
// captions it draws above the window. Nothing appears in Pi. Loaded only by demo/launch.sh.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

export const CAPTION_MARKER = "pi-marimo-demo-caption";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.onTerminalInput((data) => {
      if (!matchesKey(data, "insert")) return undefined;
      process.stdout.write(`\x1b]2;${CAPTION_MARKER}\x07`);
      return { consume: true };
    });
  });
}
