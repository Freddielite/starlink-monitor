// Security headers for Starlink Monitor's own responses.
//
// The scanner in this app grades other people's sites on exactly these
// headers. It would be difficult to hand a client a report docking them
// for a missing X-Content-Type-Options when the tool that generated it
// doesn't set one either - and the first thing any technically minded
// client will do with a security report is point the tool at the tool.
//
// This is a JSON API, not a page-rendering server, so the set is smaller
// than helmet's defaults and chosen rather than inherited:
//
//  - No CSP script directives worth setting, because this origin never
//    serves HTML that executes anything. A restrictive default-src plus
//    frame-ancestors 'none' covers the real risk, which is someone
//    framing an API error page or a mis-served document.
//  - HSTS only in production. Setting it in development would pin
//    localhost to HTTPS in the developer's browser, which is a genuinely
//    annoying thing to have to undo.
//  - No X-XSS-Protection. It's deprecated, browsers ignore it, and in
//    its last working incarnation it introduced vulnerabilities of its
//    own. A scanner that rewards setting it is testing for cargo cult.
//
// Written directly rather than adding helmet for one middleware's worth
// of headers, consistent with how the rest of this repo handles small
// dependencies.

export function securityHeaders() {
  const isProduction = process.env.NODE_ENV === "production";

  return function securityHeadersMiddleware(req, res, next) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    res.setHeader("Cross-Origin-Resource-Policy", "same-site");

    if (isProduction) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }

    next();
  };
}
