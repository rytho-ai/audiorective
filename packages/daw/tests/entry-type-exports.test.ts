import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, test } from "vitest";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = resolve(packageDir, "src") + "/";
const entries = ["index", "project", "selection", "dawproject", "runtime-entry", "mcp"].map((name) => resolve(srcDir, `${name}.ts`));

/**
 * Rule: a type named in the signature of an exported declaration must itself be exported from an entry of the package,
 * or a consumer cannot write the type of a value the API gives them (`ProjectEditReceipt["song"][number]`).
 * Checked on the sources with the TypeScript compiler API, over every entry in `package.json` "exports".
 */
function missingTypes(): string[] {
  const config = ts.readConfigFile(resolve(packageDir, "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageDir);
  const program = ts.createProgram({ rootNames: entries, options: { ...parsed.options, noEmit: true, emitDeclarationOnly: false } });
  const checker = program.getTypeChecker();
  const resolveAlias = (symbol: ts.Symbol) => (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);

  const exported = new Set<ts.Symbol>();
  const exportedDeclarations: { entry: string; symbol: ts.Symbol }[] = [];
  for (const entry of entries) {
    const source = program.getSourceFile(entry);
    if (!source) throw new Error(`entry ${entry} is not in the program`);
    const moduleSymbol = checker.getSymbolAtLocation(source);
    if (!moduleSymbol) continue;
    for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
      const real = resolveAlias(symbol);
      exported.add(real);
      exportedDeclarations.push({ entry: entry.slice(srcDir.length), symbol: real });
    }
  }

  const isInternal = (node: ts.Node) => ts.getJSDocTags(node).some((tag) => tag.tagName.text === "internal");
  const found = new Map<string, string>();

  const check = (name: ts.EntityName, owner: string) => {
    const at = ts.isQualifiedName(name) ? name.right : name;
    const symbol = checker.getSymbolAtLocation(at);
    if (!symbol) return;
    const real = resolveAlias(symbol);
    const typeLike = ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Class | ts.SymbolFlags.Enum;
    if (!(real.flags & typeLike) || real.flags & ts.SymbolFlags.TypeParameter) return;
    const declaration = real.declarations?.[0];
    if (!declaration || !declaration.getSourceFile().fileName.startsWith(srcDir) || !ts.isSourceFile(declaration.parent)) return;
    if (exported.has(real)) return;
    found.set(real.name, `${real.name} (declared in ${declaration.getSourceFile().fileName.slice(srcDir.length)}) is used by ${owner}`);
  };

  const walk = (node: ts.Node, owner: string) => {
    if (isInternal(node)) return;
    if ((ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)) return;
    // A function body is not part of the signature.
    if (ts.isBlock(node)) return;
    if (ts.isTypeReferenceNode(node)) check(node.typeName, owner);
    else if (ts.isExpressionWithTypeArguments(node) && ts.isIdentifier(node.expression)) check(node.expression, owner);
    else if (ts.isTypeQueryNode(node)) check(node.exprName, owner);
    ts.forEachChild(node, (child) => walk(child, owner));
  };

  for (const { entry, symbol } of exportedDeclarations) {
    for (const declaration of symbol.declarations ?? []) {
      if (!declaration.getSourceFile().fileName.startsWith(srcDir)) continue;
      // `export const x = expr` has no written signature: only its annotation counts, and an inferred type is checked through its own declaration.
      if (ts.isVariableDeclaration(declaration)) {
        if (declaration.type) walk(declaration.type, `${entry} export ${symbol.name}`);
        continue;
      }
      walk(declaration, `${entry} export ${symbol.name}`);
    }
  }
  return [...found.values()].sort();
}

test("every type named in an exported signature is exported from an entry of the package", () => {
  expect(missingTypes()).toEqual([]);
}, 120_000);
