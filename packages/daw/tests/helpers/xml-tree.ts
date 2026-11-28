import { DOMParser } from "@xmldom/xmldom";
import type { Element } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";

export type Tree = { tag: string; attrs: Record<string, string>; text: string; children: Tree[] };

export function parseTree(xml: string): Tree {
  const tree = (element: Element): Tree => {
    const attrs: Record<string, string> = {};
    for (let i = 0; i < element.attributes.length; i++) attrs[element.attributes.item(i)!.name] = element.attributes.item(i)!.value;
    const children: Tree[] = [];
    let text = "";
    for (let node = element.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === 1) children.push(tree(node as Element));
      else if (node.nodeType === 3) text += (node.nodeValue ?? "").trim();
    }
    return { tag: element.tagName, attrs, text, children };
  };
  return tree(new DOMParser().parseFromString(xml, "application/xml").documentElement!);
}

/** Where two trees differ, as `Project/Arrangement[0]/Lanes[0]/...` paths (attributes as `path@name`, elements as `path (added)` or `(removed)`). */
export function treeDifferences(a: Tree | undefined, b: Tree | undefined, path = "Project", out: string[] = []): string[] {
  if (!a || !b) {
    out.push(path + (a ? " (removed)" : " (added)"));
    return out;
  }
  for (const name of new Set([...Object.keys(a.attrs), ...Object.keys(b.attrs)])) if (a.attrs[name] !== b.attrs[name]) out.push(`${path}@${name}`);
  if (a.text !== b.text) out.push(`${path} (text)`);
  const seen = new Map<string, number>();
  const label = (tree: Tree) => {
    const n = seen.get(tree.tag) ?? 0;
    seen.set(tree.tag, n + 1);
    return `${tree.tag}[${n}]`;
  };
  const aLabels = a.children.map(label);
  seen.clear();
  const bLabels = b.children.map(label);
  for (let i = 0; i < Math.max(a.children.length, b.children.length); i++) {
    const labelA = aLabels[i];
    const labelB = bLabels[i];
    treeDifferences(a.children[i], b.children[i], `${path}/${labelA ?? labelB}`, out);
    if (labelA !== labelB && a.children[i] && b.children[i]) out.push(`${path}/${labelA} (reordered)`);
  }
  return out;
}

export const projectXmlOf = (archive: Uint8Array): string => strFromU8(unzipSync(archive)["project.xml"]);
