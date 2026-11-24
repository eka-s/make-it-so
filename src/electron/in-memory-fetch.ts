import http from "node:http";
import { duplexPair, Readable } from "node:stream";
import type { Duplex } from "node:stream";

/**
 * A request handler (an Express app) that is served over an in-memory connection instead of a TCP port.
 * The page is not on the network, so there is nothing to address a port or a host name to.
 */
export type InMemoryFetch = (request: Request) => Promise<Response>;

// Headers a browser attaches to say where a request came from. Over the network the local-request guard (local-guard.ts) uses them to refuse
// pages of other origins; in memory only this shell's own page can send a request, so they carry no information and would only
// be refused (the page's origin is not an `http:` origin of this server).
const BROWSER_ORIGIN_HEADERS = /^(origin|referer|sec-fetch-.*)$/i;
// A response with one of these statuses has no body, and the Response constructor refuses to be given one (even an empty stream).
const NO_BODY_STATUSES = new Set([204, 205, 304]);
// Hop-by-hop headers describe the in-memory HTTP/1.1 connection, not the response the page receives.
const HOP_BY_HOP_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding"]);

/** `http` calls socket methods that a plain duplex stream does not have; they have no meaning for an in-memory connection. */
function asSocketLike(side: Duplex): Duplex {
  for (const method of ["setNoDelay", "setKeepAlive", "setTimeout", "ref", "unref"]) {
    (side as unknown as Record<string, unknown>)[method] ??= function (this: Duplex) { return this; };
  }
  return side;
}

/**
 * Serves a `Request` with `handler` through Node's real HTTP implementation, so streaming bodies (SSE), aborts and status codes behave
 * exactly as over a port.
 */
export function createInMemoryFetch(handler: http.RequestListener): InMemoryFetch {
  const server = http.createServer(handler);
  return async (request) => {
    // Nothing is served for a request that is already cancelled.
    request.signal.throwIfAborted();
    // The body is read whole and sent with its length: `http` frames a streamed body only for some methods (not for DELETE), and a body
    // the server cannot see the end of is dropped. Requests of the UI are small, so nothing is gained by streaming them.
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : null;
    const [clientSide, serverSide] = duplexPair();
    asSocketLike(clientSide);
    asSocketLike(serverSide);
    // A duplex pair does not carry a teardown from one end to the other. The page can drop a response body (cancel it, or destroy the stream made from it)
    // without any abort signal, and the handler (an event stream) only learns that the connection is gone when its own end is destroyed.
    clientSide.once("close", () => serverSide.destroy());
    serverSide.once("close", () => clientSide.destroy());
    server.emit("connection", serverSide);

    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      if (!BROWSER_ORIGIN_HEADERS.test(name) && name.toLowerCase() !== "content-length") headers[name] = value;
    });
    if (body) headers["content-length"] = String(body.length);

    return new Promise<Response>((resolve, reject) => {
      const outgoing = http.request({
        createConnection: () => clientSide,
        method: request.method,
        path: url.pathname + url.search,
        // The request is answered per connection: nothing is kept open after the response.
        headers: { ...headers, host: "localhost", connection: "close" },
      }, (incoming) => {
        // Building the Response can throw (an unusable status); that must reject this request, not escape from an event callback and stop the app.
        try {
          const status = incoming.statusCode ?? 500;
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (HOP_BY_HOP_HEADERS.has(name) || value === undefined) continue;
            for (const v of Array.isArray(value) ? value : [value]) responseHeaders.append(name, v);
          }
          const bodiless = request.method === "HEAD" || NO_BODY_STATUSES.has(status);
          const body = bodiless ? null : (Readable.toWeb(incoming) as unknown as ReadableStream);
          // A body nobody reads would hold the connection open.
          if (bodiless) incoming.resume();
          resolve(new Response(body, { status, headers: responseHeaders }));
        } catch (error) {
          incoming.destroy();
          reject(error);
        }
      });
      outgoing.on("error", reject);
      // The page closed the request (an EventSource that was closed): both ends are dropped so the handler sees `close`.
      request.signal.addEventListener("abort", () => {
        outgoing.destroy();
        serverSide.destroy();
      });
      outgoing.end(body ?? undefined);
    });
  };
}
