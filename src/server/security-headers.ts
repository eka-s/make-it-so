import type { RequestHandler } from "express";

// Headers that limit what the page served by the server may do. Everything the UI needs comes from the server itself (scripts, styles,
// fonts, icons, the API), so nothing else is allowed: a page that is somehow made to show attacker-chosen content cannot load
// anything from, or send anything to, another address.
// `style-src` keeps 'unsafe-inline' because the UI sets style attributes (sizes and positions that are computed).
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function createSecurityHeaders(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  };
}
