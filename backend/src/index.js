import "dotenv/config";
import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import cors from "cors";
import { pool, migrate } from "./db.js";
import authRouter from "./routes/auth.js";
import kitsRouter from "./routes/kits.js";
import agentRouter from "./routes/agent.js";
import pushRouter from "./routes/push.js";
import cronRouter from "./routes/cron.js";
import telegramRouter from "./routes/telegram.js";
import tokensRouter from "./routes/tokens.js";
import organizationsRouter from "./routes/organizations.js";
import { securityHeaders } from "./middleware/securityHeaders.js";

const app = express();

// These fall back to something that keeps the app running rather than
// refusing to boot - crashing on a misconfigured free-tier deploy is its
// own kind of outage - but a silent fallback is worse than no fallback:
// it makes "insecure" and "working" look identical in the logs.
if (process.env.NODE_ENV === "production" && !process.env.SESSION_SECRET) {
  console.error(
    "SECURITY WARNING: SESSION_SECRET is not set. Falling back to a hardcoded, publicly-known value - " +
      "anyone can forge a valid session cookie for any account. Set SESSION_SECRET in this service's environment."
  );
}
if (process.env.NODE_ENV === "production" && !process.env.CRON_SECRET) {
  console.error(
    "SECURITY WARNING: CRON_SECRET is not set. POST /api/cron/tick is reachable by anyone with no authentication - " +
      "they can trigger billing sweeps and digest sends across every account on demand. Set CRON_SECRET here and " +
      "add the same value to whatever calls this endpoint."
  );
}
if (process.env.NODE_ENV === "production" && !process.env.FRONTEND_URL) {
  console.error(
    "WARNING: FRONTEND_URL is not set. New signups can't complete - the confirmation email has no link to put the " +
      "verification token in. Set FRONTEND_URL to this app's real frontend URL."
  );
}

// Render terminates TLS at a proxy, so without this Express never sees
// the connection as secure and refuses to set secure cookies in
// production, silently breaking login.
app.set("trust proxy", 1);
app.disable("x-powered-by");

const corsOrigin = process.env.CORS_ORIGIN || "*";
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(securityHeaders());

// Org branding (PATCH /api/organizations/:id) can carry a base64 logo,
// comfortably past the ceiling every other endpoint is sized for.
// Registered first so it wins for matching paths.
app.use("/api/organizations", express.json({ limit: "1mb" }));
app.use(express.json({ limit: "64kb" }));

const PgSession = connectPgSimple(session);
app.use(
  session({
    store: new PgSession({ pool, createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET || "dev-only-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 30,
      httpOnly: true,
      // Cross-site cookies (Vercel frontend + Render backend) need
      // sameSite: "none", which browsers only honor over HTTPS.
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    },
  })
);

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.use("/api/auth", authRouter);
app.use("/api/kits", kitsRouter);
// Outside the session world entirely - see the note at the top of
// routes/agent.js on why the kit agent gets its own credential.
app.use("/api/agent", agentRouter);
app.use("/api/push", pushRouter);
app.use("/api/cron", cronRouter);
app.use("/api/telegram", telegramRouter);
app.use("/api/tokens", tokensRouter);
app.use("/api/organizations", organizationsRouter);

const PORT = process.env.PORT || 4000;

migrate()
  .then(() => {
    app.listen(PORT, () => console.log(`Starlink Monitor backend listening on :${PORT}`));
  })
  .catch((err) => {
    console.error("Failed to migrate database:", err);
    process.exit(1);
  });
