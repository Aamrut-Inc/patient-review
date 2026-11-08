/* Data loading + shared review state (flags, comments, fixes, versions).
   Static JSON holds the patient data; review state lives server-side
   (functions/api/state, D1) so every reviewer and the engineering team see
   the same flags. Changes are sent as single operations and the server
   answers with the updated state. */

const REFERENCE_BANDS = {
  "33914-3": { low: 30, high: 59, unit: "mL/min", label: "CKD Stage 3 band" },
  "4548-4": { low: 4.0, high: 5.6, unit: "%", label: "Non-diabetic range" },
  "3016-3": { low: 0.4, high: 4.0, unit: "mIU/L", label: "Typical reference range" }
};

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function initials(name) {
  return name.split("@")[0].replace(/^Dr\.\s*/, "").split(/[\s._-]+/).filter(Boolean).map(w => w[0]).join("").slice(0, 2).toUpperCase();
}

/* ---- Server API (same origin; the session cookie from login.html authenticates) ---- */
function goToLogin() {
  location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
}

async function apiFetch(path, options = {}) {
  let res;
  try {
    res = await fetch(path, { credentials: "same-origin", ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  } catch (e) {
    throw new Error("Couldn't reach the server — check your connection and try again.");
  }
  let data = {};
  try { data = await res.json(); } catch (e) { /* non-JSON body */ }
  if (res.status === 401) {
    goToLogin();
    throw new Error("Your sign-in expired — taking you to the sign-in page.");
  }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (HTTP ${res.status})`);
    err.data = data;
    throw err;
  }
  return data;
}

let CURRENT_USER = null;
async function loadIdentity() {
  CURRENT_USER = (await apiFetch("/api/me")).email;
  return CURRENT_USER;
}
function getCurrentDoctor() {
  return CURRENT_USER || "";
}

/* ---- JSON loading, file:// safe (XHR first, fetch fallback) ---- */
function loadJSON(path) {
  return new Promise((resolve, reject) => {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", path, true);
      xhr.onreadystatechange = function () {
        if (xhr.readyState === 4) {
          if (xhr.status === 200 || xhr.status === 0) {
            try { resolve(JSON.parse(xhr.responseText)); }
            catch (e) { reject(e); }
          } else {
            reject(new Error(`${path}: HTTP ${xhr.status}`));
          }
        }
      };
      xhr.onerror = () => {
        fetch(path).then(r => r.json()).then(resolve).catch(reject);
      };
      xhr.send();
    } catch (e) {
      fetch(path).then(r => r.json()).then(resolve).catch(reject);
    }
  });
}

function showLoadError(err) {
  const el = document.createElement("div");
  el.style.cssText = "max-width:640px;margin:60px auto;padding:20px 24px;border:1px solid #E3E1DA;border-radius:8px;background:#fff;font-family:sans-serif;line-height:1.6;";
  el.innerHTML = `<h2 style="margin-top:0;">Couldn't load patient data</h2>
    <p>This page loads its data over <code>fetch</code>/<code>XMLHttpRequest</code>, which some browsers (notably Chrome) block when a page is opened directly as a <code>file://</code> URL.</p>
    <p><strong>Fix:</strong> serve this folder locally instead of double-clicking index.html, e.g.:</p>
    <pre style="background:#F6F5F1;padding:10px 12px;border-radius:6px;">python3 -m http.server 8000</pre>
    <p>then open <code>http://localhost:8000</code>. This works with zero setup once deployed to GitHub Pages.</p>
    <p style="color:#6B6F76;font-size:13px;">(${err && err.message ? err.message : err})</p>`;
  document.body.innerHTML = "";
  document.body.appendChild(el);
}

async function loadPatients() {
  return loadJSON("data/patients.json");
}

async function loadPatientBundle(folder) {
  const base = `data/${encodeURIComponent(folder).replace(/%2F/g, "/")}`;
  const [index, wearable, content] = await Promise.all([
    loadJSON(`data/${folder}/index.json`),
    loadJSON(`data/${folder}/wearable.json`),
    loadJSON(`data/${folder}/content.json`)
  ]);
  return { index, wearable, content };
}

/* ---- Shared per-patient review state (server-side) ---- */
async function getPatientState(patientId) {
  return (await apiFetch(`/api/state/${encodeURIComponent(patientId)}`)).state;
}

async function getAllPatientStates() {
  return (await apiFetch("/api/state")).states;
}

/* Sends one operation; the server applies it to the latest shared state and
   returns that state, which replaces `state` in place so existing references
   (banner, panels) stay valid. Operations:
     {op: "add_flag", title, description, proposed_fix, severity}
     {op: "add_comment", flag_id, text}
     {op: "fix_flags", flag_ids: [...]}   — one version bump per batch
     {op: "revert_to_version", version}   — reopen everything fixed after it
     {op: "delete_flag", flag_id}         — unresolved flags only; moves it to the bin
     {op: "restore_flag", flag_id}        — bin → back to open flags
     {op: "purge_flag", flag_id}          — remove from the bin for good
   The dashboard's activity feed is reconstructed from this structured state
   (flags/comments), so there's exactly one source of truth per event. */
async function applyReviewOp(patientId, state, op) {
  const res = await apiFetch(`/api/state/${encodeURIComponent(patientId)}`, { method: "POST", body: JSON.stringify(op) });
  Object.keys(state).forEach(k => delete state[k]);
  Object.assign(state, res.state);
  return res;
}

function flagCounts(state) {
  const open = state.flags.filter(f => f.status !== "fixed").length;
  const fixed = state.flags.filter(f => f.status === "fixed").length;
  return { open, fixed, total: state.flags.length };
}
