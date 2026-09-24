/* Small pure helpers shared across pages. */

function cleanLabel(label) {
  return (label || "").replace(/\s*\((disorder|finding|situation|morphologic abnormality)\)\s*$/i, "");
}

/* FHIR units come through as raw UCUM codes (e.g. "mL/min/{1.73_m2}", "{score}") */
function cleanUnit(u) {
  if (!u) return u;
  if (u === "mL/min/{1.73_m2}") return "mL/min/1.73m²";
  return u.replace(/\{[^}]*\}/g, "").trim();
}

/* Splits an RxNorm-style display string like "24 HR Metformin hydrochloride 500 MG
   Extended Release Oral Tablet" into a clean drug name and the remaining dose/form text. */
function splitDrugDose(text) {
  let s = text;
  let prefix = "";
  let changed = true;
  while (changed) {
    changed = false;
    const m = s.match(/^([A-Z]{2,}\d{3,}|\d+(\.\d+)?\s*(HR|ACTUAT|ML))\s+/);
    if (m) { prefix += m[0]; s = s.slice(m[0].length); changed = true; }
  }
  const doseMatch = s.match(/\d/);
  if (!doseMatch) return { drug: text.trim(), dose: "" };
  const idx = doseMatch.index;
  const drug = s.slice(0, idx).trim();
  const dose = (prefix + s.slice(idx)).trim();
  return { drug: drug || text.trim(), dose };
}

/* Human "how long" between two ISO dates, e.g. "4y", "7 mo", "new". */
function formatSpan(startIso, endIso) {
  if (!startIso) return null;
  const start = new Date(startIso);
  const end = endIso ? new Date(endIso) : start;
  if (isNaN(start) || isNaN(end)) return null;
  const months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
  if (months < 1) return "new";
  if (months < 12) return `${months} mo`;
  const years = Math.floor(months / 12);
  const rem = months % 12;
  return rem === 0 ? `${years}y` : `${years}y ${rem}mo`;
}

function mean(arr) {
  const vals = arr.filter(v => typeof v === "number");
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
function stddev(arr) {
  const vals = arr.filter(v => typeof v === "number");
  if (vals.length < 2) return null;
  const m = mean(vals);
  const variance = vals.reduce((a, b) => a + (b - m) * (b - m), 0) / (vals.length - 1);
  return Math.sqrt(variance);
}
function round1(n) {
  return n == null ? null : Math.round(n * 10) / 10;
}
