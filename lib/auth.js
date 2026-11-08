/* Sign-in, limited to one email domain. Two ways in, both ending in the same
   HMAC-signed session cookie:
   - Team password (functions/api/auth/password.js): email at the domain +
     shared TEAM_PASSWORD secret. The email is self-reported.
   - "Sign in with Google" (optional, shown only when GOOGLE_CLIENT_ID is
     set): login.html POSTs Google's signed ID token to /api/auth/google and
     we verify signature, client ID, expiry, verified email and Workspace
     domain ourselves. The email is verified.

   functions/_middleware.js checks the cookie on EVERY request (pages,
   patient data files, API), so nothing is readable signed-out.

   Config (wrangler.toml [vars]):
     GOOGLE_CLIENT_ID      optional OAuth client ID (…apps.googleusercontent.com) — public
     ALLOWED_EMAIL_DOMAIN  e.g. "aamrut.com"
   Secrets (`wrangler pages secret put <NAME>`):
     SESSION_SECRET        random string that signs session cookies
     TEAM_PASSWORD         shared password for the team-password sign-in
   Local dev only (.dev.vars, never in production):
     DEV_USER_EMAIL        honoured only when the request host is localhost

   Single sign-on with the other portals (Answer QA, the Hub): all three sign
   the same {email, exp} payload with the same SESSION_SECRET, so the only
   thing stopping one cookie working everywhere is scope. Two *.pages.dev
   hosts can't share a cookie, so SSO switches on once the sites sit on a
   real domain:
     SESSION_COOKIE_DOMAIN unset      -> issue "pr_session", host-only (as before)
     SESSION_COOKIE_DOMAIN=aamrut.com -> issue "aamrut_session" for that domain
   Both names are always accepted, so turning this on or off never signs
   anyone out. */

const SESSION_COOKIE = "pr_session";
const SHARED_COOKIE = "aamrut_session";
const SESSION_TTL_SECONDS = 7 * 24 * 3600;
const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}
function bytesToB64url(bytes) {
  let bin = "";
  new Uint8Array(bytes).forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function allowedDomain(env) {
  return (env.ALLOWED_EMAIL_DOMAIN || "").toLowerCase();
}

/* ---- Google ID token verification ---- */
let googleKeys = { keys: null, fetchedAt: 0 };
async function googleCerts() {
  if (!googleKeys.keys || Date.now() - googleKeys.fetchedAt > 3600_000) {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/certs");
    if (!res.ok) throw new Error(`Google certs fetch failed: ${res.status}`);
    googleKeys = { keys: (await res.json()).keys || [], fetchedAt: Date.now() };
  }
  return googleKeys.keys;
}

/** Returns the verified @domain email from a Google ID token, or null. */
export async function verifyGoogleIdToken(token, env) {
  if (!env.GOOGLE_CLIENT_ID || typeof token !== "string") return null;
  const [h, p, sig] = token.split(".");
  if (!h || !p || !sig) return null;
  const header = JSON.parse(dec.decode(b64urlToBytes(h)));
  const payload = JSON.parse(dec.decode(b64urlToBytes(p)));
  if (header.alg !== "RS256") return null;

  const jwk = (await googleCerts()).find(k => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(sig), enc.encode(`${h}.${p}`))) return null;

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) return null;
  if (payload.aud !== env.GOOGLE_CLIENT_ID) return null;
  if (!GOOGLE_ISSUERS.includes(payload.iss)) return null;
  if (payload.email_verified !== true) return null;

  const email = String(payload.email || "").toLowerCase();
  const domain = allowedDomain(env);
  // `hd` is only set for Workspace accounts, so a personal Gmail can't pass.
  if (!domain || payload.hd !== domain || !email.endsWith(`@${domain}`)) return null;
  return email;
}

/* ---- Our session cookie: base64url(JSON {email, exp}) + "." + HMAC ---- */
async function hmacKey(env) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new Error("SESSION_SECRET is missing or too short");
  return crypto.subtle.importKey("raw", enc.encode(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/* Which cookie this deployment issues, and the Domain attribute it carries. */
function cookieSpec(env) {
  const domain = (env.SESSION_COOKIE_DOMAIN || "").trim();
  return domain
    ? { name: SHARED_COOKIE, attrs: `; Domain=${domain}` }
    : { name: SESSION_COOKIE, attrs: "" };
}

export async function sessionCookie(email, env) {
  const body = bytesToB64url(enc.encode(JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS })));
  const sig = bytesToB64url(await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(body)));
  const { name, attrs } = cookieSpec(env);
  return `${name}=${body}.${sig}; Path=/${attrs}; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

/* Signing out clears both names, so one click works whichever is in use. */
export function clearedSessionCookie(env = {}) {
  const domain = (env.SESSION_COOKIE_DOMAIN || "").trim();
  const cleared = [`${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`];
  if (domain) cleared.push(`${SHARED_COOKIE}=; Path=/; Domain=${domain}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  return cleared;
}

async function verifyCookieValue(value, env) {
  const [body, sig] = String(value).split(".");
  if (!body || !sig) return null;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(env), b64urlToBytes(sig), enc.encode(body));
  if (!ok) return null;
  const { email, exp } = JSON.parse(dec.decode(b64urlToBytes(body)));
  if (!exp || exp < Math.floor(Date.now() / 1000)) return null;
  const domain = allowedDomain(env);
  if (!domain || typeof email !== "string" || !email.endsWith(`@${domain}`)) return null;
  return email;
}

async function emailFromSession(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  // The shared cookie wins: if a reviewer has both, the SSO one is the
  // fresher intent, and a stale host-only cookie shouldn't shadow it.
  for (const name of [SHARED_COOKIE, SESSION_COOKIE]) {
    const m = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    if (!m) continue;
    const email = await verifyCookieValue(m[1], env);
    if (email) return email;
  }
  return null;
}

/** Returns the caller's email, or null if they aren't a signed-in, allowed user. */
export async function authenticatedEmail(request, env) {
  const host = new URL(request.url).hostname;
  if (env.DEV_USER_EMAIL && (host === "localhost" || host === "127.0.0.1")) {
    return env.DEV_USER_EMAIL;
  }
  try { return await emailFromSession(request, env); }
  catch (e) { console.log("Session check error", String(e)); return null; }
}

export function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}
