// Shared by the declaration checks (A2 JSDoc, A3 single entry, A4 vocabulary): resolve a package's public entries to
// their exported symbols through the TypeScript checker, so bundler chunks and `export *` are followed.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Packages inside the affordance goal. Others (react, threejs, playcanvas, devtools, samples, pads, sequencer) are out of scope. */
export const IN_SCOPE = ["daw", "mcp", "core", "clock", "effects", "launcher", "midi", "host", "player", "recorder", "widgets"];

/** Public entries of a package: `{ entry: "." | "./web" …, file: absolute .d.ts }`. Entries without a built declaration are returned with `file: null`. */
export function packageEntries(pkgDir) {
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const out = [];
  for (const [entry, target] of Object.entries(pkg.exports ?? {})) {
    if (entry === "./package.json") continue;
    const raw = typeof target === "string" ? target : (target.types ?? target.import ?? target.default);
    if (typeof raw !== "string") continue;
    const dts = raw.replace(/\.(?:m?js)$/, ".d.ts");
    const file = resolve(pkgDir, dts);
    out.push({ entry, file: existsSync(file) ? file : null });
  }
  return out;
}

/** Exported symbols of every entry of one package: `{ program, checker, exports: [{ entry, name, symbol }] }` (aliases resolved). */
export function loadPackage(pkgDir) {
  const entries = packageEntries(pkgDir).filter((e) => e.file);
  const program = ts.createProgram(
    entries.map((e) => e.file),
    {
      noEmit: true,
      skipLibCheck: true,
      allowJs: false,
      types: [],
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      module: ts.ModuleKind.ESNext,
    },
  );
  const checker = program.getTypeChecker();
  const exports = [];
  for (const { entry, file } of entries) {
    const sf = program.getSourceFile(file);
    const mod = sf && checker.getSymbolAtLocation(sf);
    if (!mod) continue;
    for (const sym of checker.getExportsOfModule(mod)) {
      const symbol = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
      exports.push({ entry, name: sym.name, symbol });
    }
  }
  return { program, checker, exports, entries };
}

/** The `.d.ts` source position of a node as `{ file, line }` (1-based). */
export function position(node) {
  const sf = node.getSourceFile();
  return { file: sf.fileName, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 };
}

export { ts };
