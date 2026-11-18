import { afterEach, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./testing/http.js";
import { createSecurityHeaders } from "./security-headers.js";

let server: TestServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

describe("createSecurityHeaders", () => {
  it("every response carries a policy that allows only the server's own origin, no remote images, no framing", async () => {
    server = await startTestServer((app) => { app.use(createSecurityHeaders()); app.get("/x", (_req, res) => { res.json({}); }); });
    const res = await fetch(`${server.baseUrl}/x`);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
});
