import { json } from "../../../lib/auth.js";
import { getState, patientList } from "../../../lib/state.js";

// All patients' review state, for the Team Dashboard.
export async function onRequestGet({ env, request }) {
  const patients = await patientList(env, request);
  const states = {};
  for (const p of patients) states[p.id] = await getState(env, request, p);
  return json({ states });
}
