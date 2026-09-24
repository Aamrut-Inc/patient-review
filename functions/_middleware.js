import { authenticatedEmail, json } from "../lib/auth.js";

// Only these load without signing in: the login page and the sign-in API.
const PUBLIC_PATHS = new Set(["/login.html", "/login", "/api/auth/config", "/api/auth/google", "/api/auth/password", "/api/auth/logout"]);

// Runs on EVERY request — pages, patient data files and API alike — so
// nothing is readable without signing in (team password or Google).
export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (PUBLIC_PATHS.has(url.pathname)) return context.next();

  const email = await authenticatedEmail(context.request, context.env);
  if (email) {
    context.data.email = email;
    const res = await context.next();
    // Patient data must never sit in a shared/proxy cache.
    const out = new Response(res.body, res);
    out.headers.set("Cache-Control", "private, no-store");
    return out;
  }
  if (url.pathname.startsWith("/api/")) return json({ error: "Not signed in" }, 401);
  const next = url.pathname + url.search;
  return Response.redirect(`${url.origin}/login.html?next=${encodeURIComponent(next)}`, 302);
}
