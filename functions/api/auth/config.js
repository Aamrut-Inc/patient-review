import { json } from "../../../lib/auth.js";

// Public: the login page needs the (non-secret) Google client ID and domain.
export async function onRequestGet({ env }) {
  return json({ client_id: env.GOOGLE_CLIENT_ID || null, domain: env.ALLOWED_EMAIL_DOMAIN || null });
}
