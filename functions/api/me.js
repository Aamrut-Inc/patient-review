import { json } from "../../lib/auth.js";

export async function onRequestGet({ data }) {
  return json({ email: data.email });
}
