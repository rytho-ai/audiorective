/**
 * What an agent may do through `mcpTools`, and how a page proves itself to the `@audiorective/mcp` server. Pure helpers: `mcp.ts` calls
 * them, so the rules can be read and tested without a Workspace or a socket.
 */

/**
 * What a tool does, for permission:
 * - `read`: queries that change nothing (`read_project`, `find`, `read_notes`, `read_automation`, `listen`; `listen` returns audio only when `export` is allowed too);
 * - `edit`: changes the open project (`apply_edits`), as one undoable step;
 * - `export`: sends the song out of the page: files through the app's `save` handler (`save_as`, `export_midi`, `export_stems`) and the audio of `listen` (`audio: true`, with `listenAudio`);
 * - `operations`: the app's own named operations (`run_operation`). An operation marked `readOnly` counts as `read` instead.
 */
export type McpToolCategory = "read" | "edit" | "export" | "operations";

/** Every category, in the order the docs list them. */
export const MCP_TOOL_CATEGORIES: readonly McpToolCategory[] = ["read", "edit", "export", "operations"];

/** The WebSocket subprotocol that says a page speaks the bridge protocol; the same string `@audiorective/mcp` selects. */
const BRIDGE_PROTOCOL = "audiorective.v1";
/** The prefix of the subprotocol that carries the pairing token. */
const TOKEN_PROTOCOL_PREFIX = "audiorective.token.";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,}$/;

/**
 * The categories in force for `allow`. Without `allow` every category is on, so an app that never heard of permissions keeps working;
 * the origin check (and the optional pairing token) keeps other web pages out, and permissions are the app's own policy on top.
 * Throws on a name that is not a category, so a typo cannot silently grant or deny a whole group of tools.
 */
export function resolveAllow(allow: readonly McpToolCategory[] | undefined): ReadonlySet<McpToolCategory> {
  if (allow === undefined) return new Set(MCP_TOOL_CATEGORIES);
  for (const category of allow)
    if (!MCP_TOOL_CATEGORIES.includes(category))
      throw new Error(`mcpTools: unknown permission "${String(category)}" in allow. Use ${MCP_TOOL_CATEGORIES.join(", ")}.`);
  return new Set(allow);
}

/**
 * The tools a policy lists. `run_operation` (category `operations`) is also kept under `read` alone, because it can still run the app's
 * `readOnly` operations; `operationRefusal` stops it at the others.
 */
export function restrictTools<T extends { readonly category: McpToolCategory }>(tools: readonly T[], allowed: ReadonlySet<McpToolCategory>): T[] {
  return tools.filter((tool) => allowed.has(tool.category) || (tool.category === "operations" && allowed.has("read")));
}

/** A plain sentence for why `run_operation` may not run an operation, or undefined when it may. A `readOnly` operation needs `read`; any other needs `operations`. */
export function operationRefusal(allowed: ReadonlySet<McpToolCategory>, readOnly: boolean, name: string): string | undefined {
  const needed: McpToolCategory = readOnly ? "read" : "operations";
  if (allowed.has(needed)) return undefined;
  return readOnly
    ? `This app does not let the agent read through operation "${name}" (permission "read" is off).`
    : `This app does not let the agent run operation "${name}" because it changes the project (permission "operations" is off). Tell the person.`;
}

/** `view` with only the operations the agent may call, so `read_project` never advertises one that `run_operation` would refuse. */
export function callableOperations<V extends { readonly operations: readonly { readonly name: string; readonly readOnly?: boolean }[] }>(
  view: V,
  allowed: ReadonlySet<McpToolCategory>,
): V {
  return {
    ...view,
    operations: view.operations.filter((operation) => operationRefusal(allowed, operation.readOnly === true, operation.name) === undefined),
  };
}

/**
 * The WebSocket subprotocols that carry `token` to the server: the bridge protocol and `audiorective.token.<token>`. Offered as
 * subprotocols rather than in the URL so the token stays out of request lines and server logs. Throws on a token the server would not accept.
 */
export function bridgeProtocols(token: string): string[] {
  if (!TOKEN_PATTERN.test(token))
    throw new Error("connectMcpBridge: token must be at least 22 characters of letters, digits, _ and - (use the one the server requires).");
  return [BRIDGE_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`];
}
