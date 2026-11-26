import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Project, ProjectSession } from "../src/project";
import {
  EDIT_METHODS_NOT_OFFERED,
  EDIT_OPERATION_FOR_METHOD,
  EDIT_OPERATION_WITHOUT_METHOD,
  PROJECT_EDIT_FIELDS,
  PROJECT_EDIT_TYPES,
} from "../src/project-edits";
import { EDIT_OP_SPECS } from "../src/mcp";
import * as modelSource from "../src/model.ts?raw";
import * as sessionSource from "../src/session.ts?raw";
import { publicMembers } from "../../../scripts/tracking-coverage.mjs";

const docs = readFileSync(new URL("../../../docs/mcp.md", import.meta.url), "utf8");

const methods = (ctor: { name: string }, source: string) =>
  (publicMembers(ctor, source) as { name: string; kind: string }[]).filter(({ kind }) => kind === "method").map(({ name }) => `${ctor.name}.${name}`);

describe("apply_edits covers every editing method", () => {
  const all = [...methods(Project, modelSource.default), ...methods(ProjectSession, sessionSource.default)];

  it("maps each public method of Project and ProjectSession to an operation or explains why it has none", () => {
    const problems: string[] = [];
    for (const method of all) {
      const mapped = method in EDIT_OPERATION_FOR_METHOD;
      const excluded = method in EDIT_METHODS_NOT_OFFERED;
      if (!mapped && !excluded) problems.push(`${method} has no apply_edits operation and no reason in EDIT_METHODS_NOT_OFFERED`);
      if (mapped && excluded) problems.push(`${method} is both mapped and excluded`);
      if (excluded && !EDIT_METHODS_NOT_OFFERED[method].trim()) problems.push(`${method} is excluded without a reason`);
    }
    for (const method of [...Object.keys(EDIT_OPERATION_FOR_METHOD), ...Object.keys(EDIT_METHODS_NOT_OFFERED)])
      if (!all.includes(method)) problems.push(`${method} is listed but is not a public method`);
    expect(problems).toEqual([]);
  });

  it("gives every operation type a method or a reason, and every mapping a real operation", () => {
    const viaMethod = new Set(Object.values(EDIT_OPERATION_FOR_METHOD));
    for (const type of PROJECT_EDIT_TYPES)
      expect(viaMethod.has(type) || type in EDIT_OPERATION_WITHOUT_METHOD, `${type} has neither a method nor a reason`).toBe(true);
    for (const type of viaMethod) expect(PROJECT_EDIT_TYPES).toContain(type);
  });

  it("lists every method and every operation in the docs/mcp.md coverage table", () => {
    const missing = [
      ...all.filter((method) => !docs.includes(`| \`${method}\``)),
      ...PROJECT_EDIT_TYPES.filter((type) => !docs.includes(`| \`${type}\``)),
    ];
    expect(missing).toEqual([]);
  });

  it("keeps the tool schema's fields equal to the fields the runner accepts", () => {
    expect(Object.keys(EDIT_OP_SPECS).sort()).toEqual([...PROJECT_EDIT_TYPES].sort());
    for (const type of PROJECT_EDIT_TYPES) {
      expect(Object.keys(EDIT_OP_SPECS[type].properties).sort(), type).toEqual([...PROJECT_EDIT_FIELDS[type]].sort());
      for (const required of EDIT_OP_SPECS[type].required ?? []) expect(PROJECT_EDIT_FIELDS[type], type).toContain(required);
    }
  });
});
