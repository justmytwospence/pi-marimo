// Producer text is inert before any trusted renderer styling is added.
import { stripTerminalSequences } from "@earendil-works/pi-tui";

export const clean = (text: string): string => stripTerminalSequences(text.replace(/[\x90\x98\x9b\x9d\x9e\x9f\x9c]/gu, c => `\x1b${String.fromCharCode(c.charCodeAt(0) - 0x40)}`).replace(/\x1b[P_X^][\s\S]*?(?:\x1b\\|$)/gu, ""))
  .replace(/\t/gu, "    ").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/gu, "");
export const oneLine = (text: string): string => clean(text.replace(/[\r\n\t]+/gu, " ")).replace(/\s+/gu, " ").trim();
