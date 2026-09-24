import { json, sessionCookie, verifyGoogleIdToken } from "../../../lib/auth.js";

// Body: {credential} — the ID token Google's sign-in button hands the page.
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  let email = null;
  try { email = await verifyGoogleIdToken(body && body.credential, env); }
  catch (e) { console.log("Google token verification error", String(e)); }
  if (!email) {
    return json({ error: `Sign in with your @${env.ALLOWED_EMAIL_DOMAIN} Google account.` }, 403);
  }
  return json({ email }, 200, { "Set-Cookie": await sessionCookie(email, env) });
}
