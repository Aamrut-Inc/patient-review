# Deploying the review portal

Live at **https://patient-review.pages.dev** (Cloudflare Pages, project `patient-review`).

- **Static site:** `dist/`, built by `scripts/build_site.sh`.
- **API routes** in `functions/api/`:
  - `state`: shared flags, comments and fixes, stored in D1 database `patient-review`.
  - `assistant`: the OpenAI relay, which goes through the `worker/` Worker that holds the key.
  - `me`: who is signed in.
  - `auth/*`: sign-in and sign-out.
- **Sign-in:** reviewers enter their `@aamrut.com` email and the shared **team password**. The email is self-reported, and flags are attributed to it. `functions/_middleware.js` checks the session on every request (pages, patient data files and API), so nothing is readable signed-out. Only `/login` and `/api/auth/*` are public.
- **Optional:** set `GOOGLE_CLIENT_ID` and a "Sign in with Google" button also appears, with verified emails. See step 6.

## One-time setup (already done unless noted)

1. `wrangler login`
2. Create the database (done). Its id is in `wrangler.toml`.
   ```bash
   wrangler d1 create patient-review
   wrangler d1 migrations apply patient-review --remote
   ```
3. Create the Pages project (done):
   ```bash
   wrangler pages project create patient-review --production-branch main
   ```
4. Set the session-signing secret (done):
   ```bash
   openssl rand -hex 32 | wrangler pages secret put SESSION_SECRET --project-name patient-review
   ```
5. **Set the team password** (done). To change it:
   ```bash
   wrangler pages secret put TEAM_PASSWORD --project-name patient-review
   ```
   Changing the password blocks new sign-ins with the old one. To also sign out everyone who is already signed in, set a new `SESSION_SECRET` as well.
6. **Optional: Google sign-in client**, free and with no card. Google Cloud requires 2-Step Verification on your account first. In [console.cloud.google.com](https://console.cloud.google.com), signed in with your @aamrut.com account:
   1. Create a project, e.g. `patient-review`.
   2. Go to **Google Auth Platform** (APIs & Services → OAuth consent screen).
      - Fill in the app name (`Chart QA`) and a support email.
      - Set **Audience** to **Internal**. This limits sign-in to your Workspace.
   3. Go to **Clients → Create client**:
      - Type: **Web application**.
      - **Authorized JavaScript origins:** `https://patient-review.pages.dev` and `http://localhost:8788`.
      - No redirect URIs are needed.
   4. Copy the **Client ID** (it ends in `.apps.googleusercontent.com`) into `GOOGLE_CLIENT_ID` in `wrangler.toml`. The client ID isn't a secret.
7. **OpenAI key** (done, indirectly). The key lives in the standalone Worker (`worker/`, secret `OPENAI_API_KEY`). `/api/assistant` forwards to it using `ASSISTANT_WORKER_URL` (in `wrangler.toml`) and the Pages secret `ASSISTANT_WORKER_SECRET`, which matches that Worker's `APP_SHARED_SECRET`. So don't delete the Worker.
   To call OpenAI directly instead and retire the Worker, create a new key in your OpenAI project and run:
   ```bash
   wrangler pages secret put OPENAI_API_KEY --project-name patient-review
   ```

## Deploy (every update)

```bash
python3 scripts/build_agent_records.py   # only when patient data changed
./scripts/build_site.sh
wrangler pages deploy --branch main
```

`--branch main` matters. Without it, Wrangler uses the current git branch, and any branch other than `main` becomes a preview deployment. Preview URLs are also sign-in-gated, but Google sign-in only works on the origins listed in step 5, so on a preview nobody can sign in at all.

## Local development

```bash
./scripts/build_site.sh
wrangler d1 migrations apply patient-review --local
wrangler pages dev --port 8788
```

`.dev.vars` (gitignored) sets `DEV_USER_EMAIL`, which signs you in automatically, but only on `localhost`. It also sets a local `SESSION_SECRET`. Add `OPENAI_API_KEY=...` there if you want the assistant to work locally.

## Reading the flags (engineering team)

Everyone who signs in sees the Team Dashboard. For raw data:

```bash
wrangler d1 execute patient-review --remote --command \
  "SELECT patient_id, op, email, at, payload FROM review_events ORDER BY id DESC LIMIT 50"
```

`patient_state` holds each patient's current flags, comments and version history as JSON.
