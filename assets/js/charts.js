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

/* "3 mo", "1y 2mo", "12 d" — gap between two readings, for tooltips. */
function fmtGap(fromIso, toIso) {
  const days = Math.round((new Date(toIso) - new Date(fromIso)) / 86400000);
  if (!isFinite(days)) return null;
  if (days < 1) return "same day";
  if (days < 45) return `${days} d`;
  const months = Math.round(days / 30.44);
  if (months < 12) return `${months} mo`;
  const y = Math.floor(months / 12), m = months % 12;
  return m ? `${y}y ${m}mo` : `${y}y`;
}

/* Calendar-aligned x-axis ticks for [t0, t1] (ms): at most ~7, so labels never crowd. */
function timeTicks(t0, t1) {
  const days = (t1 - t0) / 86400000;
  const d0 = new Date(t0);
  const ticks = [];
  if (days > 540) {
    const years = days / 365.25;
    const step = years > 21 ? 5 : years > 12 ? 2 : 1;
    let y = Math.ceil(d0.getFullYear() / step) * step;
    if (new Date(y, 0, 1).getTime() < t0) y += step;
    for (; new Date(y, 0, 1).getTime() <= t1; y += step) ticks.push({ t: new Date(y, 0, 1).getTime(), label: String(y) });
  } else if (days > 45) {
    const step = days > 300 ? 3 : days > 150 ? 2 : 1;
    const d = new Date(d0.getFullYear(), d0.getMonth() + 1, 1);
    while (d.getMonth() % step) d.setMonth(d.getMonth() + 1);
    for (; d.getTime() <= t1; d.setMonth(d.getMonth() + step)) {
      const mon = d.toLocaleDateString(undefined, { month: "short" });
      ticks.push({ t: d.getTime(), label: d.getMonth() === 0 ? `${mon} '${String(d.getFullYear()).slice(-2)}` : mon });
    }
  } else {
    const d = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + 1);
    const step = days > 21 ? 7 : days > 8 ? 3 : 1;
    for (; d.getTime() <= t1; d.setDate(d.getDate() + step)) {
      ticks.push({ t: d.getTime(), label: d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) });
    }
  }
  return ticks;
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
  if (t) showTooltip(e, t.getAttribute("data-tip") + (t.getAttribute("data-tip-extra") || ""));
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
  const padL = 34, padR = 14, padT = 14, padB = 36;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const values = points.map(p => p.value).filter(v => typeof v === "number");
  if (values.length === 0) return `<div class="empty-note">No numeric readings to chart.</div>`;

  let lo = Math.min(...values);
  let hi = Math.max(...values);
  const span = (hi - lo) || 1;
  lo -= span * 0.1;
  hi += span * 0.1;

  // x is proportional to TIME (not reading index), so horizontal distance
  // between two points shows how far apart they were taken.
  const n = points.length;
  const ts = points.map(p => new Date(p.date).getTime());
  const t0 = Math.min(...ts), t1 = Math.max(...ts);
  const tx = t => padL + (t1 === t0 ? plotW / 2 : (plotW * (t - t0)) / (t1 - t0));
  const x = i => tx(ts[i]);
  const y = v => padT + plotH - ((v - lo) / (hi - lo)) * plotH;

  let svg = `<svg class="line-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">`;

  // faint calendar gridlines + labels (years / months / days by span)
  const ticks = t1 > t0 ? timeTicks(t0, t1) : [];
  ticks.forEach(tk => {
    const gx = tx(tk.t);
    svg += `<line class="grid-line" x1="${gx}" y1="${padT}" x2="${gx}" y2="${padT + plotH}"></line>`;
    svg += `<text class="axis-text tick-label" x="${gx}" y="${padT + plotH + 11}" text-anchor="middle">${escapeHtml(tk.label)}</text>`;
  });

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
  // data-tip is the reading itself (also used as a flag's quote); the gap
  // to the previous reading is display-only, in data-tip-extra.
  let prevDate = null;
  points.forEach((p, i) => {
    if (typeof p.value !== "number") return;
    const tip = `${p.value}${opts.unit || ""} — ${fmtDate(p.date)}`;
    const gap = prevDate ? fmtGap(prevDate, p.date) : null;
    prevDate = p.date;
    svg += `<circle class="dot" data-tip="${escapeHtml(tip)}"${gap ? ` data-tip-extra=" · ${escapeHtml(gap)} after previous"` : ""} cx="${x(i)}" cy="${y(p.value)}" r="1.8"></circle>`;
  });

  svg += `<text class="axis-text" x="${padL}" y="${H - 8}">${fmtDate(points[0].date)}</text>`;
  svg += `<text class="axis-text" x="${padL + plotW}" y="${H - 8}" text-anchor="end">${fmtDate(points[n - 1].date)}</text>`;
  svg += `<text class="axis-text" x="${padL - 6}" y="${padT + 4}" text-anchor="end">${hi.toFixed(1)}</text>`;
  svg += `<text class="axis-text" x="${padL - 6}" y="${padT + plotH}" text-anchor="end">${lo.toFixed(1)}</text>`;
  svg += `<text class="chart-legend" x="${padL + plotW}" y="${padT + 2}" text-anchor="end">${values.length} reading${values.length === 1 ? "" : "s"}</text>`;

  svg += `</svg>`;
  return svg;
}
