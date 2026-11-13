// The demo video's captions: a card in the chat pane naming the feature on screen and its key.
// demo/demo.tape advances them with Insert inside Hide/Show, so the advancing key never shows on
// the keys reel (foley 0.1.0 drops Alt and Ctrl under Pi's keyboard protocol; Insert arrives intact). Loaded only by demo/launch.sh.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text, matchesKey } from "@earendil-works/pi-tui";

const CAPTIONS: Array<{ title: string; body: string }> = [
  { title: "pi-marimo", body: "A live marimo notebook beside Pi's chat. The keys pressed appear below the window." },
  { title: "/marimo edit demo.py", body: "Starts a marimo server and docks the notebook beside the chat. No browser." },
  { title: "A A · run all", body: "Every cell runs. The outline shows each cell's state; outputs render in the terminal." },
  { title: "/ · find a cell", body: "Jump to a cell by name. Plotly charts draw as real images." },
  { title: "w · drive widgets", body: "Move the slider from the keyboard; the chart reruns." },
  { title: "t · tables", body: "Page, sort and select rows. Space selects days, and the chart marks them." },
  { title: "a · ask the agent", body: "Ask about the selected cell. The agent edits the notebook through marimo pair while you watch." },
  { title: "c · the agent's change", body: "Jump to the cell the agent created; it is marked new." },
  { title: "d · the diff", body: "See exactly what the agent wrote. u would revert it." },
];

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    let index = 0;
    const show = () => {
      const { title, body } = CAPTIONS[index]!;
      ctx.ui.setWidget("demo-caption", (_tui, theme) => {
        const box = new Box(1, 1, (text) => theme.bg("toolPendingBg", text));
        box.addChild(new Text(`${theme.bold(theme.fg("accent", title))}\n${theme.fg("text", body)}`, 0, 0));
        return box;
      });
    };
    show();
    ctx.ui.onTerminalInput((data) => {
      if (!matchesKey(data, "insert")) return undefined;
      if (index < CAPTIONS.length - 1) index++;
      show();
      return { consume: true };
    });
  });
}
