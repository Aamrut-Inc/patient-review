import { clearedSessionCookie } from "../../../lib/auth.js";

export async function onRequest({ request }) {
  return new Response(null, {
    status: 302,
    headers: { Location: new URL("/login.html", request.url).toString(), "Set-Cookie": clearedSessionCookie() },
  });
}
