import { expect, test } from "vitest";
import { NotebookState } from "../src/core/notebook.js";
import { variableList, variableRows, variableDetailRows } from "../src/ui/variables.js";
import { dependencyRows, PackagePane } from "../src/ui/packages.js";
import { EnvironmentState } from "../src/core/packages.js";
const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
function notebook() {
  const nb = new NotebookState();
  nb.apply("kernel-ready", { cell_ids: ["a", "b"], codes: ["z = 1", "a = 2"], names: ["first", "second"] });
  nb.apply("variables", { variables: [{ name: "z", declared_by: ["a"], used_by: ["b", "b"] }, { name: "a", declared_by: ["b"], used_by: [] }] });
  nb.apply("variable-values", { variables: [{ name: "z", datatype: "int", value: "one  two\n  three\n" }, { name: "a", datatype: "str", value: "needle" }] });
  return nb;
}
test("variable sort is stable by name, search covers name/type/value and repr is untouched", () => {
  const nb = notebook();
  expect(variableList(nb).map(v => v.name)).toEqual(["a", "z"]);
  expect(variableList(nb, "", "type").map(v => v.name)).toEqual(["z", "a"]);
  expect(variableList(nb, "", "definition").map(v => v.name)).toEqual(["z", "a"]);
  expect(variableList(nb, "needle")[0]?.name).toBe("a");
  expect(variableList(nb, "INT")[0]?.value).toBe("one  two\n  three\n");
  expect(variableList(nb, "", "definition")[0]?.usedBy).toEqual(["b"]);
});
test("narrow list stays responsive; detail conserves supplied multiline whitespace and long tails", () => {
  const nb = notebook();
  const list = variableList(nb);
  expect(variableRows(list, nb, theme, "z", 44).rows[1]?.text).toContain("int");
  const v = list[1]!;
  v.value = `one  two\n  three\n${"x".repeat(2000)}TAIL\n`;
  const rows = variableDetailRows(v, nb, 44);
  expect(rows[2]?.text).toBe("marimo value preview");
  expect(rows.slice(3).map(r => r.text).join("")).toBe(v.value.replace(/\n/g, ""));
  expect(rows.at(-1)?.text).toBe("");
});
test("dependency tree expand/filter includes ancestors, cycle and dedupe tags", () => {
  const tree = { name: "root", dependencies: [{ name: "a", dependencies: [{ name: "needle", tags: [{ kind: "dedupe", value: "" }] }] }, { name: "cycle", tags: [{ kind: "cycle", value: "a" }] }] };
  expect(dependencyRows(tree, new Set()).map(r => r.name)).toEqual(["root"]);
  expect(dependencyRows(tree, new Set(["root", "root/0"])).map(r => r.name)).toEqual(["root", "a", "needle", "cycle"]);
  expect(dependencyRows(tree, new Set(), "needle").map(r => r.name)).toEqual(["root", "a", "needle"]);
  expect(dependencyRows(tree, new Set(["root"])).at(-1)?.text).toContain("[cycle: a]");
});
test("unavailable tree is independent of list and operations distinguish source and restart", () => {
  const pane = new PackagePane();
  pane.treeError = "Dependency tree unavailable";
  const env = new EnvironmentState();
  env.apply("environment-operation", { source: "server", operation_id: "1", action: "install", status: { kind: "restart-required" }, packages: { tool: "1" }, logs: { tool: "server log" } });
  env.apply("missing-package-alert", { source: "server", packages: ["tool"] });
  pane.state.tab = "Operations";
  const text = pane.rows(env, 80).map(r => r.text).join("\n");
  expect(text).toContain("server: install"); expect(text).toContain("server log"); expect(text).toContain("Restart manually");
  pane.state.tab = "Missing";
  expect(pane.rows(env, 80).map(r => r.text).join("\n")).toContain("not kernel-installable");
});
