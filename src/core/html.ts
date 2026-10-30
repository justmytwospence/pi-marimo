// Inert output parsing: parse5 never executes scripts or loads resources.
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";

export type OutputNode = DefaultTreeAdapterMap["node"];
export function parseOutputFragment(html: string): DefaultTreeAdapterMap["documentFragment"] {
  return parseFragment(html);
}

/** Attribute entities are already decoded by parse5; marimo data-* values are JSON. */
export function componentProps(node: OutputNode): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  if (!("attrs" in node)) return props;
  for (const { name, value } of node.attrs) {
    if (!name.startsWith("data-")) continue;
    try { props[name.slice(5)] = JSON.parse(value); } catch { /* malformed producer prop */ }
  }
  return props;
}

export function textContent(node: OutputNode): string {
  if ("tagName" in node && ["script", "style", "template"].includes(node.tagName)) return "";
  if ("value" in node && node.nodeName === "#text") return node.value;
  return "childNodes" in node ? node.childNodes.map(textContent).join("") : "";
}

/** Script/style/template descendants are deliberately never visited. */
export function* outputElements(node: OutputNode): Generator<DefaultTreeAdapterMap["element"]> {
  if ("tagName" in node) {
    if (["script", "style", "template"].includes(node.tagName)) return;
    yield node;
  }
  if ("childNodes" in node) for (const child of node.childNodes) yield* outputElements(child);
}
