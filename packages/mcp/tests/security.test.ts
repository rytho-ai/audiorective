import { request } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { PageBridge, REPLACED_CODE, checkOriginPatterns, createToken, originAllowed, tokenProtocols } from "../src/index";

const BRIDGE = ["audiorective.v1"];
const TOKEN = "test-pairing-token-0123456789";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function start(options: Parameters<typeof PageBridge.listen>[0] = {}) {
  const lines: string[] = [];
  const bridge = await PageBridge.listen({ port: 0, log: (line) => lines.push(line), ...options });
  cleanups.push(() => bridge.close());
  return { bridge, lines };
}

/** Opens a socket and reports how the handshake ended: `{ open: true }` or the HTTP status the server refused with. */
function attempt(port: number, protocols: string[] | undefined, origin: string | undefined) {
  return new Promise<{ open: boolean; status?: number; protocol?: string; socket: WebSocket }>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, protocols, origin === undefined ? {} : { origin });
    cleanups.push(() => socket.terminate());
    socket.on("open", () => resolve({ open: true, protocol: socket.protocol, socket }));
    socket.on("unexpected-response", (_request, response) => resolve({ open: false, status: response.statusCode, socket }));
    socket.on("error", () => {});
  });
}

describe("plain HTTP", () => {
  test("a request that is not a WebSocket upgrade gets 426 Upgrade Required and the connection closes", async () => {
    const { bridge } = await start();
    const answer = await new Promise<{ status?: number; upgrade?: string; connection?: string; body: string }>((resolve, reject) => {
      const call = request({ host: "127.0.0.1", port: bridge.port, path: "/", agent: false }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            upgrade: response.headers.upgrade as string,
            connection: response.headers.connection as string,
            body,
          }),
        );
      });
      call.on("error", reject);
      call.setTimeout(2000, () => call.destroy(new Error("no response")));
      call.end();
    });
    expect(answer.status).toBe(426);
    expect(answer.upgrade).toBe("websocket");
    expect(answer.connection).toBe("close");
    expect(answer.body).toContain("WebSocket");
  });
});

describe("origin patterns", () => {
  test("match exactly, with `:*` for any port and nothing else wild", () => {
    const patterns = ["http://localhost:*", "https://app.example.com"];
    expect(originAllowed("http://localhost:5173", patterns)).toBe(true);
    expect(originAllowed("http://localhost", patterns)).toBe(true);
    expect(originAllowed("HTTP://LOCALHOST:80", patterns)).toBe(true);
    expect(originAllowed("https://app.example.com", patterns)).toBe(true);
    expect(originAllowed("http://localhost.evil.example", patterns)).toBe(false);
    expect(originAllowed("http://localhost:abc", patterns)).toBe(false);
    expect(originAllowed("http://localhost:5173.evil.example", patterns)).toBe(false);
    expect(originAllowed("https://app.example.com:8443", patterns)).toBe(false);
    expect(originAllowed("null", patterns)).toBe(false);
    expect(originAllowed("null", ["null"])).toBe(true);
  });

  test("an entry that is not an origin is refused", () => {
    expect(() => checkOriginPatterns(["*"])).toThrow(/is not an origin/);
    expect(() => checkOriginPatterns(["localhost:5173"])).toThrow(/is not an origin/);
    expect(() => checkOriginPatterns(["http://localhost:5173/"])).toThrow(/is not an origin/);
    expect(() => checkOriginPatterns(["http://*.example.com"])).toThrow(/is not an origin/);
    expect(() => checkOriginPatterns(["http://[::1]:*", "null"])).not.toThrow();
  });

  test("listen rejects a bad entry or a short token", async () => {
    await expect(PageBridge.listen({ port: 0, allowedOrigins: ["*"] })).rejects.toThrow(/is not an origin/);
    await expect(PageBridge.listen({ port: 0, token: "short" })).rejects.toThrow(/pairing token must be/);
    expect(() => tokenProtocols("has space and is long enough......")).toThrow(/pairing token must be/);
  });

  test("the token subprotocols are the literal strings the page side sends", () => {
    expect(tokenProtocols("abcdefghijklmnopqrstuvwxyz0123456789_-AB")).toEqual([
      "audiorective.v1",
      "audiorective.token.abcdefghijklmnopqrstuvwxyz0123456789_-AB",
    ]);
  });

  test("a made token has 256 bits and differs per call", () => {
    expect(createToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createToken()).not.toBe(createToken());
  });

  test("a server has no token unless one is given", async () => {
    const { bridge } = await start();
    expect(bridge.token).toBeUndefined();
    expect((await start({ token: TOKEN })).bridge.token).toBe(TOKEN);
  });
});

describe("handshake", () => {
  test("a default server accepts a loopback page without a token", async () => {
    const { bridge, lines } = await start();
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:3000", "http://[::1]:8080"]) {
      const result = await attempt(bridge.port, BRIDGE, origin);
      expect(result).toMatchObject({ open: true, protocol: "audiorective.v1" });
      result.socket.close();
    }
    expect((await attempt(bridge.port, undefined, "http://localhost:5173")).open).toBe(true);
    expect(lines).toEqual([]);
  });

  test("a server with a token accepts the right one and never echoes it", async () => {
    const { bridge, lines } = await start({ token: TOKEN });
    const result = await attempt(bridge.port, tokenProtocols(TOKEN), "http://localhost:5173");
    expect(result).toMatchObject({ open: true, protocol: "audiorective.v1" });
    expect(result.protocol).not.toContain(TOKEN);
    expect(lines).toEqual([]);
  });

  test("a foreign origin gets 403 and one log line that names it, not the token", async () => {
    const { bridge, lines } = await start();
    const result = await attempt(bridge.port, BRIDGE, "https://evil.example");
    expect(result).toMatchObject({ open: false, status: 403 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"https://evil.example"');
    expect(lines[0]).not.toContain(TOKEN);
    expect(bridge.connected).toBe(false);
  });

  test("a missing Origin gets 403 by default and is accepted with allowMissingOrigin", async () => {
    const strict = await start();
    expect(await attempt(strict.bridge.port, BRIDGE, undefined)).toMatchObject({ open: false, status: 403 });
    expect(strict.lines[0]).toContain("no Origin header");
    const open = await start({ allowMissingOrigin: true });
    expect((await attempt(open.bridge.port, BRIDGE, undefined)).open).toBe(true);
  });

  test("a missing or wrong token gets 403 from a server with a token, even from an allowed origin", async () => {
    const { bridge, lines } = await start({ token: TOKEN });
    expect(await attempt(bridge.port, undefined, "http://localhost:5173")).toMatchObject({ open: false, status: 403 });
    expect(await attempt(bridge.port, ["audiorective.v1"], "http://localhost:5173")).toMatchObject({ open: false, status: 403 });
    expect(await attempt(bridge.port, tokenProtocols("another-token-another-token-12"), "http://localhost:5173")).toMatchObject({
      open: false,
      status: 403,
    });
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toContain("pairing token");
      expect(line).not.toContain(TOKEN);
    }
  });

  test("allowedOrigins replaces the default", async () => {
    const { bridge } = await start({ allowedOrigins: ["https://app.example.com"] });
    expect((await attempt(bridge.port, BRIDGE, "https://app.example.com")).open).toBe(true);
    expect(await attempt(bridge.port, BRIDGE, "http://localhost:5173")).toMatchObject({ open: false, status: 403 });
  });
});

describe("replacing pages", () => {
  test("a foreign page cannot replace a paired page", async () => {
    const { bridge } = await start({ token: TOKEN });
    const paired = await attempt(bridge.port, tokenProtocols(TOKEN), "http://localhost:5173");
    let closeCode: number | undefined;
    paired.socket.on("close", (code) => (closeCode = code));
    await attempt(bridge.port, tokenProtocols(TOKEN), "https://evil.example");
    await attempt(bridge.port, tokenProtocols("wrong-token-wrong-token-wrong1"), "http://localhost:5173");
    await attempt(bridge.port, undefined, "http://localhost:5173");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(closeCode).toBeUndefined();
    expect(paired.socket.readyState).toBe(WebSocket.OPEN);
    expect(bridge.connected).toBe(true);
  });

  test("between two paired pages the newer still wins", async () => {
    const { bridge } = await start({ token: TOKEN });
    const first = await attempt(bridge.port, tokenProtocols(TOKEN), "http://localhost:5173");
    const closed = new Promise<number>((resolve) => first.socket.once("close", (code) => resolve(code)));
    const second = await attempt(bridge.port, tokenProtocols(TOKEN), "http://localhost:5174");
    expect(await closed).toBe(REPLACED_CODE);
    expect(second.socket.readyState).toBe(WebSocket.OPEN);
  });
});
