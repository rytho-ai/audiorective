// Test support: proves a tracking test exercises every public member of a class.
// A test wraps each instance in `watch(...)`, which records the members the test touches;
// `coverageGaps(...)` then compares them with the class's public prototype surface, so a command or
// reader added later fails the test until a row covers it or the exclusion list explains why not.

/** Wrap `target` so every member read through it is recorded in `touched`; calls run on the real object. */
export function watch(target, touched) {
  return new Proxy(target, {
    get(real, key) {
      const value = Reflect.get(real, key, real);
      if (typeof key === "string") touched.add(key);
      return typeof value === "function" ? value.bind(real) : value;
    },
  });
}

/** Names declared `private` or `protected` inside the class body of `source`. */
function nonPublicNames(source, className) {
  const start = source.search(new RegExp(`\\bclass\\s+${className}\\b`));
  const end = source.indexOf("\n}\n", start);
  const body = source.slice(start, end < 0 ? undefined : end);
  const names = new Set();
  for (const m of body.matchAll(/\b(?:private|protected)\s+(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?(?:readonly\s+)?([A-Za-z_$][\w$]*)/g))
    names.add(m[1]);
  return names;
}

/** Public methods and accessors declared on the class itself (inherited members belong to their own class). */
export function publicMembers(ctor, source) {
  const hidden = nonPublicNames(source, ctor.name);
  return Object.entries(Object.getOwnPropertyDescriptors(ctor.prototype))
    .filter(([name]) => name !== "constructor" && !name.startsWith("_") && !hidden.has(name))
    .map(([name, d]) => ({ name, kind: d.get || d.set ? "accessor" : "method" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * @param ctor the class under test
 * @param source its module source text (`import src from "../src/X.ts?raw"`)
 * @param touched members the tracking test touched through `watch`
 * @param excluded `{ member: reason }` for members that need no tracking row
 * @returns problems to assert empty
 */
export function coverageGaps(ctor, source, touched, excluded = {}) {
  const members = publicMembers(ctor, source).map((m) => m.name);
  const problems = [];
  for (const name of members) {
    if (!touched.has(name) && !(name in excluded)) problems.push(`${ctor.name}.${name} is not exercised by any tracking row and is not excluded`);
  }
  for (const [name, reason] of Object.entries(excluded)) {
    if (!members.includes(name)) problems.push(`${ctor.name}.${name} is excluded but is not a public member`);
    else if (touched.has(name)) problems.push(`${ctor.name}.${name} is exercised, so its exclusion should be removed`);
    else if (!reason.trim()) problems.push(`${ctor.name}.${name} is excluded without a reason`);
  }
  return problems;
}
