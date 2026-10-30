import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { commandFor } from "./keys.js";
import { clean } from "./text.js";

export interface MessageState { text: string; scroll: number }
export function messagePreview(text: string | undefined, width: number, available: number): string[] {
  if (!text) return [];
  const rows = wrapTextWithAnsi(clean(text), width);
  const budget = Math.min(3, Math.max(0, available - Math.min(4, available)));
  if (rows.length <= budget) return rows;
  if (!budget) return [];
  return [...rows.slice(0, budget - 1), `F8 more · ${rows.length - budget + 1} lines hidden`];
}

/** Captured inert text; never dispatch reader input to the suspended owner. */
export class MessageView {
  state: MessageState;
  private max = 0;
  constructor(state: MessageState) { this.state = { text: clean(state.text), scroll: state.scroll }; }
  render(width: number, page: number): string[] {
    const rows = wrapTextWithAnsi(this.state.text, width);
    this.max = Math.max(0, rows.length - page);
    this.state.scroll = Math.max(0, Math.min(this.max, this.state.scroll));
    return rows.slice(this.state.scroll, this.state.scroll + page);
  }
  wheel(delta: number): void { this.state.scroll = Math.max(0, Math.min(this.max, this.state.scroll + delta)); }
  input(data: string, page: number): boolean {
    const id = commandFor("message", data)?.id;
    if (id === "message-close") return false;
    if (id === "message-down") this.wheel(1);
    if (id === "message-up") this.wheel(-1);
    if (id === "message-page-down") this.wheel(Math.max(1, page));
    if (id === "message-page-up") this.wheel(-Math.max(1, page));
    if (id === "message-top") this.state.scroll = 0;
    if (id === "message-bottom") this.state.scroll = this.max;
    return true;
  }
}
