/* Team Dashboard screen (dashboard.html) */

function computeAggregate(bundles) {
  let totalFlags = 0, open = 0, fixed = 0, reviewed = 0;
  const severityCounts = {};
  bundles.forEach(({ state }) => {
    totalFlags += state.flags.length;
    const c = flagCounts(state);
    open += c.open; fixed += c.fixed;
    if (c.fixed > 0 || Object.keys(state.comments).length > 0) reviewed++;
    state.flags.forEach(f => { severityCounts[f.severity] = (severityCounts[f.severity] || 0) + 1; });
  });
  return { totalFlags, open, fixed, reviewed, severityCounts };
}

function buildActivityFeed(bundles) {
  const events = [];
  bundles.forEach(({ patient, state }) => {
    state.flags.forEach(f => {
      events.push({ date: f.opened_date, who: f.opened_by, verb: "flagged", detail: f.title, patient: patient.name });
      if (f.status === "fixed") events.push({ date: f.fixed_date, who: f.fixed_by, verb: "fixed", detail: f.title, patient: patient.name });
    });
    Object.values(state.comments).forEach(list => {
      list.forEach(c => events.push({ date: c.date, who: c.who, verb: "commented on", detail: c.text, patient: patient.name }));
    });
  });
  events.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return events.slice(0, 15);
}

(async function () {
  const [patients, states] = await Promise.all([loadPatients(), getAllPatientStates(), loadIdentity()]);
  mountDrawer(patients, null);
  mountTopBar({ patient: null, page: "dashboard" });

  const bundles = patients.map(patient => ({ patient, state: states[patient.id] }));

  const agg = computeAggregate(bundles);

  document.getElementById("dash-chips").innerHTML = `
    <div class="dash-chip"><div class="num">${agg.reviewed} / ${patients.length}</div><div class="lbl">Profiles reviewed</div></div>
    <div class="dash-chip"><div class="num">${agg.totalFlags}</div><div class="lbl">Total flags</div></div>
    <div class="dash-chip"><div class="num" style="color:var(--rust);">${agg.open}</div><div class="lbl">Open</div></div>
    <div class="dash-chip"><div class="num" style="color:var(--teal);">${agg.fixed}</div><div class="lbl">Fixed</div></div>
  `;

  document.getElementById("dash-by-patient").innerHTML = bundles.map(({ patient, state }) => {
    const c = flagCounts(state);
    const openPct = c.total ? (c.open / c.total) * 100 : 0;
    const fixedPct = c.total ? (c.fixed / c.total) * 100 : 0;
    return `<div class="bar-row">
      <div class="bar-label"><span>${escapeHtml(patient.condition_tag)}</span><span class="n">${c.open} open · ${c.fixed} fixed</span></div>
      <div class="bar-track">
        <div class="bar-open" style="width:${openPct}%"></div>
        <div class="bar-fixed" style="width:${fixedPct}%"></div>
      </div>
    </div>`;
  }).join("");

  const sevOrder = ["High", "Medium", "Low"];
  const sevEntries = sevOrder.filter(s => agg.severityCounts[s]).map(s => [s, agg.severityCounts[s]]);
  const maxSev = sevEntries.length ? Math.max(...sevEntries.map(e => e[1])) : 1;
  document.getElementById("dash-by-type").innerHTML = sevEntries.length
    ? sevEntries.map(([sev, n]) => `<div class="bar-row">
        <div class="bar-label"><span>${escapeHtml(sev)} urgency</span><span class="n">${n}</span></div>
        <div class="type-bar-track"><div class="type-bar-fill" style="width:${(n / maxSev) * 100}%"></div></div>
      </div>`).join("")
    : `<div class="empty-note">No flags raised yet.</div>`;

  const feed = buildActivityFeed(bundles);
  document.getElementById("dash-activity").innerHTML = feed.length
    ? feed.map(e => `<li>
        <span class="act-time mono">${escapeHtml(e.date || "")}</span>
        <span><span class="act-who">${escapeHtml(e.who || "")}</span> ${escapeHtml(e.verb)} <em>${escapeHtml(e.detail)}</em> on ${escapeHtml(e.patient)}</span>
      </li>`).join("")
    : `<li class="empty-note">No activity yet.</li>`;
})().catch(showLoadError);
