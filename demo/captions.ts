// Timing for the demo video's captions and key overlay. For every key Pi receives, this writes a
// marker (an OSC 2 title the recording never shows) into the terminal stream, where foley's
// asciicast output timestamps it. demo/annotate.py lines the markers up with demo/demo.tape's
// commands: Insert (pressed inside Hide/Show, and swallowed here) starts the next caption, and
// commands marked `# demo: show` put their keys on screen. Nothing appears in Pi. Loaded only by
// demo/launch.sh.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

export const KEY_MARKER = "pi-marimo-demo-key:";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.onTerminalInput((data) => {
      process.stdout.write(`\x1b]2;${KEY_MARKER}${Buffer.from(data).toString("base64")}\x07`);
      return matchesKey(data, "insert") ? { consume: true } : undefined;
    });
  });
}
