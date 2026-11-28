import { describe, expect, test } from "vitest";
import { MCP_TOOL_CATEGORIES, bridgeProtocols, callableOperations, operationRefusal, resolveAllow, restrictTools } from "../src/mcp-policy";

describe("mcp policy helpers", () => {
  test("every category is on by default and a typo is refused", () => {
    expect([...resolveAllow(undefined)]).toEqual([...MCP_TOOL_CATEGORIES]);
    expect([...resolveAllow([])]).toEqual([]);
    expect(() => resolveAllow(["read", "write" as never])).toThrow(/unknown permission "write" in allow. Use read, edit, export, operations/);
  });

  test("run_operation stays listed under read alone, and is refused for operations that change the project", () => {
    const tools = [
      { name: "a", category: "read" as const },
      { name: "b", category: "edit" as const },
      { name: "c", category: "operations" as const },
    ];
    const names = (allow: Parameters<typeof resolveAllow>[0]) => restrictTools(tools, resolveAllow(allow)).map((tool) => tool.name);
    expect(names(["read"])).toEqual(["a", "c"]);
    expect(names(["edit"])).toEqual(["b"]);
    expect(names(["operations"])).toEqual(["c"]);
    expect(names([])).toEqual([]);

    const read = resolveAllow(["read"]);
    expect(operationRefusal(read, true, "q")).toBeUndefined();
    expect(operationRefusal(read, false, "m")).toMatch(/operation "m" because it changes the project \(permission "operations" is off\)/);
    const operations = resolveAllow(["operations"]);
    expect(operationRefusal(operations, false, "m")).toBeUndefined();
    expect(operationRefusal(operations, true, "q")).toMatch(/permission "read" is off/);
  });

  test("read_project advertises only the operations that would run", () => {
    const view = { title: "t", operations: [{ name: "q", readOnly: true }, { name: "m", readOnly: false }, { name: "legacy" }] };
    expect(callableOperations(view, resolveAllow(["read"])).operations.map((operation) => operation.name)).toEqual(["q"]);
    expect(callableOperations(view, resolveAllow(["operations"])).operations.map((operation) => operation.name)).toEqual(["m", "legacy"]);
    expect(callableOperations(view, resolveAllow(undefined)).operations).toHaveLength(3);
    expect(callableOperations(view, resolveAllow(["read"])).title).toBe("t");
  });

  test("the token travels as the second WebSocket subprotocol, matching the server's constants", () => {
    const token = "abcdefghijklmnopqrstuvwxyz0123456789_-AB";
    expect(bridgeProtocols(token)).toEqual(["audiorective.v1", `audiorective.token.${token}`]);
    expect(() => bridgeProtocols("short")).toThrow(/connectMcpBridge: token must be at least 22 characters/);
    expect(() => bridgeProtocols("has spaces in it, 22+ characters long")).toThrow(/token must be/);
  });
});
