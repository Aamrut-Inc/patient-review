/* Relays one assistant model call to OpenAI's Responses API, keeping the
   API key server-side. Two ways to reach OpenAI:
   - OPENAI_API_KEY set on this Pages project → call OpenAI directly.
   - Otherwise, forward to the older standalone Worker (worker/), which holds
     the key: ASSISTANT_WORKER_URL (wrangler.toml) + ASSISTANT_WORKER_SECRET
     (Pages secret, equal to that Worker's APP_SHARED_SECRET).

   The assistant is tool-using: the model asks for chart lookups, the BROWSER
   runs them against the patient's record.json (assets/js/assistant.js) and
   sends the results back in the next request. This route stays a stateless
   relay — one model call per request. Only signed-in users reach it
   (functions/api/_middleware.js). */

import { json } from "../../lib/auth.js";

// gpt-6-sol: mid tier ($2 in / $0.20 cached / $10 out per 1M tokens).
// gpt-6-luna is ~20x cheaper but nano-class; weaker at clinical reasoning.
// Current IDs: https://developers.openai.com/api/docs/models
const MODEL = "gpt-6-sol";
const REASONING_EFFORT = "low";
// Reasoning tokens count against this cap, so leave headroom.
const MAX_OUTPUT_TOKENS = 8000;
const MAX_BODY_BYTES = 1_500_000; // system prompt + history + tool results for one question
const MAX_INPUT_ITEMS = 120;

export async function onRequestPost({ request, env }) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "Request too large" }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: "Invalid JSON body" }, 400); }

  const { system, input, tools, tool_choice } = body || {};
  if (typeof system !== "string" || !system.trim()) return json({ error: "Missing system prompt" }, 400);
  if (!Array.isArray(input) || input.length === 0) return json({ error: "Missing input" }, 400);
  if (input.length > MAX_INPUT_ITEMS) return json({ error: "Conversation too long for this endpoint" }, 400);
  if (tools !== undefined && !Array.isArray(tools)) return json({ error: "tools must be an array" }, 400);
  if (!env.OPENAI_API_KEY) return forwardToWorker({ system, input, tools, tool_choice }, env);

  let upstream;
  try {
    upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        instructions: system,
        input,
        tools: tools || [],
        tool_choice: tool_choice === "none" ? "none" : "auto",
        reasoning: { effort: REASONING_EFFORT },
        max_output_tokens: MAX_OUTPUT_TOKENS,
        // Stateless: nothing stored at OpenAI. Reasoning is handed back to
        // the browser encrypted so the next tool round can include it.
        store: false,
        include: ["reasoning.encrypted_content"],
      }),
    });
  } catch (e) {
    return json({ error: "Could not reach OpenAI API", detail: String(e) }, 502);
  }

  if (!upstream.ok) {
    const text = await upstream.text();
    console.log("OpenAI upstream error", upstream.status, text.slice(0, 800));
    // Always 502, never upstream.status verbatim — the frontend treats 401 as
    // "you're signed out", which an OpenAI 401 (bad API key) is not.
    return json({ error: "Upstream API error", upstream_status: upstream.status, detail: text.slice(0, 800) }, 502);
  }

  const out = await upstream.json();
  return json({
    status: out.status,
    incomplete_details: out.incomplete_details || null,
    output: out.output || [],
    usage: out.usage || null,
  });
}

async function forwardToWorker(payload, env) {
  if (!env.ASSISTANT_WORKER_URL || !env.ASSISTANT_WORKER_SECRET) {
    return json({ error: "The assistant isn't configured: set OPENAI_API_KEY, or ASSISTANT_WORKER_URL + ASSISTANT_WORKER_SECRET." }, 500);
  }
  let res;
  try {
    res = await fetch(env.ASSISTANT_WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: env.ASSISTANT_WORKER_SECRET, ...payload }),
    });
  } catch (e) {
    return json({ error: "Could not reach the assistant worker", detail: String(e) }, 502);
  }
  const text = await res.text();
  if (res.ok) {
    return new Response(text, { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }
  // Never pass a 401 through — the frontend reads 401 as "you're signed out".
  let data = {};
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  console.log("Assistant worker error", res.status, text.slice(0, 800));
  return json({
    error: res.status === 401 ? "Assistant worker rejected ASSISTANT_WORKER_SECRET" : (data.error || "Assistant worker error"),
    upstream_status: data.upstream_status,
    detail: data.detail,
  }, 502);
}
