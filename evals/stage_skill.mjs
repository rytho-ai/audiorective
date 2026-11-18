// Copy a skill directory into a throwaway project with every symlink resolved to a real file.
// fs.cpSync({ dereference }) only dereferences the top-level source, so the links under
// references/ (which point into docs/ and CHANGELOG.md) would survive as absolute symlinks
// to paths outside the project and the solver would report them as missing.
import { copyFileSync, lstatSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function copyResolved(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    let info;
    try {
      info = statSync(from); // follows links; throws on a broken one
    } catch (err) {
      throw new Error(`cannot stage ${from}: broken link or unreadable (${err.code ?? err.message})`);
    }
    if (info.isDirectory()) copyResolved(from, to);
    else if (info.isFile()) copyFileSync(from, to);
  }
}

export function assertNoSymlinks(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (lstatSync(path).isSymbolicLink()) throw new Error(`staged skills must not contain symlinks: ${path}`);
    if (entry.isDirectory()) assertNoSymlinks(path);
  }
}
