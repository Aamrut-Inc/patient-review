/* Patient Review screen (index.html) */

const VITALS_PRIORITY = ["33914-3", "4548-4", "2160-0", "39156-5", "8867-4", "8480-6", "8462-4", "3016-3"];

/* Biomarkers that are really wearable-derived (embedded into FHIR by the
   custom-module patients) or otherwise not "clinical numbers" a doctor
   would review here (they either duplicate the Wearable Variables section
   or are administrative, e.g. height). */
const CLINICAL_EXCLUDE_CODES = new Set(["8302-2", "40443-4", "41950-7", "sleep_duration", "sleep_efficiency"]);
const CLINICAL_EXCLUDE_KEYWORDS = ["height", "temperature", "steps in 24 hour", "--resting"];
function isExcludedFromClinical(b) {
  if (CLINICAL_EXCLUDE_CODES.has(b.code)) return true;
  const l = (b.label || "").toLowerCase();
  return CLINICAL_EXCLUDE_KEYWORDS.some(k => l.includes(k));
}

function sanitizeId(s) {
  return String(s).replace(/[^a-zA-Z0-9]/g, "-");
}

function accRow(id, title, count, bodyHtml, opts = {}) {
  return `<div class="acc-row ${opts.open ? "open" : ""}" data-acc="${id}">
    <button class="acc-head" type="button">
      <h3>${escapeHtml(title)}</h3>
      ${count != null ? `<span class="acc-count">${count}</span>` : ""}
      <span class="acc-chevron">›</span>
    </button>
    <div class="acc-body">${bodyHtml}</div>
  </div>`;
}

/* ---- Diagnosed conditions (plain pills, no links) ---- */
function renderConditions(content, index) {
  const primary = new Set(content.primary_conditions || []);
  const open = index.conditions.filter(c => c.abatement === null);
  const current = open.filter(c => primary.has(c.code));
  const pastUnclosed = open.filter(c => !primary.has(c.code));

  function pill(c, cls) {
    return `<span class="pill ${cls}">${escapeHtml(cleanLabel(c.label))}</span>`;
  }

  let html = `<div class="cond-group-title">Current struggles</div>`;
  html += current.length
    ? `<div class="pill-group">${current.map(c => pill(c, "current")).join("")}</div>`
    : `<div class="empty-note">No active chronic conditions on this chart.</div>`;
  html += `<div class="cond-group-title">Past / unclosed</div>`;
  html += `<div class="unresolved-note">No resolution recorded for these in the chart — treat as unclear status, not assumed resolved.</div>`;
  html += pastUnclosed.length
    ? `<div class="pill-group">${pastUnclosed.map(c => pill(c, "past")).join("")}</div>`
    : `<div class="empty-note">None.</div>`;
  return html;
}

/* ---- Medications (4-column table: drug / dosage / frequency / since) ---- */
/* Duration is measured against the chart's own latest known date (its most
   recent biomarker reading), not each med's own last refill — a med with
   only one authored instance still has a real "how long ago" to show. */
function chartLatestDate(index) {
  let latest = null;
  index.biomarkers.forEach(b => {
    (b.readings || []).forEach(r => {
      if (r.date && (!latest || r.date > latest)) latest = r.date;
    });
  });
  return latest || todayStr();
}
function medRow(m, asOf) {
  const { drug, dose } = splitDrugDose(m.text);
  const freq = m.dosage || "—";
  const span = formatSpan(m.first_authored, asOf);
  const since = m.first_authored ? `${m.first_authored.slice(0, 10)}${span ? ` · ${span}` : ""}` : "—";
  return `<tr>
    <td>${escapeHtml(drug)}</td>
    <td class="mono">${escapeHtml(dose)}</td>
    <td>${escapeHtml(freq)}</td>
    <td class="mono">${escapeHtml(since)}</td>
  </tr>`;
}
function medTable(meds, asOf) {
  return `<table class="med-table">
    <thead><tr><th>Drug</th><th>Dosage</th><th>Frequency</th><th>On chart since</th></tr></thead>
    <tbody>${meds.map(m => medRow(m, asOf)).join("")}</tbody>
  </table>`;
}
function renderMedications(index, content) {
  const asOf = chartLatestDate(index);
  const groups = content.medication_groups || [];
  const byText = {};
  index.medications.forEach(m => byText[m.text] = m);
  const grouped = new Set();
  let html = "";
  groups.forEach(g => {
    const meds = g.codes.map(c => byText[c]).filter(Boolean);
    meds.forEach(m => grouped.add(m.text));
    if (meds.length) html += `<div class="med-group"><div class="cond-group-title">${escapeHtml(g.label)}</div>${medTable(meds, asOf)}</div>`;
  });
  const rest = index.medications.filter(m => !grouped.has(m.text));
  if (rest.length) html += `<div class="med-group"><div class="cond-group-title">Other</div>${medTable(rest, asOf)}</div>`;
  return html || `<div class="empty-note">No medications on record.</div>`;
}

/* ---- Shared band-list component (clinical numbers + wearables) ---- */
function bandListHeader(col2, col3) {
  return `<div class="band-list-header"><span></span><span>${escapeHtml(col2)}</span><span>${escapeHtml(col3)}</span></div>`;
}

function biomarkerBandRow(b) {
  const band = REFERENCE_BANDS[b.code];
  const rangeText = band ? `${band.low}–${band.high} ${band.unit}` : "—";
  const unit = cleanUnit(b.unit) || "";
  const latest = b.latest ? `${b.latest.value}${unit ? " " + unit : ""}` : "—";
  const id = "clin-" + sanitizeId(b.code);
  const chart = b.trajectory_available
    ? renderLineChart(b.readings.map(r => ({ date: r.date, value: r.value })), { unit: unit ? " " + unit : "" })
    : `<div class="empty-note">Only single value recorded.</div>`;
  const safeRange = band ? `<div class="band-safe-range"><span class="dot-key"></span>Safe range: ${band.low}–${band.high} ${band.unit} (${escapeHtml(band.label)})</div>` : "";
  return `<div class="band-row" data-band-row="${id}">
    <button class="band-head" type="button" data-band-toggle="${id}">
      <span class="band-name">${escapeHtml(cleanLabel(b.label))}</span>
      <span class="band-val mono">${escapeHtml(latest)}</span>
      <span class="band-range mono">${escapeHtml(rangeText)}</span>
    </button>
    <div class="band-body" id="body-${id}">${safeRange}${chart}</div>
  </div>`;
}

function qualitativeRow(q) {
  return `<div class="band-row band-row-static">
    <div class="band-head">
      <span class="band-name">${escapeHtml(cleanLabel(q.label))}</span>
      <span class="band-val mono">${escapeHtml(q.latest ? String(q.latest.value) : "—")}</span>
      <span class="band-range mono">—</span>
    </div>
  </div>`;
}

function renderClinicalNumbers(index, content) {
  const extra = Object.values(content.conditions_extra || {})[0];
  const relevantCodes = (extra && extra.relevant_biomarker_codes) || [];
  const priority = [...new Set([...relevantCodes, ...VITALS_PRIORITY])];
  const eligible = index.biomarkers.filter(b => !isExcludedFromClinical(b));
  const byCode = {};
  eligible.forEach(b => byCode[b.code] = b);
  const priorityBiomarkers = priority.filter(c => byCode[c]).map(c => byCode[c]);
  const usedCodes = new Set(priorityBiomarkers.map(b => b.code));
  const restBiomarkers = eligible.filter(b => !usedCodes.has(b.code)).sort((a, b) => (a.label || "").localeCompare(b.label || ""));
  const ordered = [...priorityBiomarkers, ...restBiomarkers];

  let html = bandListHeader("Latest value", "Safe range");
  html += ordered.length
    ? `<div class="band-list">${ordered.map(biomarkerBandRow).join("")}</div>`
    : `<div class="empty-note">No biomarkers indexed for this patient.</div>`;

  if (index.qualitative_observations.length) {
    html += `<div class="cond-group-title">Qualitative findings</div>`;
    html += `<div class="band-list">${index.qualitative_observations.map(qualitativeRow).join("")}</div>`;
  }
  return html;
}

/* ---- Wearable variables ---- */
const WEARABLE_FEATURES = [
  { key: "steps", label: "Steps", unit: "" },
  { key: "distance", label: "Distance", unit: "m" },
  { key: "calories", label: "Calories burned", unit: "" },
  { key: "bpm", label: "Heart rate (all-day avg)", unit: "bpm" },
  { key: "resting_hr", label: "Resting heart rate", unit: "bpm" },
  { key: "rmssd", label: "Heart rate variability (RMSSD)", unit: "ms" },
  { key: "spo2", label: "SpO₂", unit: "%" },
  { key: "full_sleep_breathing_rate", label: "Respiratory rate (sleep)", unit: "br/min" },
  { key: "nightly_temperature", label: "Nightly skin temperature", unit: "°C" },
  { key: "sleep_duration_hrs", label: "Sleep duration", unit: "hrs" },
  { key: "sleep_efficiency", label: "Sleep efficiency", unit: "%" },
  { key: "minutesAwake", label: "Minutes awake (during sleep)", unit: "min" },
  { key: "stress_score", label: "Stress score", unit: "" },
  { key: "very_active_minutes", label: "Vigorous activity", unit: "min" },
  { key: "sedentary_minutes", label: "Sedentary time", unit: "min" }
];
function wearableValue(row, key) {
  if (key === "sleep_duration_hrs") return row.sleep_duration != null ? row.sleep_duration / 3600000 : null;
  return row[key];
}
function wearableBandRow(feature, daily) {
  const series = daily.map(d => ({ date: d.date, value: wearableValue(d, feature.key) }));
  const vals = series.map(p => p.value).filter(v => typeof v === "number");
  const avg = round1(mean(vals));
  const dev = round1(stddev(vals));
  const id = "wear-" + sanitizeId(feature.key);
  const unit = feature.unit ? ` ${feature.unit}` : "";
  const chart = vals.length
    ? renderLineChart(series, { unit })
    : `<div class="empty-note">Not recorded for this patient.</div>`;
  return `<div class="band-row" data-band-row="${id}">
    <button class="band-head" type="button" data-band-toggle="${id}">
      <span class="band-name">${escapeHtml(feature.label)}</span>
      <span class="band-val mono">${avg != null ? round1(avg) + unit : "not recorded"}</span>
      <span class="band-range mono">${dev != null ? "±" + dev + unit : "—"}</span>
    </button>
    <div class="band-body" id="body-${id}">${chart}</div>
  </div>`;
}
function renderWearables(wearable) {
  return bandListHeader("Average", "Deviation") +
    `<div class="band-list">${WEARABLE_FEATURES.map(f => wearableBandRow(f, wearable.daily)).join("")}</div>`;
}

/* ---- Flag cards (rendered inside modals, not inline) ---- */
function flagCardHtml(f, state, selected) {
  const sevClass = f.severity === "High" ? "rust" : f.severity === "Medium" ? "amber" : "";
  const statusClass = f.status === "fixed" ? "teal" : "rust";
  const comments = state.comments[f.id] || [];
  return `<div class="flag-card" data-flag="${f.id}">
    <div class="flag-head">
      ${selected ? `<input type="checkbox" class="flag-select" data-select-flag="${f.id}" aria-label="Select ${escapeHtml(f.title)}" ${selected.has(f.id) ? "checked" : ""}>` : ""}
      <span class="flag-title">${escapeHtml(f.title)}</span>
      <span class="tag ${statusClass}">${f.status === "fixed" ? "Fixed" : "Open"}</span>
    </div>
    <div class="flag-desc">${escapeHtml(f.description)}</div>
    ${f.proposed_fix ? `<div class="flag-desc"><strong>Proposed fix:</strong> ${escapeHtml(f.proposed_fix)}</div>` : ""}
    <div class="flag-tags"><span class="tag ${sevClass}">${escapeHtml(f.severity)} urgency</span></div>
    <div class="flag-audit">${f.status === "fixed" ? `Fixed by ${escapeHtml(f.fixed_by)} · ${escapeHtml(f.fixed_date)}` : `Flagged by ${escapeHtml(f.opened_by)} · ${escapeHtml(f.opened_date)}`}</div>
    ${comments.length ? `<div class="flag-comments">${comments.map(c => `<div class="flag-comment"><span class="who">${escapeHtml(c.who)}</span> · ${escapeHtml(c.date)}: ${escapeHtml(c.text)}</div>`).join("")}</div>` : ""}
    <div class="flag-actions">
      <button class="btn" data-comment-toggle="${f.id}" type="button">Add comment</button>
    </div>
    <div class="comment-input-row" id="comment-row-${f.id}" style="display:none;">
      <input type="text" placeholder="Add a note..." id="comment-input-${f.id}">
      <button class="btn" data-submit-comment="${f.id}" type="button">Post</button>
    </div>
  </div>`;
}

/* Assistant tab rendering lives in assets/js/assistant.js (real API-backed chat). */

/* ---- Tabs ---- */
function wireTabs() {
  document.querySelectorAll(".tab-btn").forEach(b => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(x => x.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      document.getElementById("tab-" + b.dataset.tab).classList.add("active");
    });
  });
}

/* ---- Init ---- */
(async function () {
  const patients = await loadPatients();
  const requested = getParam("patient");
  const patient = patients.find(p => p.id === requested) || patients[0];
  const [{ index, wearable, content }, state] = await Promise.all([
    loadPatientBundle(patient.folder), getPatientState(patient.id), loadIdentity()
  ]);
  mountDrawer(patients, patient.id);
  mountTopBar({ patient, page: "review" });

  document.getElementById("narrative").innerHTML = content.narrative.map(line => `<p>${escapeHtml(line)}</p>`).join("");

  function renderAccordion() {
    const el = document.getElementById("accordion");
    el.innerHTML = [
      accRow("conditions", "Diagnosed conditions", null, renderConditions(content, index), { open: true }),
      accRow("medications", "Medications", index.medications.length, renderMedications(index, content), {}),
      accRow("clinical", "Clinical numbers", null, renderClinicalNumbers(index, content), {}),
      accRow("wearables", "Wearable variables", null, renderWearables(wearable), {})
    ].join("");
    document.querySelectorAll(".acc-head").forEach(h => {
      h.addEventListener("click", () => h.closest(".acc-row").classList.toggle("open"));
    });
  }
  renderAccordion();
  wireTabs();
  renderAssistant(patient, index, wearable, content, state);

  /* ---- Flag panels (modals) ---- */
  let currentPanelType = null;
  // Open flags ticked for the next "mark fixed" batch; survives panel re-renders.
  const selectedForFix = new Set();
  function showFlagsPanel(type) {
    currentPanelType = type;
    const flags = state.flags.filter(f => type === "open" ? f.status !== "fixed" : f.status === "fixed");
    [...selectedForFix].forEach(id => { if (!flags.some(f => f.id === id)) selectedForFix.delete(id); });
    let body = flags.length
      ? flags.map(f => flagCardHtml(f, state, type === "open" ? selectedForFix : null)).join("")
      : `<div class="empty-note">Nothing here yet.</div>`;
    if (type === "open" && flags.length) {
      const n = selectedForFix.size;
      body = `<div class="fix-bar">
        <label class="fix-bar-all"><input type="checkbox" id="select-all-flags" ${n === flags.length ? "checked" : ""}> Select all</label>
        <button class="btn primary" id="mark-fixed" type="button" ${n ? "" : "disabled"}>${n ? `Mark ${n} fixed` : "Mark fixed"}</button>
      </div>
      <p class="section-note fix-bar-note">Fixes marked together count as one new profile version.</p>` + body;
    }
    openModal(type === "open" ? "Open inconsistencies" : "Fixed & verified", body);
  }
  // Updates the batch bar in place (re-rendering the modal would lose scroll position).
  function updateFixBar() {
    const n = selectedForFix.size;
    const btn = document.getElementById("mark-fixed");
    if (btn) { btn.disabled = !n; btn.textContent = n ? `Mark ${n} fixed` : "Mark fixed"; }
    const all = document.getElementById("select-all-flags");
    const boxes = document.querySelectorAll("[data-select-flag]");
    if (all) all.checked = boxes.length > 0 && n === boxes.length;
  }
  function refreshPanelIfOpen() {
    if (currentPanelType) showFlagsPanel(currentPanelType);
  }
  function refreshBanner() {
    mountStatusBanner(state);
    document.getElementById("stat-open").addEventListener("click", () => showFlagsPanel("open"));
    document.getElementById("stat-fixed").addEventListener("click", () => showFlagsPanel("fixed"));
  }
  refreshBanner();

  document.getElementById("add-flag-btn").addEventListener("click", () => {
    openModal("Add inconsistency", `
      <div>
        <input type="text" id="new-flag-title" placeholder="Title" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:5px;font-family:inherit;font-size:13.5px;margin-bottom:8px;">
        <textarea id="new-flag-desc" placeholder="Description" rows="2" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:5px;font-family:inherit;font-size:13.5px;margin-bottom:8px;"></textarea>
        <textarea id="new-flag-fix" placeholder="Proposed fix" rows="2" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:5px;font-family:inherit;font-size:13.5px;margin-bottom:8px;"></textarea>
        <select id="new-flag-urgency" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:5px;font-family:inherit;font-size:13.5px;margin-bottom:10px;">
          <option value="High">High urgency</option>
          <option value="Medium" selected>Medium urgency</option>
          <option value="Low">Low urgency</option>
        </select>
        <button class="btn primary" id="submit-new-flag" type="button">Add flag</button>
      </div>`);
  });

  /* Saves one change to the shared server state, disabling the clicked
     button meanwhile so a double-click can't submit twice. */
  async function saveOp(button, op, onSaved) {
    if (button.disabled) return;
    button.disabled = true;
    try {
      await applyReviewOp(patient.id, state, op);
      onSaved();
    } catch (e) {
      alert(`Couldn't save: ${e.message}`);
    } finally {
      button.disabled = false;
    }
  }

  /* Delegated: handles clicks inside the page AND inside modal content. */
  document.addEventListener("click", e => {
    const toggle = e.target.closest && e.target.closest("[data-band-toggle]");
    if (toggle) {
      document.getElementById("body-" + toggle.dataset.bandToggle).closest(".band-row").classList.toggle("open");
      return;
    }
    const t = e.target;
    if (t.dataset && t.dataset.commentToggle) {
      const row = document.getElementById("comment-row-" + t.dataset.commentToggle);
      row.style.display = row.style.display === "none" ? "flex" : "none";
      return;
    }
    if (t.dataset && t.dataset.submitComment) {
      const id = t.dataset.submitComment;
      const input = document.getElementById("comment-input-" + id);
      if (input.value.trim()) {
        saveOp(t, { op: "add_comment", flag_id: id, text: input.value.trim() }, () => {
          refreshPanelIfOpen();
          refreshBanner();
        });
      }
      return;
    }
    if (t.dataset && t.dataset.selectFlag) {
      t.checked ? selectedForFix.add(t.dataset.selectFlag) : selectedForFix.delete(t.dataset.selectFlag);
      updateFixBar();
      return;
    }
    if (t.id === "select-all-flags") {
      document.querySelectorAll("[data-select-flag]").forEach(box => {
        box.checked = t.checked;
        t.checked ? selectedForFix.add(box.dataset.selectFlag) : selectedForFix.delete(box.dataset.selectFlag);
      });
      updateFixBar();
      return;
    }
    if (t.dataset && t.dataset.revertVersion) {
      const target = Number(t.dataset.revertVersion);
      const undone = state.version_history.filter(v => v.version > target);
      const reopen = new Set(undone.flatMap(v => v.flag_ids || [])).size;
      const msg = `Roll back to v${target}?\n\nThis reopens ${reopen} fixed inconsistenc${reopen === 1 ? "y" : "ies"} and removes v${target + 1}${state.version > target + 1 ? `–v${state.version}` : ""} from the history.`;
      if (!confirm(msg)) return;
      saveOp(t, { op: "revert_to_version", version: target }, () => {
        refreshBanner();
        document.getElementById("version-history-link").click(); // show the updated history
      });
      return;
    }
    if (t.id === "mark-fixed" && selectedForFix.size) {
      saveOp(t, { op: "fix_flags", flag_ids: [...selectedForFix] }, () => {
        selectedForFix.clear();
        refreshPanelIfOpen();
        refreshBanner();
      });
      return;
    }
    if (t.id === "submit-new-flag") {
      const title = document.getElementById("new-flag-title").value.trim();
      const desc = document.getElementById("new-flag-desc").value.trim();
      const fix = document.getElementById("new-flag-fix").value.trim();
      const urgency = document.getElementById("new-flag-urgency").value;
      if (title && desc) {
        saveOp(t, { op: "add_flag", title, description: desc, proposed_fix: fix, severity: urgency }, () => {
          refreshBanner();
          const root = document.getElementById("modal-root");
          if (root) root.innerHTML = "";
        });
      }
      return;
    }
  });
})().catch(showLoadError);
