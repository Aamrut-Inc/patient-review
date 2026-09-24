/* Dependency-free SVG line chart with a shared hover tooltip.
   Handles gaps (null values) by breaking the line into segments rather than
   interpolating across them. */

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return iso.slice(0, 10);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
function fmtDateShort(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return iso.slice(0, 10);
  const mon = d.toLocaleDateString(undefined, { month: "short" });
  const yy = String(d.getFullYear()).slice(-2);
  return `${mon} '${yy}`;
}

/* ---- Shared tooltip (one div, reused by every chart) ---- */
function ensureTooltipEl() {
  let el = document.getElementById("chart-tooltip");
  if (!el) {
    el = document.createElement("div");
    el.id = "chart-tooltip";
    el.className = "chart-tooltip";
    document.body.appendChild(el);
  }
  return el;
}
function showTooltip(evt, text) {
  const el = ensureTooltipEl();
  el.textContent = text;
  el.style.display = "block";
  moveTooltip(evt);
}
function moveTooltip(evt) {
  const el = ensureTooltipEl();
  el.style.left = (evt.clientX + 12) + "px";
  el.style.top = (evt.clientY + 12) + "px";
}
function hideTooltip() {
  const el = ensureTooltipEl();
  el.style.display = "none";
}

/* Delegated on document (once) so dynamically re-rendered charts never need re-wiring. */
document.addEventListener("mouseover", e => {
  const t = e.target.closest && e.target.closest("[data-tip]");
  if (t) showTooltip(e, t.getAttribute("data-tip"));
});
document.addEventListener("mousemove", e => {
  if (e.target.closest && e.target.closest("[data-tip]")) moveTooltip(e);
});
document.addEventListener("mouseout", e => {
  if (e.target.closest && e.target.closest("[data-tip]")) hideTooltip();
});

/* points: [{date, value}], value may be null (gap, not interpolated). */
function renderLineChart(points, opts = {}) {
  const W = opts.width || 640;
  const H = opts.height || 170;
  const padL = 34, padR = 14, padT = 14, padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const values = points.map(p => p.value).filter(v => typeof v === "number");
  if (values.length === 0) return `<div class="empty-note">No numeric readings to chart.</div>`;

  let lo = Math.min(...values);
  let hi = Math.max(...values);
  const span = (hi - lo) || 1;
  lo -= span * 0.1;
  hi += span * 0.1;

  const n = points.length;
  const x = i => padL + (n === 1 ? plotW / 2 : (plotW * i) / (n - 1));
  const y = v => padT + plotH - ((v - lo) / (hi - lo)) * plotH;

  let svg = `<svg class="line-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">`;

  // axes
  svg += `<line class="axis-line" x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}"></line>`;
  svg += `<line class="axis-line" x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}"></line>`;
  svg += `<line class="axis-tick" x1="${padL - 3}" y1="${padT}" x2="${padL}" y2="${padT}"></line>`;
  svg += `<line class="axis-tick" x1="${padL - 3}" y1="${padT + plotH}" x2="${padL}" y2="${padT + plotH}"></line>`;

  // segmented polylines (break at gaps)
  let seg = [];
  const segments = [];
  points.forEach((p, i) => {
    if (typeof p.value === "number") seg.push({ i, ...p });
    else { if (seg.length) segments.push(seg); seg = []; }
  });
  if (seg.length) segments.push(seg);
  segments.forEach(s => {
    const pts = s.map(p => `${x(p.i)},${y(p.value)}`).join(" ");
    svg += `<polyline class="line" points="${pts}"></polyline>`;
  });

  // dots (with data-tip for the shared tooltip)
  points.forEach((p, i) => {
    if (typeof p.value !== "number") return;
    const tip = `${p.value}${opts.unit || ""} — ${fmtDateShort(p.date)}`;
    svg += `<circle class="dot" data-tip="${escapeHtml(tip)}" cx="${x(i)}" cy="${y(p.value)}" r="1.8"></circle>`;
  });

  svg += `<text class="axis-text" x="${padL}" y="${H - 8}">${fmtDate(points[0].date)}</text>`;
  svg += `<text class="axis-text" x="${padL + plotW}" y="${H - 8}" text-anchor="end">${fmtDate(points[n - 1].date)}</text>`;
  svg += `<text class="axis-text" x="${padL - 6}" y="${padT + 4}" text-anchor="end">${hi.toFixed(1)}</text>`;
  svg += `<text class="axis-text" x="${padL - 6}" y="${padT + plotH}" text-anchor="end">${lo.toFixed(1)}</text>`;
  svg += `<text class="chart-legend" x="${padL + plotW}" y="${padT + 2}" text-anchor="end">${values.length} reading${values.length === 1 ? "" : "s"}</text>`;

  svg += `</svg>`;
  return svg;
}
