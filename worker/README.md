# Assistant backend (Cloudflare Worker + OpenAI)

The site itself (`index.html`, `dashboard.html`) is a static page with no
server — that's what makes it deployable to GitHub Pages with zero config.
But the "Ask the assistant" tab calls a real LLM, and an API key must never
sit in client-side JS on a public site (anyone can open dev tools and read
it). This tiny Worker is the fix: it holds your OpenAI API key server-side
and the static site calls *it* instead of OpenAI directly.

## How the assistant knows the whole chart

The model gets a briefing with every question (overview, the patient's
Profile / Limitations / Methodology documents, doctor flags, and a table of
contents of the record) plus six lookup tools — lab/visit/medication rows,
per-series stats (frozen-value detection), full visits with notes, day-by-day
wearable data, full-text search, and document reads. The **browser** runs
those tools against `data/<patient>/record.json`; the Worker only relays each
model call. Rebuild the records whenever the generator produces new data:

```bash
python3 scripts/build_agent_records.py
```

## 1. Get an OpenAI API key — in its own project, with a budget

At [platform.openai.com](https://platform.openai.com), create a **new
project** just for this app, set a **monthly budget limit** on it (e.g. $20 —
requests stop when it's reached), and create an API key inside that project.
Keep the key private — you'll paste it into Cloudflare in step 4, never into
any file in this repo.

## 2. Create a Cloudflare account (free)

[dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) — the free
Workers tier (100,000 requests/day) is far more than one clinic needs.

## 3. Install and log in to Wrangler (Cloudflare's CLI)

```bash
npm install -g wrangler
wrangler login    # opens a browser window to authorize your Cloudflare account
```

## 4. Create the Worker and set its secrets

From the `worker/` folder of this repo, create `worker/wrangler.toml`:

```toml
name = "patient-review-assistant"
main = "worker.js"
compatibility_date = "2026-01-01"
```

Then set the two required secrets. Each command prompts you to paste the
value at a hidden prompt — it never gets written to a file or committed:

```bash
cd worker
wrangler secret put OPENAI_API_KEY
# paste your key from step 1, press enter

wrangler secret put APP_SHARED_SECRET
# make up a password — this is what gates who can use the assistant.
# Share it with your doctor(s) directly (Slack, in person), not in this repo.
```

Optional, to restrict which site origin can call the Worker (recommended
once you know your GitHub Pages URL):

```bash
wrangler secret put ALLOWED_ORIGIN
# e.g. https://yourname.github.io
```

## 5. Deploy

```bash
wrangler deploy
```

This prints your Worker's URL, something like:

```
https://patient-review-assistant.yoursubdomain.workers.dev
```

## 6. Sanity-check it directly (optional but recommended)

```bash
curl -s https://patient-review-assistant.yoursubdomain.workers.dev \
  -X POST -H "Content-Type: application/json" \
  -d '{"secret":"<your APP_SHARED_SECRET>","system":"You are a test.","input":[{"role":"user","content":"Say hi in five words."}]}'
```

You should get back `{"status": "completed", "output": [...], "usage": {...}}`. If you get
`{"error":"Unauthorized"}`, double check the secret matches what you set in
step 4. If you get an upstream error mentioning the model, OpenAI may have
retired the configured model — check
[developers.openai.com/api/docs/models](https://developers.openai.com/api/docs/models)
for a current model ID and update the `MODEL` constant at the top of
`worker.js`, then `wrangler deploy` again.

## 7. Point the site at your Worker

Open [`assets/js/assistant.js`](../assets/js/assistant.js) and set:

```js
const WORKER_URL = "https://patient-review-assistant.yoursubdomain.workers.dev";
```

Commit and push (or redeploy to GitHub Pages). That's it — the "Ask the
assistant" tab is now live. The first time anyone opens it, the site asks
for the access code (the `APP_SHARED_SECRET` you set in step 4) and
remembers it in that browser from then on.

## Cost

Default model is `gpt-6-sol` ($2 input / $0.20 cached input / $10 output
per 1M tokens). A question uses the ~5–9k-token briefing plus whatever the
model looks up, usually 1–4 tool rounds, so expect roughly **$0.03–0.10 per
question**. Repeated briefings hit OpenAI's prompt cache at 10% of the input
price. For ~20x cheaper (and noticeably weaker reasoning) set
`MODEL = "gpt-6-luna"` in `worker.js`. The project budget limit from step 1
is the hard ceiling either way. The Worker itself is free at this scale.

## Extra hardening (optional but recommended)

The shared secret stops casual/opportunistic use of a discovered URL, but it
is not cryptographic security — it's sent in the request body like any
client-held value, so treat it as a speed bump, not a lock. For real
protection against someone finding the Worker URL and hammering it:

- In the Cloudflare dashboard: **Security → WAF → Rate limiting rules**, add
  a rule on this Worker's route (e.g. max 30 requests/minute per IP).
- Rotate `APP_SHARED_SECRET` any time you suspect it leaked
  (`wrangler secret put APP_SHARED_SECRET` again) — every browser that had
  the old value will be asked to re-enter it.

## Switching models or providers later

Everything provider-specific lives in `worker.js` — the frontend
(`assets/js/assistant.js`) only ever talks to your Worker and expects back
`{"status", "output", "usage"}` in the Responses API item format, so
swapping models is a one-line change in `worker.js`; swapping providers means
translating to/from that format in `worker.js` only — the frontend and the rest of the site
don't change.
