import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer, type WebSocket } from "ws";

/** One tool as the page reports it. */
export type BridgeToolInfo = { name: string; description: string; inputSchema: Record<string, unknown> };
/** What the page returns for a call. */
export type BridgeToolResult = { content: string; isError?: boolean };

export type AudiorectiveMcpOptions = {
  /** WebSocket port the page connects to. Default 7777; 0 picks a free one (see `port`). */
  port?: number;
  /** Interface to listen on. Default 127.0.0.1: only pages on this machine can connect. */
  host?: string;
  /** How long to wait for the page to answer one call, in ms. Default 120000 (renders are slow). */
  timeoutMs?: number;
  /** How long `tools/list` waits for a page to connect before answering with an empty list, in ms. Default 10000. */
  waitMs?: number;
};

type Pending = { socket: WebSocket; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** The WebSocket close code the server sends to a page that a newer page replaced. `connectMcpBridge` does not reconnect on it. */
export const REPLACED_CODE = 4000;
const REPLACED_REASON = "replaced by another page";

const NO_PAGE =
  "No audiorective page is connected. Open the app in a browser with connectMcpBridge pointing at this server's WebSocket port, then try again.";

function describeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string")
    return (error as { message: string }).message;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/** The WebSocket side: accepts one page at a time (the newest) and relays `list` and `call` frames to it. */
export class PageBridge {
  private readonly wss: WebSocketServer;
  private page: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly timeoutMs: number;
  private readonly listeners = new Set<() => void>();
  /** How long `tools/list` waits for a page, in ms. */
  readonly waitMs: number;

  private constructor(wss: WebSocketServer, timeoutMs: number, waitMs: number) {
    this.wss = wss;
    this.timeoutMs = timeoutMs;
    this.waitMs = waitMs;
    wss.on("connection", (socket) => {
      const previous = this.page;
      this.page = socket;
      // A distinct code tells the old page not to reconnect, or two open pages would take turns replacing each other forever.
      previous?.close(REPLACED_CODE, REPLACED_REASON);
      this.notifyChange();
      socket.on("message", (data) => this.receive(String(data)));
      socket.on("close", () => {
        const wasCurrent = this.page === socket;
        if (wasCurrent) this.page = undefined;
        this.failAll(socket, "The page disconnected before it answered.");
        if (wasCurrent) this.notifyChange();
      });
      socket.on("error", () => {});
    });
  }

  /** Starts the WebSocket server on `options.port` (default 7777) bound to `options.host` (default `127.0.0.1`); rejects when the port is taken. */
  static listen(options: Pick<AudiorectiveMcpOptions, "port" | "host" | "timeoutMs" | "waitMs"> = {}): Promise<PageBridge> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port: options.port ?? 7777, host: options.host ?? "127.0.0.1" });
      wss.once("error", reject);
      wss.once("listening", () => {
        wss.off("error", reject);
        wss.on("error", () => {});
        resolve(new PageBridge(wss, options.timeoutMs ?? 120_000, options.waitMs ?? 10_000));
      });
    });
  }

  /** The port the server listens on (useful when `port: 0` picked a free one). */
  get port(): number {
    const address = this.wss.address();
    return typeof address === "object" && address ? address.port : 0;
  }

  /** True while a page is connected. */
  get connected(): boolean {
    return this.page !== undefined && this.page.readyState === this.page.OPEN;
  }

  /** Calls `listener` whenever a page connects or the current page disconnects. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyChange(): void {
    for (const listener of this.listeners) listener();
  }

  /** Resolves true once a page is connected, or false after `ms`. */
  waitForPage(ms: number): Promise<boolean> {
    if (this.connected) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (value: boolean) => {
        clearTimeout(timer);
        off();
        resolve(value);
      };
      const timer = setTimeout(() => done(false), ms);
      const off = this.onChange(() => {
        if (this.connected) done(true);
      });
    });
  }

  private receive(text: string): void {
    let frame: { id?: unknown; result?: unknown; error?: unknown };
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof frame.id !== "number") return;
    const entry = this.pending.get(frame.id);
    if (!entry) return;
    this.pending.delete(frame.id);
    clearTimeout(entry.timer);
    if (frame.error !== undefined && frame.error !== null) entry.reject(new Error(describeError(frame.error)));
    else entry.resolve(frame.result);
  }

  private failAll(socket: WebSocket, message: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.socket !== socket) continue;
      clearTimeout(entry.timer);
      entry.reject(new Error(message));
      this.pending.delete(id);
    }
  }

  private request(frame: Record<string, unknown>): Promise<unknown> {
    const page = this.page;
    if (!page || page.readyState !== page.OPEN) return Promise.reject(new Error(NO_PAGE));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The page did not answer within ${this.timeoutMs} ms.`));
      }, this.timeoutMs);
      this.pending.set(id, { socket: page, resolve, reject, timer });
      page.send(JSON.stringify({ id, ...frame }));
    });
  }

  /** Asks the connected page for its tool list; rejects when no page is connected or it does not answer within `timeoutMs` ms. */
  async list(): Promise<BridgeToolInfo[]> {
    return (await this.request({ method: "list" })) as BridgeToolInfo[];
  }

  /** Calls tool `name` on the connected page with `args`; rejects when no page is connected or it does not answer within `timeoutMs` ms. */
  async call(name: string, args: unknown): Promise<BridgeToolResult> {
    return (await this.request({ method: "call", name, args })) as BridgeToolResult;
  }

  /** Terminates the page socket and closes the server; resolves once the server is closed. */
  close(): Promise<void> {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    for (const client of this.wss.clients) client.terminate();
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }
}

const INSTRUCTIONS =
  "The tools come from an audiorective page connected over WebSocket. If the tool list is empty, no page is connected yet: ask the person to open the app, then list tools again (the server sends tools/list_changed when a page connects). Calls without a page return an error.";

/** An MCP server whose tools are whatever the connected page serves. It holds no DAW logic. Connect it to a transport. */
export function createMcpServer(bridge: PageBridge): Server {
  const server = new Server(
    { name: "audiorective-mcp", version: "2.3.2" },
    { capabilities: { tools: { listChanged: true } }, instructions: INSTRUCTIONS },
  );
  bridge.onChange(() => {
    // Before a transport is connected, or after it closed, there is nobody to tell.
    server.sendToolListChanged().catch(() => {});
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // No page after the wait: an empty list is honest, and the instructions and calls explain why.
    if (!(await bridge.waitForPage(bridge.waitMs))) return { tools: [] };
    // A page that is connected but fails (or leaves mid-list) is an error the agent can read, not an empty list.
    return { tools: await bridge.list() };
  });
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      const result = await bridge.call(params.name, params.arguments ?? {});
      return { content: [{ type: "text" as const, text: result.content }], isError: result.isError === true };
    } catch (error) {
      return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });
  return server;
}
