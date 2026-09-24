/* Shared review state (flags, comments, fixes, version history), one row per
   patient in D1. Clients never write whole state blobs — they send a single
   operation, applied here against the latest row with an optimistic `rev`
   check, so two doctors working on the same patient can't overwrite each
   other. Every applied operation is also appended to `review_events`, the
   audit trail the engineering team can query directly. */

const SEVERITIES = ["High", "Medium", "Low"];
const LIMITS = { title: 200, description: 4000, proposed_fix: 4000, comment: 4000 };

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function loadAsset(env, request, path) {
  const res = await env.ASSETS.fetch(new URL(path, request.url));
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

export async function patientList(env, request) {
  return loadAsset(env, request, "/data/patients.json");
}

/* First-ever read of a patient seeds from the flags shipped in content.json. */
async function seedState(env, request, patient) {
  const content = await loadAsset(env, request, `/data/${encodeURI(patient.folder)}/content.json`);
  return {
    flags: content.flags || [],
    version: content.version || 1,
    version_history: content.version_history || [],
    comments: {},
  };
}

async function readRow(env, patientId) {
  return env.DB.prepare("SELECT state, rev FROM patient_state WHERE patient_id = ?").bind(patientId).first();
}

export async function getState(env, request, patient) {
  const row = await readRow(env, patient.id);
  if (row) return JSON.parse(row.state);
  const seeded = await seedState(env, request, patient);
  await env.DB.prepare("INSERT OR IGNORE INTO patient_state (patient_id, state, rev, updated_at, updated_by) VALUES (?, ?, 0, ?, 'seed')")
    .bind(patient.id, JSON.stringify(seeded), new Date().toISOString()).run();
  const again = await readRow(env, patient.id);
  return JSON.parse(again.state);
}

function str(v, max, field) {
  if (typeof v !== "string" || !v.trim()) throw new OpError(`${field} is required`);
  if (v.length > max) throw new OpError(`${field} is too long (max ${max} characters)`);
  return v.trim();
}

export class OpError extends Error {}

/* Mutates `state` in place. `who` is the authenticated email — never trusted from the client. */
function applyOp(state, op, who) {
  switch (op && op.op) {
    case "add_flag": {
      const severity = SEVERITIES.includes(op.severity) ? op.severity : "Medium";
      const id = "f" + Date.now() + Math.floor(Math.random() * 1000);
      state.flags.push({
        id,
        title: str(op.title, LIMITS.title, "title"),
        description: str(op.description, LIMITS.description, "description"),
        proposed_fix: typeof op.proposed_fix === "string" ? op.proposed_fix.trim().slice(0, LIMITS.proposed_fix) : "",
        severity,
        status: "open",
        opened_by: who,
        opened_date: today(),
      });
      return { flag_id: id };
    }
    case "add_comment": {
      if (!state.flags.some(f => f.id === op.flag_id)) throw new OpError("Unknown flag");
      (state.comments[op.flag_id] = state.comments[op.flag_id] || [])
        .push({ who, date: today(), text: str(op.text, LIMITS.comment, "comment") });
      return {};
    }
    case "fix_flags": {
      // A batch of fixes is one new version of the profile, not one per flag.
      const ids = Array.isArray(op.flag_ids) ? [...new Set(op.flag_ids)] : [];
      if (!ids.length || ids.length > 200) throw new OpError("Select at least one flag");
      const flags = ids.map(id => state.flags.find(f => f.id === id));
      if (flags.some(f => !f)) throw new OpError("Unknown flag");
      const toFix = flags.filter(f => f.status !== "fixed");
      if (!toFix.length) return {};
      toFix.forEach(f => {
        f.status = "fixed";
        f.fixed_by = who;
        f.fixed_date = today();
      });
      state.version += 1;
      state.version_history.push({
        version: state.version,
        date: today(),
        change: `Resolved ${toFix.length === 1 ? "" : `${toFix.length} flags: `}${toFix.map(f => f.title).join("; ")}`,
        by: who,
        flag_ids: toFix.map(f => f.id), // what revert_to_version reopens
      });
      return { fixed: toFix.length };
    }
    case "revert_to_version": {
      // Undo every fix batch after `version`: reopen the flags each batch
      // fixed and drop those versions, so the profile is back at `version`.
      const target = Number(op.version);
      if (!Number.isInteger(target) || target < 1 || target >= state.version) throw new OpError("Pick an earlier version");
      if (!state.version_history.some(v => v.version === target)) throw new OpError("Unknown version");
      const undone = state.version_history.filter(v => v.version > target);
      const reopen = new Set(undone.flatMap(v => v.flag_ids || []));
      state.flags.forEach(f => {
        if (!reopen.has(f.id)) return;
        f.status = "open";
        delete f.fixed_by;
        delete f.fixed_date;
      });
      state.version_history = state.version_history.filter(v => v.version <= target);
      state.version = target;
      return { reopened: reopen.size };
    }
    default:
      throw new OpError("Unknown operation");
  }
}

export async function applyOperation(env, request, patient, op, who) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await getState(env, request, patient); // ensures the row exists
    const row = await readRow(env, patient.id);
    const state = JSON.parse(row.state);
    const result = applyOp(state, op, who);
    const now = new Date().toISOString();
    const [update] = await env.DB.batch([
      env.DB.prepare("UPDATE patient_state SET state = ?, rev = rev + 1, updated_at = ?, updated_by = ? WHERE patient_id = ? AND rev = ?")
        .bind(JSON.stringify(state), now, who, patient.id, row.rev),
      env.DB.prepare("INSERT INTO review_events (patient_id, op, payload, email, at) SELECT ?, ?, ?, ?, ? WHERE changes() > 0")
        .bind(patient.id, op.op, JSON.stringify(op), who, now),
    ]);
    if (update.meta.changes === 1) return { state, ...result };
    // Someone else wrote first — reload and re-apply on their version.
  }
  throw new Error("Too much concurrent editing on this patient; try again.");
}
