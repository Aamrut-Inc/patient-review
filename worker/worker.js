/**
 * Cloudflare Worker: proxies chat requests from the static site to OpenAI's
 * Responses API, so the real OPENAI_API_KEY never reaches the browser.
 *
 * The assistant is tool-using: the model asks for chart lookups (lab
 * histories, encounters, notes, wearable days...), the BROWSER runs them
 * against the patient's record.json and sends the results back in the next
 * request. This Worker stays a stateless relay — one model call per request.
 *
 * Deployed separately from the GitHub Pages site (see worker/README.md).
 *
 * Secrets (set with `wrangler secret put <NAME>`, never committed):
 *   OPENAI_API_KEY      - key from a dedicated OpenAI project with a monthly
 *                         budget limit set (platform.openai.com → Projects)
 *   APP_SHARED_SECRET   - a password you make up; the doctor enters the same
 *                         value once in the site's "Ask the assistant" tab.
 *                         Blocks random internet traffic from spending your
 *                         API budget; it is NOT cryptographic security (it
 *                         travels in each request body, same as any
 *                         client-held secret) - pair it with a Cloudflare
 *                         rate-limit rule on this route for real protection.
 *
 * Optional config (set with `wrangler secret put ALLOWED_ORIGIN`, or leave
 * unset to allow any origin):
 *   ALLOWED_ORIGIN       - e.g. "https://yourname.github.io" to restrict CORS
 *                          to your deployed site instead of "*"
 */

// gpt-6-sol: mid tier ($2 in / $0.20 cached / $10 out per 1M tokens).
// gpt-6-luna is ~20x cheaper but nano-class; weaker at clinical reasoning.
// Current IDs: https://developers.openai.com/api/docs/models
const MODEL = "gpt-6-sol";
const REASONING_EFFORT = "low";
// Reasoning tokens count against this cap, so leave headroom.
const MAX_OUTPUT_TOKENS = 8000;
const MAX_BODY_BYTES = 1_500_000; // system prompt + history + tool results for one question
const MAX_INPUT_ITEMS = 120;

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, env);
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return json({ error: "Request too large" }, 413, env);
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: "Invalid JSON body" }, 400, env);
    }

    const { secret, system, input, tools, tool_choice } = body || {};
    // .trim() both sides: a stray trailing space/newline from copy-pasting
    // into a terminal prompt (either when setting the secret or entering it
    // in the browser) would otherwise cause a silent, hard-to-debug mismatch.
    const suppliedSecret = typeof secret === "string" ? secret.trim() : "";
    const expectedSecret = (env.APP_SHARED_SECRET || "").trim();
    if (!expectedSecret || suppliedSecret !== expectedSecret) {
      return json({ error: "Unauthorized" }, 401, env);
    }
    if (typeof system !== "string" || !system.trim()) {
      return json({ error: "Missing system prompt" }, 400, env);
    }
    if (!Array.isArray(input) || input.length === 0) {
      return json({ error: "Missing input" }, 400, env);
    }
    if (input.length > MAX_INPUT_ITEMS) {
      return json({ error: "Conversation too long for this endpoint" }, 400, env);
    }
    if (tools !== undefined && !Array.isArray(tools)) {
      return json({ error: "tools must be an array" }, 400, env);
    }

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
      return json({ error: "Could not reach OpenAI API", detail: String(e) }, 502, env);
    }

    if (!upstream.ok) {
      const text = await upstream.text();
      console.log("OpenAI upstream error", upstream.status, text.slice(0, 800));
      // Always 502 here, never upstream.status verbatim — the frontend
      // treats a 401 specifically as "your app access code was rejected,"
      // so re-broadcasting OpenAI's own 401 (e.g. a bad OPENAI_API_KEY) would
      // be wrongly reported to the doctor as a wrong access code instead of
      // a backend configuration problem.
      return json({ error: "Upstream API error", upstream_status: upstream.status, detail: text.slice(0, 800) }, 502, env);
    }

    const data = await upstream.json();
    return json({
      status: data.status,
      incomplete_details: data.incomplete_details || null,
      output: data.output || [],
      usage: data.usage || null,
    }, 200, env);
  },
};

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(obj, status, env) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}
