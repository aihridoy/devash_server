const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const express = require("express");
const rateLimit = require("express-rate-limit");

/**
 * Single-admin authentication.
 *
 * There is one account, and it is the site owner. So there is no registration
 * route, no password reset and no user collection — every one of those is an
 * attack surface that exists only to serve users this application does not
 * have. The credentials live in the environment: ADMIN_EMAIL and
 * ADMIN_PASSWORD_HASH, the latter produced by scripts/hash-password.js.
 *
 * The password itself is never stored, never logged, and never leaves the
 * browser except as the body of the login request over TLS.
 */

const SESSION_COOKIE = "devash_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const isProduction = () => process.env.NODE_ENV === "production";

/**
 * Fail at boot rather than at the first login attempt.
 *
 * A missing SESSION_SECRET would otherwise mean sessions signed with
 * "undefined" — forgeable by anyone who noticed. That must never be a runtime
 * surprise on a deploy.
 */
const requireEnvironment = () => {
  const missing = ["ADMIN_EMAIL", "ADMIN_PASSWORD_HASH", "SESSION_SECRET"].filter(
    (name) => !process.env[name],
  );

  if (missing.length > 0) {
    throw new Error(
      `Admin auth is not configured: ${missing.join(", ")} missing. ` +
        `Generate a hash with "node scripts/hash-password.js" and set these in Render.`,
    );
  }

  if (process.env.SESSION_SECRET.length < 32) {
    throw new Error(
      "SESSION_SECRET must be at least 32 characters. Generate one with " +
        '"node -e \\"console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))\\"".',
    );
  }
};

/**
 * A session token: a payload and an HMAC over it.
 *
 * Deliberately not a JWT. A JWT names its own algorithm in a header that the
 * verifier is then tempted to trust, which is the source of the whole family
 * of alg-confusion bugs. Here there is one algorithm, it is not read from the
 * token, and the only thing the token carries is who and until when.
 */
const sign = (payload) => {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", process.env.SESSION_SECRET)
    .update(body)
    .digest("base64url");

  return `${body}.${signature}`;
};

const verify = (token) => {
  if (typeof token !== "string" || !token.includes(".")) return null;

  const [body, signature] = token.split(".");
  if (!body || !signature) return null;

  const expected = crypto
    .createHmac("sha256", process.env.SESSION_SECRET)
    .update(body)
    .digest("base64url");

  // Compared byte by byte in constant time: a plain === leaks, through how
  // long it takes to fail, how much of a forged signature was correct.
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length) return null;
  if (!crypto.timingSafeEqual(given, want)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (!payload?.exp || Date.now() > payload.exp) return null;
  return payload;
};

const cookieOptions = () => ({
  httpOnly: true, // Unreadable from JavaScript, so an XSS cannot steal it.
  secure: isProduction(),
  // The browser reaches the API through Netlify's proxy at /api on the site's
  // own origin, so this cookie is first-party and "lax" is enough. Third-party
  // cookies are being phased out by browsers; routing through the proxy avoids
  // depending on them at all.
  sameSite: "lax",
  path: "/",
  maxAge: SESSION_TTL_MS,
});

/**
 * Login is the one endpoint where guessing is the attack, so it gets a limit
 * far below anything a person typing their own password would reach.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: {
    success: false,
    message: "Too many sign-in attempts. Try again in a few minutes.",
  },
});

const requireAuth = (req, res, next) => {
  const session = verify(req.cookies?.[SESSION_COOKIE]);

  if (!session) {
    return res.status(401).json({ success: false, message: "Not signed in." });
  }

  req.admin = { email: session.sub };
  next();
};

const createAuthRouter = () => {
  const router = express.Router();

  router.post("/login", loginLimiter, async (req, res) => {
    const { email, password } = req.body ?? {};

    if (typeof email !== "string" || typeof password !== "string") {
      return res
        .status(400)
        .json({ success: false, message: "Email and password are required." });
    }

    const emailMatches =
      email.trim().toLowerCase() === process.env.ADMIN_EMAIL.trim().toLowerCase();

    // The hash is compared even when the email is wrong. Skipping it would let
    // an attacker tell a valid address from an invalid one by how fast the
    // request came back, which is how you turn a login into an account
    // enumerator.
    const passwordMatches = await bcrypt.compare(
      password,
      process.env.ADMIN_PASSWORD_HASH,
    );

    if (!emailMatches || !passwordMatches) {
      // One message for both failures, for the same reason.
      return res
        .status(401)
        .json({ success: false, message: "Those credentials are not right." });
    }

    res.cookie(
      SESSION_COOKIE,
      sign({ sub: process.env.ADMIN_EMAIL, exp: Date.now() + SESSION_TTL_MS }),
      cookieOptions(),
    );

    res.json({ success: true, admin: { email: process.env.ADMIN_EMAIL } });
  });

  router.get("/me", requireAuth, (req, res) => {
    res.json({ success: true, admin: req.admin });
  });

  router.post("/logout", (req, res) => {
    res.clearCookie(SESSION_COOKIE, { ...cookieOptions(), maxAge: undefined });
    res.json({ success: true });
  });

  return router;
};

module.exports = {
  SESSION_COOKIE,
  createAuthRouter,
  requireAuth,
  requireEnvironment,
  sign,
  verify,
};
