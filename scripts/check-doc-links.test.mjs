import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { checkLinks, linksIn } from "./check-doc-links.mjs";
import { anchors, slug } from "./lib/markdown.mjs";

function tree(files) {
  const base = mkdtempSync(join(tmpdir(), "ar-links-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), text);
  }
  return base;
}
const problems = (files, from = "docs/a.md") => {
  const base = tree(files);
  return checkLinks([join(base, from)], base).map((p) => `${p.line}:${p.target}`);
};

test("slugs follow GitHub: punctuation dropped, spaces to hyphens, duplicates numbered", () => {
  assert.equal(slug("Rendering offline — `renderTimeline`"), "rendering-offline--rendertimeline");
  assert.equal(slug("Readable\\<T\\>"), "readablet");
  assert.deepEqual([...anchors("# A\n## A\n```\n# not\n```\n")], ["a", "a-1"]);
});

test("links inside code fences and inline code are ignored", () => {
  assert.deepEqual(
    linksIn("[x](./one.md)\n`[y](./two.md)`\n```\n[z](./three.md)\n```").map((l) => l.target),
    ["./one.md"],
  );
});

test("a link to a heading in another file resolves; a heading that lives elsewhere does not", () => {
  const files = {
    "docs/a.md": "[ok](./b.md#own)\n[bad](./b.md#elsewhere)\n[self](#top-heading)\n[missing](./c.md)\n# Top heading",
    "docs/b.md": "# Own\n",
  };
  assert.deepEqual(problems(files), ["2:./b.md#elsewhere", "4:./c.md"]);
});

test("site routes and github blob links are checked against the tree", () => {
  const files = {
    "docs/a.md":
      "[a](/docs/b)\n[b](/docs/nope)\n[c](https://github.com/audiorective/audiorective/blob/main/docs/b.md#own)\n[d](https://github.com/audiorective/audiorective/blob/main/docs/b.md#gone)\n[e](https://example.com/x)",
    "docs/b.md": "# Own\n",
  };
  assert.deepEqual(problems(files), ["2:/docs/nope", "4:https://github.com/audiorective/audiorective/blob/main/docs/b.md#gone"]);
});
