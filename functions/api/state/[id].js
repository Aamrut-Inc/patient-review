import { json } from "../../../lib/auth.js";
import { applyOperation, getState, OpError, patientList } from "../../../lib/state.js";

async function findPatient(env, request, id) {
  return (await patientList(env, request)).find(p => p.id === id);
}

export async function onRequestGet({ env, request, params }) {
  const patient = await findPatient(env, request, params.id);
  if (!patient) return json({ error: "Unknown patient" }, 404);
  return json({ state: await getState(env, request, patient) });
}

// Body: one operation — {op: "add_flag", title, description, proposed_fix, severity}
//                      | {op: "add_comment", flag_id, text} | {op: "fix_flags", flag_ids}
export async function onRequestPost({ env, request, params, data }) {
  const patient = await findPatient(env, request, params.id);
  if (!patient) return json({ error: "Unknown patient" }, 404);
  let op;
  try { op = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  try {
    return json(await applyOperation(env, request, patient, op, data.email));
  } catch (e) {
    if (e instanceof OpError) return json({ error: e.message }, 400);
    throw e;
  }
}
