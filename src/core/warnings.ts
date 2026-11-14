// Python `warnings` output as records: `path:line: Category: message`, then an echoed source line.
// Repeats from one call site collapse into one item that lists the words that differ.

export interface WarningRecord { category: string; file: string; line: number; message: string[]; index: number }
export type WarningItem =
  | { kind: "warning"; category: string; file: string; line: number; count: number; message: string[]; varies: string[]; distinct?: string[][] }
  | { kind: "line"; index: number };

export const WARNING_HEADER = /^(.+?):(\d+): ([A-Za-z_][\w.]*Warning): (.*)$/u;

export function parseWarnings(texts: readonly string[]): WarningItem[] {
  const items: Array<WarningItem | { group: string }> = [];
  const groups = new Map<string, { records: WarningRecord[]; item: Extract<WarningItem, { kind: "warning" }> }>();
  let open: WarningRecord | undefined;
  let openKey = "";
  const close = () => {
    if (!open) return;
    let group = groups.get(openKey);
    if (!group) {
      const item: Extract<WarningItem, { kind: "warning" }> = { kind: "warning", category: open.category, file: open.file, line: open.line, count: 0, message: open.message, varies: [] };
      group = { records: [], item };
      groups.set(openKey, group);
      items.push(item);
    }
    group.records.push(open);
    group.item.count = group.records.length;
    open = undefined;
  };
  texts.forEach((text, index) => {
    const header = WARNING_HEADER.exec(text);
    if (header) {
      close();
      open = { category: header[3]!, file: header[1]!, line: Number(header[2]), message: [header[4]!], index };
      openKey = `${open.category}\0${open.file}\0${open.line}`;
      return;
    }
    if (open) {
      if (/^ {2}\S/u.test(text)) { close(); return; }
      if (text === "") { close(); items.push({ kind: "line", index }); return; }
      open.message.push(text);
      return;
    }
    items.push({ kind: "line", index });
  });
  close();
  for (const { records, item } of groups.values()) {
    if (records.length < 2) continue;
    const tokens = records.map(r => r.message.join(" ").split(/\s+/u).filter(Boolean));
    const first = tokens[0]!;
    if (tokens.every(t => t.length === first.length)) {
      const positions = first.map((_, i) => i).filter(i => tokens.some(t => t[i] !== first[i]));
      item.varies = [...new Set(tokens.map(t => positions.map(i => t[i]).join(" ")))].filter(Boolean);
    } else {
      const seen = new Map<string, string[]>();
      for (const r of records) if (!seen.has(r.message.join("\n"))) seen.set(r.message.join("\n"), r.message);
      item.distinct = [...seen.values()];
    }
  }
  return items as WarningItem[];
}

export function shortPath(file: string, home: string | undefined = process.env.HOME): string {
  for (const segment of ["/site-packages/", "/dist-packages/"]) {
    const at = file.lastIndexOf(segment);
    if (at >= 0) return file.slice(at + segment.length);
  }
  const lib = /\/lib\/python3\.\d+\//u.exec(file);
  if (lib) return file.slice(lib.index + lib[0].length);
  if (home && file.startsWith(`${home}/`)) return `~${file.slice(home.length)}`;
  return file;
}
