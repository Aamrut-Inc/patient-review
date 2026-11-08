/* Read-only cross-portal summary, consumed by the Review Hub.

   The hub never touches this portal's database directly — it asks here, so
   `patient_state`'s shape stays private to this repo and the hub can't drift
   out of sync with it. Everything returned is derived; nothing is written.

   GET /api/summary          counts per patient + recent activity
   GET /api/summary?full=1   also inlines each patient's open flag titles,
                             which the hub's per-patient page shows beside
                             the answer-review flags for the same patient.

   Auth is the normal session (functions/_middleware.js), so this is only
   readable by a signed-in reviewer, exactly like the rest of the site. */
import { json } from "../../lib/auth.js";
import { patientList, peekState } from "../../lib/state.js";

const ACTIVITY_LIMIT = 60;
const FLAG_FIELDS = ["id", "title", "severity", "status", "opened_by", "opened_date", "fixed_by", "fixed_date"];

/* "1- CKD" -> 1. The leading number is the join key the hub uses to line this
   portal's patients up with Answer QA's, which identifies them by number. */
function folderNumber(folder) {
  const m = /^\s*(\d+)/.exec(folder || "");
  return m ? Number(m[1]) : null;
}

function pick(flag) {
  const out = {};
  for (const f of FLAG_FIELDS) if (flag[f] !== undefined) out[f] = flag[f];
  if (flag.anchor && flag.anchor.label) out.anchor = flag.anchor.label;
  return out;
}

function countFlags(state) {
  const flags = state.flags || [];
  return {
    open: flags.filter(f => f.status !== "fixed").length,
    fixed: flags.filter(f => f.status === "fixed").length,
    binned: (state.bin || []).length,
    total: flags.length,
  };
}

export async function onRequestGet({ env, request }) {
  const full = new URL(request.url).searchParams.get("full") === "1";
  const patients = await patientList(env, request);

  const rows = [];
  for (const p of patients) {
    // peekState, not getState: a never-reviewed patient still reports the
    // flags content.json ships, but polling this endpoint never writes.
    const state = await peekState(env, request, p);
    const row = {
      id: p.id,
      folder: p.folder,
      n: folderNumber(p.folder),
      name: p.name,
      condition_tag: p.condition_tag,
      age_sex: p.age_sex,
      flags: countFlags(state),
      comments: Object.values(state.comments || {}).reduce((a, c) => a + c.length, 0),
      version: state.version || 1,
    };
    if (full) {
      row.flag_list = (state.flags || []).map(pick);
      row.version_history = (state.version_history || []).slice(-5);
    }
    rows.push(row);
  }

  const byId = new Map(rows.map(r => [r.id, r]));
  const events = await env.DB
    .prepare("SELECT patient_id, op, payload, email, at FROM review_events ORDER BY id DESC LIMIT ?")
    .bind(ACTIVITY_LIMIT).all();

  const activity = (events.results || []).map(e => {
    let title = "";
    try { title = (JSON.parse(e.payload) || {}).title || ""; } catch { /* payload shapes vary by op */ }
    const p = byId.get(e.patient_id);
    return {
      surface: "chart",
      patient_id: e.patient_id,
      n: p ? p.n : null,
      patient_name: p ? p.name : e.patient_id,
      op: e.op,
      who: e.email,
      at: e.at,
      title,
    };
  });

  return json({
    surface: "chart",
    generated_at: new Date().toISOString(),
    patients: rows,
    activity,
  });
}
