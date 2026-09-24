/* Real AI assistant with full knowledge of the patient's chart.

   Every question sends a compact briefing (overview, the generator's own
   Profile / Limitations / Methodology documents, doctor flags, and a table
   of contents of the record). Everything else — every lab reading, visit,
   note, procedure, medication order, wearable day — the model pulls on
   demand through the tools below, which run HERE in the browser against
   data/<folder>/record.json (built by scripts/build_agent_records.py) and
   wearable.json. functions/api/assistant.js only relays each model call to
   OpenAI with the API key held server-side. */

const MAX_TOOL_ROUNDS = 10;          // model calls per question before forcing an answer
const MAX_TOOL_RESULT_CHARS = 30000; // ~7.5k tokens per tool result
const HISTORY_MESSAGES_SENT = 12;    // prior visible chat turns sent with each question

function chatKey(patientId) { return `pr_chat_${patientId}`; }
function loadChatHistory(patientId) {
  try { return JSON.parse(localStorage.getItem(chatKey(patientId)) || "[]"); }
  catch (e) { return []; }
}
function saveChatHistory(patientId, history) {
  localStorage.setItem(chatKey(patientId), JSON.stringify(history.slice(-30)));
}
function isErrorBubble(h) {
  return h.error || (h.role === "assistant" && h.content.startsWith("⚠"));
}

/* ---- Full record: loaded lazily on the first question ---- */
const RECORD_SECTIONS = ["encounters", "observations", "conditions", "medications", "medication_administrations",
  "procedures", "immunizations", "diagnostic_reports", "notes", "care_plans", "care_teams",
  "devices", "imaging", "allergies", "supplies"];

const recordCache = {};
async function loadAgentRecord(folder) {
  if (!recordCache[folder]) {
    recordCache[folder] = loadJSON(`data/${folder}/record.json`).then(shortenEncounterIds);
  }
  return recordCache[folder];
}

// FHIR UUIDs cost ~20 tokens each and appear on thousands of rows; swap
// them for chronological E1, E2, ... so rows stay cheap to send.
function shortenEncounterIds(rec) {
  const map = {};
  rec.encounters.forEach((e, i) => { map[e.id] = `E${i + 1}`; e.id = map[e.id]; });
  RECORD_SECTIONS.forEach(s => (rec[s] || []).forEach(row => {
    if (row.encounter) row.encounter = map[row.encounter] || row.encounter;
  }));
  return rec;
}

function rowDate(row) {
  return row.date || row.start || row.authored || row.onset || row.recorded || row.manufactured || "";
}
function inDateRange(row, start, end) {
  const d = rowDate(row).slice(0, 10);
  if (!d) return !start && !end;
  return (!start || d >= start) && (!end || d <= end);
}
function rowMatches(row, needle) {
  if (!needle) return true;
  const n = needle.toLowerCase();
  return Object.entries(row).some(([k, v]) => k !== "text" && String(Array.isArray(v) ? v.join(" ") : v).toLowerCase().includes(n));
}
function capResult(obj) {
  let s = JSON.stringify(obj);
  if (s.length <= MAX_TOOL_RESULT_CHARS) return s;
  // Trim the rows array until it fits, and say so, so the model narrows its query.
  if (Array.isArray(obj.rows)) {
    const total = obj.rows.length;
    let keep = Math.max(1, Math.floor(total * MAX_TOOL_RESULT_CHARS / s.length) - 1);
    while (keep > 1) {
      s = JSON.stringify({ ...obj, rows: obj.rows.slice(0, keep), truncated: `showing first ${keep} of ${total} rows — narrow with dates/name filters, use offset, or use series_stats` });
      if (s.length <= MAX_TOOL_RESULT_CHARS) return s;
      keep = Math.floor(keep * 0.8);
    }
  }
  return s.slice(0, MAX_TOOL_RESULT_CHARS) + "…[truncated]";
}

/* ---- Tools the model can call ----
   Built on first use: WEARABLE_FEATURES lives in review.js, which loads after this file. */
function agentTools() {
  const wearableMetricDoc = WEARABLE_FEATURES
    .map(f => `${f.key === "sleep_duration_hrs" ? "sleep_duration (ms)" : f.key}${f.unit && f.key !== "sleep_duration_hrs" ? ` (${f.unit})` : ""}`)
    .join(", ");
  return [
  {
    type: "function",
    name: "query_records",
    description: "Return rows from one section of the patient's full FHIR-derived chart, sorted by date. Filters combine with AND. name_contains is a case-insensitive substring match over every field except note text (so it matches lab names, drug names, encounter types/reasons, categories like 'laboratory' or 'vital-signs').",
    parameters: {
      type: "object",
      properties: {
        section: { type: "string", enum: RECORD_SECTIONS },
        name_contains: { type: "string", description: "e.g. 'glomerular', 'hemoglobin a1c', 'metformin', 'emergency'" },
        code: { type: "string", description: "exact LOINC/SNOMED/RxNorm/CVX code" },
        encounter_id: { type: "string", description: "e.g. 'E12'" },
        start_date: { type: "string", description: "YYYY-MM-DD, inclusive" },
        end_date: { type: "string", description: "YYYY-MM-DD, inclusive" },
        offset: { type: "integer", description: "skip this many matching rows (paging)" },
      },
      required: ["section"],
    },
  },
  {
    type: "function",
    name: "series_stats",
    description: "Exact statistics for every observation series whose name contains the text (or matches the code): reading count, date range, first/last value, min/max/mean, number of distinct values, and the longest run of identical consecutive values (to spot frozen/copied values). Use this instead of eyeballing long series.",
    parameters: {
      type: "object",
      properties: {
        name_contains: { type: "string" },
        code: { type: "string" },
      },
    },
  },
  {
    type: "function",
    name: "get_encounter",
    description: "Everything recorded at one encounter/visit: the encounter itself plus its observations, conditions, medication orders, procedures, immunizations, reports, care plans and the full visit note.",
    parameters: {
      type: "object",
      properties: { encounter_id: { type: "string", description: "e.g. 'E12' (from the encounter_id / encounter fields)" } },
      required: ["encounter_id"],
    },
  },
  {
    type: "function",
    name: "get_wearable",
    description: `Wearable (Fitbit-derived) data, day by day or by week. Metrics: ${wearableMetricDoc}. Null means not recorded that day.`,
    parameters: {
      type: "object",
      properties: {
        granularity: { type: "string", enum: ["daily", "weekly"] },
        metrics: { type: "array", items: { type: "string" }, description: "subset of metric keys; omit for all" },
        start_date: { type: "string", description: "YYYY-MM-DD, inclusive" },
        end_date: { type: "string", description: "YYYY-MM-DD, inclusive" },
      },
      required: ["granularity"],
    },
  },
  {
    type: "function",
    name: "search_record",
    description: "Case-insensitive full-text search across the whole chart, INCLUDING visit note text and the generator documents. Returns matching rows with a snippet. Use for anything not tied to a coded item (symptoms in notes, social history, wording).",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        section: { type: "string", description: "optional: limit to one section, or 'documents'" },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "read_document",
    description: "Full text of one of the patient's generator documents (names are listed in the briefing).",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  ];
}

function runTool(name, args, rec, wearable) {
  switch (name) {
    case "query_records": {
      const rows = (rec[args.section] || []).filter(r =>
        rowMatches(r, args.name_contains) &&
        (!args.code || r.code === args.code) &&
        (!args.encounter_id || r.encounter === args.encounter_id || r.id === args.encounter_id) &&
        inDateRange(r, args.start_date, args.end_date));
      const offset = args.offset || 0;
      return { section: args.section, total_matches: rows.length, offset, rows: rows.slice(offset) };
    }
    case "series_stats": {
      const groups = {};
      rec.observations.forEach(o => {
        if (args.code ? o.code !== args.code : !rowMatches({ name: o.name, code: o.code }, args.name_contains)) return;
        const key = `${o.name} [${o.code}]`;
        (groups[key] = groups[key] || []).push(o);
      });
      return {
        series: Object.entries(groups).map(([key, obs]) => {
          const nums = obs.map(o => o.value).filter(v => typeof v === "number");
          let run = { length: 0 }, cur = null;
          obs.forEach(o => {
            if (cur && o.value === cur.value) { cur.length++; cur.to = o.date; }
            else cur = { value: o.value, length: 1, from: o.date, to: o.date };
            if (cur.length > run.length) run = { ...cur };
          });
          return {
            series: key, unit: obs[0].unit, count: obs.length,
            first: { date: obs[0].date, value: obs[0].value },
            last: { date: obs[obs.length - 1].date, value: obs[obs.length - 1].value },
            ...(nums.length ? { min: Math.min(...nums), max: Math.max(...nums), mean: round1(mean(nums)) } : {}),
            distinct_values: new Set(obs.map(o => o.value)).size,
            longest_identical_run: run,
          };
        }),
      };
    }
    case "get_encounter": {
      const id = args.encounter_id;
      const encounter = rec.encounters.find(e => e.id === id);
      if (!encounter) return { error: `No encounter ${id}. Encounter ids run E1–E${rec.encounters.length}.` };
      const linked = {};
      RECORD_SECTIONS.filter(s => s !== "encounters").forEach(s => {
        const rows = (rec[s] || []).filter(r => r.encounter === id);
        if (rows.length) linked[s] = rows;
      });
      return { encounter, ...linked };
    }
    case "get_wearable": {
      const src = args.granularity === "weekly" ? wearable.weekly : wearable.daily;
      const dateOf = r => r.date || r.week_start;
      const rows = src
        .filter(r => (!args.start_date || dateOf(r) >= args.start_date) && (!args.end_date || dateOf(r) <= args.end_date))
        .map(r => {
          if (!args.metrics || !args.metrics.length) return r;
          const out = { [r.date ? "date" : "week_start"]: dateOf(r) };
          args.metrics.forEach(m => { out[m] = r[m]; });
          return out;
        });
      return { granularity: args.granularity, total_rows: rows.length, rows };
    }
    case "search_record": {
      const q = (args.query || "").toLowerCase();
      if (!q) return { error: "empty query" };
      const hits = [];
      const snippet = text => {
        const i = text.toLowerCase().indexOf(q);
        return (i > 80 ? "…" : "") + text.slice(Math.max(0, i - 80), i + q.length + 160) + "…";
      };
      const sections = args.section ? [args.section] : [...RECORD_SECTIONS, "documents"];
      sections.forEach(s => {
        if (s === "documents") {
          Object.entries(rec.documents || {}).forEach(([name, d]) => {
            if (d.text.toLowerCase().includes(q)) hits.push({ section: "documents", document: name, snippet: snippet(d.text) });
          });
          return;
        }
        (rec[s] || []).forEach(r => {
          const flat = Object.values(r).map(v => Array.isArray(v) ? v.join(" ") : String(v)).join(" | ");
          if (!flat.toLowerCase().includes(q)) return;
          if (r.text) {
            const { text, ...rest } = r;
            hits.push({ section: s, ...rest, snippet: snippet(text) });
          } else {
            hits.push({ section: s, ...r });
          }
        });
      });
      return { query: args.query, total_matches: hits.length, rows: hits };
    }
    case "read_document": {
      const docs = rec.documents || {};
      const d = docs[args.name];
      return d ? { name: args.name, source: d.source, text: d.text } : { error: `No document '${args.name}'. Available: ${Object.keys(docs).join(", ")}` };
    }
    default:
      return { error: `Unknown tool ${name}` };
  }
}

function describeToolCall(name, args) {
  switch (name) {
    case "query_records": return `Reading ${args.section.replace(/_/g, " ")}${args.name_contains ? ` matching “${args.name_contains}”` : ""}${args.start_date || args.end_date ? ` (${args.start_date || "…"} → ${args.end_date || "…"})` : ""}`;
    case "series_stats": return `Computing stats for “${args.name_contains || args.code}”`;
    case "get_encounter": return `Opening visit ${args.encounter_id}`;
    case "get_wearable": return `Reading ${args.granularity} wearable data`;
    case "search_record": return `Searching the chart for “${args.query}”`;
    case "read_document": return `Reading ${args.name}`;
    default: return name;
  }
}

/* ---- Briefing sent with every question ---- */
function summarizeBiomarkerForAgent(b) {
  const unit = cleanUnit(b.unit) || "";
  const readings = b.readings || [];
  const first = readings[0], last = readings[readings.length - 1];
  const frozen = readings.length > 2 && new Set(readings.map(r => r.value)).size === 1;
  let line = `- ${cleanLabel(b.label)}: latest ${b.latest ? b.latest.value : "n/a"}${unit} (${b.latest ? b.latest.date.slice(0, 10) : "n/a"}), ${b.reading_count} reading(s)`;
  if (first && last && first.date !== last.date) {
    line += `; earliest ${first.value}${unit} (${first.date.slice(0, 10)})`;
  }
  if (frozen) line += " [FROZEN: identical value across every reading]";
  const band = REFERENCE_BANDS[b.code];
  if (band) line += ` [safe range: ${band.low}–${band.high} ${band.unit}]`;
  return line;
}
function summarizeWearableForAgent(feature, daily) {
  const vals = daily.map(d => wearableValue(d, feature.key)).filter(v => typeof v === "number");
  if (!vals.length) return `- ${feature.label}: not recorded for this patient`;
  const avg = round1(mean(vals));
  const dev = round1(stddev(vals));
  const unit = feature.unit ? ` ${feature.unit}` : "";
  return `- ${feature.label}: average ${avg}${unit} across ${vals.length}/${daily.length} days${dev != null ? `, deviation ±${dev}${unit}` : ""}`;
}

function buildRecordInventory(rec, wearable) {
  const lines = [];
  const p = rec.patient || {};
  lines.push(`Demographics (FHIR Patient): ${Object.entries(p).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  lines.push("\nSections (query with query_records):");
  RECORD_SECTIONS.forEach(s => {
    const rows = rec[s] || [];
    if (!rows.length) { lines.push(`- ${s}: none`); return; }
    const dates = rows.map(r => rowDate(r).slice(0, 10)).filter(Boolean).sort();
    lines.push(`- ${s}: ${rows.length} rows${dates.length ? `, ${dates[0]} → ${dates[dates.length - 1]}` : ""}`);
  });
  if (rec.encounters.length) lines.push(`Encounter ids: E1 (oldest) – E${rec.encounters.length} (newest).`);
  const omitted = Object.entries(rec.omitted_resource_types || {});
  if (omitted.length) lines.push(`Not loaded (billing/metadata only): ${omitted.map(([t, n]) => `${t} ×${n}`).join(", ")}.`);

  const series = {};
  rec.observations.forEach(o => {
    const k = `${o.name} [${o.code}]`;
    const s = series[k] = series[k] || { n: 0, first: o.date, last: o.date, cat: o.category, unit: o.unit };
    s.n++; s.last = o.date;
  });
  lines.push("\nObservation series (name [code] — readings, date range, category):");
  Object.entries(series).sort((a, b) => b[1].n - a[1].n).forEach(([k, s]) => {
    lines.push(`- ${k}${s.unit ? ` (${s.unit})` : ""} — ${s.n}, ${s.first} → ${s.last}, ${s.cat || "uncategorized"}`);
  });

  const days = wearable.daily.map(d => d.date);
  lines.push(`\nWearable data: ${wearable.daily.length} daily rows (${days[0]} → ${days[days.length - 1]}), ${wearable.weekly.length} weekly rows. Query with get_wearable.`);
  return lines.join("\n");
}

function buildPatientContext(patient, index, wearable, content, state) {
  const primary = new Set(content.primary_conditions || []);
  const open = index.conditions.filter(c => c.abatement === null);
  const current = open.filter(c => primary.has(c.code));
  const pastUnclosed = open.filter(c => !primary.has(c.code));
  const eligibleBiomarkers = index.biomarkers.filter(b => !isExcludedFromClinical(b));
  const openFlags = state.flags.filter(f => f.status !== "fixed");
  const fixedFlags = state.flags.filter(f => f.status === "fixed");

  const lines = [];
  lines.push(`Patient: ${patient.name} (${patient.age_sex}). Condition tag: ${patient.condition_tag}.`);
  lines.push(`Narrative: ${content.narrative.join(" ")}`);

  lines.push("\nCURRENT STRUGGLES (active, defining conditions):");
  lines.push(current.length ? current.map(c => `- ${cleanLabel(c.label)} (onset ${c.onset ? c.onset.slice(0, 10) : "unknown"})`).join("\n") : "- none");

  lines.push("\nOTHER UNRESOLVED FINDINGS (no resolution recorded, not a primary diagnosis):");
  lines.push(pastUnclosed.length ? pastUnclosed.map(c => `- ${cleanLabel(c.label)}`).join("\n") : "- none");

  lines.push("\nKEY CLINICAL BIOMARKERS (quick view; full histories via tools):");
  lines.push(eligibleBiomarkers.length ? eligibleBiomarkers.map(summarizeBiomarkerForAgent).join("\n") : "- none indexed");

  lines.push("\nWEARABLE AVERAGES (quick view; day-by-day via get_wearable):");
  lines.push(WEARABLE_FEATURES.map(f => summarizeWearableForAgent(f, wearable.daily)).join("\n"));

  lines.push("\nDOCTOR-FLAGGED INCONSISTENCIES:");
  lines.push(openFlags.length ? openFlags.map(f => `- [OPEN, ${f.severity} urgency] ${f.title}: ${f.description}${f.proposed_fix ? ` Proposed fix: ${f.proposed_fix}` : ""}`).join("\n") : "- no open flags");
  if (fixedFlags.length) lines.push(fixedFlags.map(f => `- [FIXED] ${f.title}`).join("\n"));

  return lines.join("\n");
}

const SYSTEM_PREAMBLE = `You are a clinical-data assistant embedded in a synthetic-patient chart review tool. The doctor using you is QAing a synthetic dataset, not treating a real patient. Answer their questions about THIS patient accurately, objectively, and in plain language a busy clinician can scan quickly.

You have the patient's COMPLETE chart available through tools: every lab/vital/survey reading, encounter, condition, medication order, procedure, immunization, visit note, care plan, device, imaging study, allergy, and every day of wearable data, plus the generator's own documents. The briefing below is only an overview.
- Before stating any specific value, date, count, or trend, look it up with a tool — don't rely on the overview's first/latest values when the question is about history.
- Use series_stats for counts, ranges and frozen-value checks on long series; query_records / get_wearable to see the actual rows.
- If a tool result says it was truncated, narrow the query (dates, name filter, offset) rather than guessing about the missing rows.
- If something truly isn't in the record after you've checked, say so plainly.
- Cite dates (and encounter ids like E12 when relevant) so the doctor can verify.
- Don't pad with disclaimers. Don't declare something "an inconsistency" unless asked — that judgment belongs to the doctor — but do surface what the data shows.
- Format with short paragraphs, bullet lists, and markdown tables for readings.`;

function buildSystemPrompt(patient, index, wearable, content, state, rec) {
  const docs = Object.entries(rec.documents || {});
  const inline = docs.filter(([, d]) => !d.lookup_only);
  const lookupOnly = docs.filter(([, d]) => d.lookup_only);
  const parts = [SYSTEM_PREAMBLE];
  // Stable content first so OpenAI's prompt cache covers most of the prefix;
  // doctor flags (the part that changes) come last, inside the patient context.
  parts.push("\n\n=== GENERATOR DOCUMENTS (how this synthetic patient was built, and the pipeline's own known limitations) ===");
  inline.forEach(([name, d]) => parts.push(`\n--- ${name} (${d.source}) ---\n${d.text}`));
  if (lookupOnly.length) parts.push(`\nAlso available via read_document (cohort-level, shared with other patients): ${lookupOnly.map(([n, d]) => `${n} (${d.source})`).join(", ")}`);
  parts.push("\n\n=== RECORD TABLE OF CONTENTS ===\n" + buildRecordInventory(rec, wearable));
  parts.push("\n\n=== PATIENT OVERVIEW ===\n" + buildPatientContext(patient, index, wearable, content, state));
  return parts.join("\n");
}

/* ---- Model loop ---- */
async function callModel(payload) {
  try {
    return await apiFetch("/api/assistant", { method: "POST", body: JSON.stringify(payload) });
  } catch (e) {
    const data = e.data || {};
    let msg = e.message;
    if (data.upstream_status) msg += ` (OpenAI HTTP ${data.upstream_status})`;
    if (data.detail) {
      let detail = data.detail;
      try { detail = JSON.parse(detail).error.message || detail; } catch (err) { /* not JSON */ }
      msg += `: ${String(detail).slice(0, 300)}`;
    }
    throw new Error(msg);
  }
}

function outputText(output) {
  return output
    .filter(item => item.type === "message")
    .flatMap(item => item.content || [])
    .filter(c => c.type === "output_text")
    .map(c => c.text)
    .join("\n")
    .trim();
}

async function callAssistant(patient, index, wearable, content, state, history, onProgress) {
  onProgress("Loading the full chart…");
  const rec = await loadAgentRecord(patient.folder);
  const system = buildSystemPrompt(patient, index, wearable, content, state, rec);
  // Error bubbles are UI-only; never send them to the model as its own words.
  const input = history.filter(h => !isErrorBubble(h)).slice(-HISTORY_MESSAGES_SENT)
    .map(h => ({ role: h.role, content: h.content }));

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const lastRound = round === MAX_TOOL_ROUNDS - 1;
    onProgress(round === 0 ? "Thinking…" : "Thinking over what it found…");
    const data = await callModel({ system, input, tools: agentTools(), tool_choice: lastRound ? "none" : "auto" });
    const output = data.output || [];
    input.push(...output);

    const calls = output.filter(item => item.type === "function_call");
    if (!calls.length) {
      const text = outputText(output);
      if (data.status === "incomplete") {
        return (text ? text + "\n\n" : "") + "_(Answer cut off — hit the output length limit. Ask a narrower question.)_";
      }
      return text || "(empty response)";
    }
    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.arguments || "{}"); } catch (e) { /* leave empty */ }
      onProgress(describeToolCall(call.name, args) + "…");
      let result;
      try { result = runTool(call.name, args, rec, wearable); }
      catch (e) { result = { error: String(e.message || e) }; }
      input.push({ type: "function_call_output", call_id: call.call_id, output: capResult(result) });
    }
  }
  return "(The assistant ran out of lookup steps without answering — try a more specific question.)";
}

/* ---- Minimal markdown for assistant replies (escaped first, so no raw HTML) ---- */
function renderMarkdown(md) {
  const inline = s => escapeHtml(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, "$1<em>$2</em>");
  const lines = md.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const cells = l => l.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
      const head = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(cells(lines[i++]));
      out.push(`<div class="md-table-wrap"><table class="md-table"><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && (ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/).test(lines[i])) {
        items.push(inline(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, "")));
        i++;
      }
      out.push(`<${ordered ? "ol" : "ul"}>${items.map(t => `<li>${t}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { out.push(`<p class="md-h">${inline(h[2])}</p>`); i++; continue; }
    if (!line.trim()) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*([-*]|\d+\.)\s+|^#{1,4}\s|^\s*\|/.test(lines[i])) para.push(inline(lines[i++]));
    if (para.length) out.push(`<p>${para.join("<br>")}</p>`);
    else out.push(`<p>${inline(lines[i++])}</p>`);
  }
  return out.join("");
}

/* ---- Chat UI ---- */
function renderAssistant(patient, index, wearable, content, state) {
  const chips = ["Summarize all inconsistencies", "What would a real chart show here?", "What medications is this patient on?", "Any frozen or suspicious values?"];
  const panel = document.getElementById("tab-assistant");
  panel.innerHTML = `<div class="chat-panel">
    <div class="chat-chips">${chips.map(c => `<button class="chip" data-chip type="button">${escapeHtml(c)}</button>`).join("")}</div>
    <div class="chat-log" id="chat-log"></div>
    <div class="chat-input-row">
      <input type="text" id="chat-input" placeholder="Ask about this patient's data...">
      <button class="btn primary" id="chat-send" type="button">Send</button>
    </div>
  </div>`;

  const log = document.getElementById("chat-log");
  let history = loadChatHistory(patient.id);
  let busy = false;

  function bubble(h) {
    if (h.role === "user") return `<div class="bubble user">${escapeHtml(h.content)}</div>`;
    if (isErrorBubble(h)) return `<div class="bubble assistant">${escapeHtml(h.content)}</div>`;
    return `<div class="bubble assistant md">${renderMarkdown(h.content)}</div>`;
  }
  function renderLog() {
    log.innerHTML = history.length
      ? history.map(bubble).join("")
      : `<div class="bubble assistant">I have ${escapeHtml(patient.name)}'s complete chart — every lab reading, visit, note, medication order and wearable day — plus the generator's profile, limitations and methodology documents. Ask me anything, or use a quick prompt above.</div>`;
    log.scrollTop = log.scrollHeight;
  }
  renderLog();

  async function send(text) {
    if (!text.trim() || busy) return;
    busy = true;
    history.push({ role: "user", content: text });
    saveChatHistory(patient.id, history);
    renderLog();
    log.insertAdjacentHTML("beforeend", `<div class="bubble assistant thinking" id="thinking-bubble">Thinking…</div>`);
    log.scrollTop = log.scrollHeight;
    const onProgress = msg => {
      const el = document.getElementById("thinking-bubble");
      if (el) el.textContent = msg;
    };

    try {
      const reply = await callAssistant(patient, index, wearable, content, state, history, onProgress);
      history.push({ role: "assistant", content: reply });
    } catch (e) {
      history.push({ role: "assistant", content: `⚠ ${e.message}`, error: true });
    }
    busy = false;
    saveChatHistory(patient.id, history);
    renderLog();
  }

  panel.querySelectorAll("[data-chip]").forEach(c => c.addEventListener("click", () => send(c.textContent)));
  document.getElementById("chat-send").addEventListener("click", () => {
    const input = document.getElementById("chat-input");
    send(input.value);
    input.value = "";
  });
  document.getElementById("chat-input").addEventListener("keydown", e => {
    if (e.key === "Enter") { document.getElementById("chat-send").click(); }
  });
}
