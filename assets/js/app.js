/* Shared chrome: drawer, top bar, status banner, modal. Used by all 3 pages. */

function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function patientUrl(patient) {
  return `index.html?patient=${encodeURIComponent(patient.id)}`;
}

function getParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

/* ---------- Drawer ---------- */
function mountDrawer(patients, activePatientId) {
  const root = document.createElement("div");
  root.innerHTML = `
    <div class="drawer-overlay" id="drawer-overlay"></div>
    <nav class="drawer" id="drawer">
      <div class="drawer-header">
        <h3>Patients</h3>
        <button class="icon-btn" id="drawer-close" aria-label="Close">&times;</button>
      </div>
      <div class="drawer-list">
        ${patients.map(p => `
          <a class="drawer-item ${p.id === activePatientId ? "active" : ""}" href="${patientUrl(p)}">
            <span class="dname">${escapeHtml(p.name)}</span>
            <span class="dtag">${escapeHtml(p.condition_tag)}</span>
          </a>`).join("")}
      </div>
    </nav>`;
  document.body.appendChild(root);

  const drawer = document.getElementById("drawer");
  const overlay = document.getElementById("drawer-overlay");
  const close = () => { drawer.classList.remove("open"); overlay.classList.remove("open"); };
  const open = () => { drawer.classList.add("open"); overlay.classList.add("open"); };
  overlay.addEventListener("click", close);
  document.getElementById("drawer-close").addEventListener("click", close);
  window.__openDrawer = open;
}

/* ---------- Top bar ---------- */
function mountTopBar({ patient, page }) {
  const bar = document.getElementById("topbar");
  const doctor = getCurrentDoctor();
  bar.innerHTML = `
    <button class="icon-btn" id="hamburger" aria-label="Open patient list">&#9776;</button>
    <span class="brand">Chart QA</span>
    ${patient ? `
      <span class="patient-id">
        <span class="name">${escapeHtml(patient.name)}</span>
        <span class="tag">${escapeHtml(patient.condition_tag)}</span>
      </span>` : `<span class="patient-id"><span class="name">Team Dashboard</span></span>`}
    <span class="spacer"></span>
    ${page === "dashboard"
      ? `<a class="top-link" href="${patient ? patientUrl(patient) : "index.html"}">← Patient review</a>`
      : `<a class="top-link" href="dashboard.html">Team Dashboard</a>`}
    ${page === "review" ? `
      <div class="add-flag-wrap">
        <button class="icon-btn add-flag-btn" id="add-flag-btn" aria-label="Add inconsistency" type="button">+</button>
        <span class="add-flag-tooltip">Add inconsistency</span>
      </div>` : ""}
    <span class="doctor-id" title="Signed in as ${escapeHtml(doctor)}">
      <span class="avatar">${escapeHtml(initials(doctor))}</span>
      <span class="doctor-email">${escapeHtml(doctor)}</span>
      <a class="top-link sign-out" href="/api/auth/logout">Sign out</a>
    </span>
  `;
  document.getElementById("hamburger").addEventListener("click", () => window.__openDrawer && window.__openDrawer());
}

/* ---------- Status banner ---------- */
function mountStatusBanner(state) {
  const el = document.getElementById("status-banner");
  if (!el) return;
  const c = flagCounts(state);
  el.innerHTML = `
    <div class="stat open clickable" id="stat-open"><div class="num mono">${c.open}</div><div class="lbl">Open flags</div></div>
    <div class="stat fixed clickable" id="stat-fixed"><div class="num mono">${c.fixed}</div><div class="lbl">Fixed &amp; verified</div></div>
    <div class="stat"><div class="num mono">${Object.values(state.comments).reduce((a, arr) => a + arr.length, 0)}</div><div class="lbl">Total notes</div></div>
    <div class="stat"><div class="num mono">v${state.version}</div><div class="lbl">Current version</div></div>
    <a class="banner-link" href="#" id="version-history-link">Version history &amp; roll back ›</a>
  `;
  document.getElementById("version-history-link").addEventListener("click", e => {
    e.preventDefault();
    openModal("Version history", `
      <ul style="padding-left:18px;margin:0;">
        ${[...state.version_history].reverse().map(v => `
          <li class="version-row">
            <div><strong class="mono">v${v.version}</strong> — ${escapeHtml(v.change)}</div>
            <div class="section-note">${escapeHtml(v.by)} · ${escapeHtml(v.date)}</div>
            ${v.version === state.version
              ? `<span class="tag teal">Current</span>`
              : `<button class="btn" data-revert-version="${v.version}" type="button">Roll back to v${v.version}</button>`}
          </li>`).join("")}
      </ul>
      ${state.version_history.length > 1 ? `<p class="section-note">Rolling back reopens every inconsistency fixed after that version and removes the later versions.</p>` : ""}`);
  });
}

/* ---------- Modal ---------- */
function openModal(title, bodyHtml) {
  let root = document.getElementById("modal-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "modal-root";
    document.body.appendChild(root);
  }
  root.innerHTML = `
    <div style="position:fixed;inset:0;background:rgba(27,29,34,0.35);z-index:80;display:flex;align-items:center;justify-content:center;" id="modal-overlay">
      <div style="background:#fff;border-radius:8px;max-width:520px;width:92%;max-height:80vh;overflow-y:auto;padding:22px 24px;border:1px solid #E3E1DA;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
          <h3 style="margin:0;">${escapeHtml(title)}</h3>
          <button class="icon-btn" id="modal-close">&times;</button>
        </div>
        ${bodyHtml}
      </div>
    </div>`;
  const close = () => { root.innerHTML = ""; };
  document.getElementById("modal-overlay").addEventListener("click", e => { if (e.target.id === "modal-overlay") close(); });
  document.getElementById("modal-close").addEventListener("click", close);
}
