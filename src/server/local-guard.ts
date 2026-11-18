import net from "node:net";
import type { RequestHandler } from "express";

// Both servers have no authentication and are meant for the local machine. A web page the user happens to open can still
// reach a loopback server in two ways, and this guard closes both:
// - DNS rebinding: the page's own host name is made to resolve to 127.0.0.1, so its requests count as same-origin. The
//   Host header then carries that host name, so only IP literals and `localhost` names are accepted.
// - Cross-site requests: a browser always sends `Origin` on them (also on simple POSTs without a body that need no
//   preflight), so a request whose Origin is not the server's own origin is refused.
// - Side effects of plain GETs (an <img> or <script> tag points at a GET route and carries no Origin): a browser also sends
//   `Sec-Fetch-Site`, and a request that is not from this server's own page (or typed into the address bar) is refused.
// Requests without these headers (curl, the agents, the CLI) are not browser page requests and pass.

// A Host header is `name` or `[v6]`, with an optional port: nothing else (no userinfo, no path).
const HOST_SHAPE = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::\d{1,5})?$/;

/** The host name part of a Host header value, or null when it is not a valid host. */
function hostnameOf(host: string): string | null {
  if (!HOST_SHAPE.test(host)) return null;
  try {
    const { hostname } = new URL(`http://${host}`);
    return hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  } catch {
    return null;
  }
}

/** IP literals and `localhost` (and `*.localhost`) are accepted; any other name could be one that rebinds to this machine. */
export function isAcceptedHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = hostnameOf(host);
  if (name === null) return false;
  return net.isIP(name) !== 0 || name === "localhost" || name.endsWith(".localhost");
}

/** Whether an Origin header is this server's own origin (the same host and port as the Host header). */
export function isSameOrigin(origin: string, host: string): boolean {
  try {
    const url = new URL(origin);
    // This server is plain http: a page of this server has an http origin.
    return url.protocol === "http:" && url.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false; // includes the opaque origin "null"
  }
}

export function createLocalRequestGuard(): RequestHandler {
  return (req, res, next) => {
    const host = req.headers.host;
    if (!isAcceptedHost(host)) {
      res.status(403).json({ error: "forbidden_host", message: "This server only answers requests addressed to localhost or an IP address." });
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !isSameOrigin(origin, host as string)) {
      res.status(403).json({ error: "forbidden_origin", message: "Cross-origin requests are not allowed." });
      return;
    }
    // Sec-Fetch-Site: "same-origin" (the page of this server) and "none" (typed into the address bar) are fine; "same-site" (another port of
    // the same host) and "cross-site" are not. The exception is the person following a link to this server's page (a top-level navigation:
    // mode "navigate", destination "document"): it loads the page, which the Host/Origin checks above already allow, and the settings
    // screen's "open the ship" link is exactly that. An <img>, <script>, fetch or EventSource is never a navigation.
    const site = req.headers["sec-fetch-site"];
    const isPageNavigation = req.method === "GET" && req.headers["sec-fetch-mode"] === "navigate" && req.headers["sec-fetch-dest"] === "document";
    if (site !== undefined && site !== "same-origin" && site !== "none" && !isPageNavigation) {
      res.status(403).json({ error: "forbidden_site", message: "Requests from other pages are not allowed." });
      return;
    }
    next();
  };
}
