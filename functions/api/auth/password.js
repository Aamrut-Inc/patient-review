import { json, sessionCookie } from "../../../lib/auth.js";

// Team-password sign-in. Body: {email, password}. The email must be at
// ALLOWED_EMAIL_DOMAIN; it's self-reported (not verified) and is what flags
// and comments are attributed to. TEAM_PASSWORD is a Pages secret.
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

async function sameSecret(a, b) {
  // Compare digests, not the strings, so timing doesn't leak the password.
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map(s => crypto.subtle.digest("SHA-256", enc.encode(s))));
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}

export async function onRequestPost({ request, env }) {
  if (!env.TEAM_PASSWORD) return json({ error: "Password sign-in isn't configured." }, 500);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const email = String((body && body.email) || "").trim().toLowerCase();
  const password = String((body && body.password) || "");
  const domain = (env.ALLOWED_EMAIL_DOMAIN || "").toLowerCase();

  if (!domain || !EMAIL_RE.test(email) || !email.endsWith(`@${domain}`)) {
    return json({ error: `Use your @${domain} email address.` }, 400);
  }
  if (!await sameSecret(password, env.TEAM_PASSWORD)) {
    return json({ error: "Wrong team password." }, 403);
  }
  return json({ email }, 200, { "Set-Cookie": await sessionCookie(email, env) });
}
