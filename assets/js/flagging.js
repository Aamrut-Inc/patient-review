/* Location-aware flagging on the Patient Review screen.

   Any element carrying data-anchor="<key>" (+ data-anchor-label) is a place
   an inconsistency can be pinned to: summary paragraphs, condition pills,
   medication rows, clinical-number and wearable rows, accordion sections,
   and assistant answers. Reviewers flag by right-clicking, or by
   highlighting text and pressing the floating "Flag" button; the highlighted
   text becomes the flag's quote. Every anchor with flags gets an
   "N inconsistencies" badge, and flag cards can jump back to their spot.

   review.js calls initFlagging({ patient, state, onChanged, showFlagsPanel })
   once; assistant.js calls decorateAnchors() after each chat re-render. */

let FLAG_CTX = null;

function initFlagging(ctx) {
  FLAG_CTX = ctx;
  document.addEventListener("contextmenu", onContextMenu);
  document.addEventListener("mouseup", () => setTimeout(updateSelectionButton, 0));
  // Catches keyboard selection and any click pattern mouseup timing misses.
  let selTimer = null;
  document.addEventListener("selectionchange", () => { clearTimeout(selTimer); selTimer = setTimeout(updateSelectionButton, 180); });
  document.addEventListener("mousedown", e => {
    if (!e.target.closest(".ctx-menu")) closeContextMenu();
    if (!e.target.closest(".sel-flag-btn")) hideSelectionButton();
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape") { closeContextMenu(); hideSelectionButton(); } });
  window.addEventListener("scroll", () => { closeContextMenu(); hideSelectionButton(); }, true);
  document.addEventListener("click", e => {
    const graph = e.target.closest && e.target.closest(".graph-wrap[data-anchor]");
    if (!graph) return;
    if (e.target.closest("[data-graph-flag]")) openQuickAdd(anchorFromElement(graph));
    else if (e.target.matches("circle.dot[data-tip]")) {
      hideTooltip();
      openQuickAdd(anchorFromElement(graph, `Reading: ${e.target.getAttribute("data-tip")}`));
    }
  });
  // Capture phase: badges sit inside buttons (accordion/band heads) that
  // would otherwise toggle open/closed on the same click.
  document.addEventListener("click", onBadgeClick, true);
  document.addEventListener("keydown", e => {
    if ((e.key === "Enter" || e.key === " ") && e.target.classList && e.target.classList.contains("loc-badge")) onBadgeClick(e);
  }, true);
  decorateAnchors();
}

/* ---- Reading an anchor off the page ---- */
function anchorFromElement(el, quote) {
  const anchor = { key: el.dataset.anchor, label: el.dataset.anchorLabel || el.dataset.anchor };
  if (quote) anchor.quote = quote;
  if (anchor.key.startsWith("chat:")) {
    // Chat history is per-browser, so snapshot the exchange for teammates.
    let q = el.previousElementSibling;
    while (q && !q.classList.contains("user")) q = q.previousElementSibling;
    anchor.context = `Q: ${q ? q.textContent.trim() : "(unknown)"}\n\nA: ${el.innerText.trim()}`.slice(0, 4000);
  }
  return anchor;
}

function anchorElementFor(node) {
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  return el ? el.closest("[data-anchor]") : null;
}

/* The part of the current selection that falls inside `el`, or "".
   Clipped rather than all-or-nothing: triple-clicking a paragraph (or
   double-clicking its last word) makes browsers end the selection at the
   start of the NEXT element. */
function selectedTextIn(el) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !el || !sel.rangeCount) return "";
  const range = sel.getRangeAt(0);
  const within = document.createRange();
  within.selectNodeContents(el);
  if (range.compareBoundaryPoints(Range.END_TO_START, within) >= 0 ||   // selection starts after el
      range.compareBoundaryPoints(Range.START_TO_END, within) <= 0) {   // or ends before it
    return "";
  }
  if (range.compareBoundaryPoints(Range.START_TO_START, within) > 0) within.setStart(range.startContainer, range.startOffset);
  if (range.compareBoundaryPoints(Range.END_TO_END, within) < 0) within.setEnd(range.endContainer, range.endOffset);
  return within.toString().replace(/\s+/g, " ").trim().slice(0, 2000);
}

/* The anchor the selection belongs to: where it starts (falling back to where it ends). */
function selectionAnchorElement(sel) {
  const range = sel.getRangeAt(0);
  return anchorElementFor(range.startContainer) || anchorElementFor(range.endContainer);
}

/* ---- Right-click menu ---- */
function onContextMenu(e) {
  if (e.target.closest(".ctx-menu, #modal-root, .top-bar, .status-banner, input, textarea")) return;
  const el = anchorElementFor(e.target);
  if (!el) return; // outside flaggable content: keep the browser's own menu
  e.preventDefault();
  const quote = selectedTextIn(el);
  const anchor = anchorFromElement(el, quote);
  closeContextMenu();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.innerHTML = `
    <button type="button" data-ctx="flag"><strong>Add inconsistency here</strong>
      <span class="ctx-sub">${escapeHtml(anchor.label)}${quote ? " · with selected text" : ""}</span></button>
    ${quote ? `<button type="button" data-ctx="copy">Copy selected text</button>` : ""}`;
  document.body.appendChild(menu);
  const { innerWidth: w, innerHeight: h } = window;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(e.clientX, w - r.width - 8)}px`;
  menu.style.top = `${Math.min(e.clientY, h - r.height - 8)}px`;
  menu.addEventListener("click", ev => {
    const action = ev.target.closest("[data-ctx]") && ev.target.closest("[data-ctx]").dataset.ctx;
    closeContextMenu();
    if (action === "flag") openQuickAdd(anchor);
    if (action === "copy" && navigator.clipboard) navigator.clipboard.writeText(quote).catch(() => {});
  });
}
function closeContextMenu() {
  document.querySelectorAll(".ctx-menu").forEach(m => m.remove());
}

/* ---- Floating "Flag" button on text selection ---- */
function updateSelectionButton() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || document.getElementById("modal-overlay")) { hideSelectionButton(); return; }
  const el = selectionAnchorElement(sel);
  const quote = selectedTextIn(el);
  if (!el || !quote || el.closest("#modal-root")) { hideSelectionButton(); return; }
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  let btn = document.querySelector(".sel-flag-btn");
  if (!btn) {
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sel-flag-btn";
    btn.textContent = "⚑ Flag inconsistency";
    btn.addEventListener("mousedown", e => e.preventDefault()); // keep the selection while clicking
    document.body.appendChild(btn);
  }
  btn.onclick = () => { const a = anchorFromElement(el, quote); hideSelectionButton(); openQuickAdd(a); };
  btn.style.left = `${Math.max(8, Math.min(rect.right - 150, window.innerWidth - 170))}px`;
  btn.style.top = `${rect.bottom + 6 > window.innerHeight - 40 ? rect.top - 38 : rect.bottom + 6}px`;
}
function hideSelectionButton() {
  document.querySelectorAll(".sel-flag-btn").forEach(b => b.remove());
}

/* ---- Quick add (also used by the top bar's "+" with no location) ---- */
function openQuickAdd(anchor) {
  openModal("Add inconsistency", `
    <div class="quick-add">
      <div class="qa-loc">${anchor ? `Location: <strong>${escapeHtml(anchor.label)}</strong>` : "General — not tied to a spot in the profile"}</div>
      ${anchor && anchor.quote ? `<blockquote class="flag-quote">${escapeHtml(anchor.quote)}</blockquote>` : ""}
      <input type="text" id="qa-title" placeholder="What's inconsistent? (required)" maxlength="200">
      <textarea id="qa-desc" rows="2" placeholder="Details (optional)"></textarea>
      <textarea id="qa-fix" rows="2" placeholder="Proposed fix (optional)"></textarea>
      <div class="qa-row">
        <select id="qa-urgency">
          <option value="High">High urgency</option>
          <option value="Medium" selected>Medium urgency</option>
          <option value="Low">Low urgency</option>
        </select>
        <button class="btn primary" id="qa-submit" type="button">Add flag</button>
      </div>
      <p class="qa-error" id="qa-error"></p>
    </div>`);
  const title = document.getElementById("qa-title");
  title.focus();
  const submit = async () => {
    const btn = document.getElementById("qa-submit");
    if (!title.value.trim()) { title.focus(); return; }
    btn.disabled = true;
    try {
      await applyReviewOp(FLAG_CTX.patient.id, FLAG_CTX.state, {
        op: "add_flag",
        title: title.value.trim(),
        description: document.getElementById("qa-desc").value.trim(),
        proposed_fix: document.getElementById("qa-fix").value.trim(),
        severity: document.getElementById("qa-urgency").value,
        anchor: anchor || undefined,
      });
      document.getElementById("modal-root").innerHTML = "";
      window.getSelection().removeAllRanges();
      FLAG_CTX.onChanged();
    } catch (e) {
      document.getElementById("qa-error").textContent = `Couldn't save: ${e.message}`;
      btn.disabled = false;
    }
  };
  document.getElementById("qa-submit").addEventListener("click", submit);
  title.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
}

/* ---- Per-location badges + quote highlights ---- */
function flagsByAnchor() {
  const map = {};
  (FLAG_CTX ? FLAG_CTX.state.flags : []).forEach(f => {
    if (f.anchor && f.anchor.key) (map[f.anchor.key] = map[f.anchor.key] || []).push(f);
  });
  return map;
}

function badgeHtml(flags, attrs) {
  const open = flags.filter(f => f.status !== "fixed").length;
  const text = open
    ? `${open} inconsistenc${open === 1 ? "y" : "ies"}`
    : `${flags.length} fixed`;
  return `<span class="loc-badge ${open ? "open" : "fixed"}" role="button" tabindex="0" ${attrs}>${text}</span>`;
}

function unwrapMarks(root) {
  root.querySelectorAll("mark.flag-mark").forEach(m => m.replaceWith(...m.childNodes));
  root.normalize();
}

/* Wraps the first occurrence of `quote` that sits inside a single text node
   (quotes spanning several elements just get the location badge). */
function highlightQuote(el, quote) {
  const candidates = [quote.trim(), quote.replace(/\s+/g, " ").trim()];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: n => n.parentElement.closest(".loc-badge, mark") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  let node;
  while ((node = walker.nextNode())) {
    for (const needle of candidates) {
      const i = needle.length > 1 ? node.nodeValue.indexOf(needle) : -1;
      if (i >= 0) { wrapRange(node, i, needle.length); return; }
    }
  }
}
function wrapRange(node, start, length) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + length);
  const mark = document.createElement("mark");
  mark.className = "flag-mark";
  range.surroundContents(mark);
}

function badgeSlot(el) {
  return el.querySelector(":scope > .graph-actions")
    || el.querySelector(":scope > .acc-head h3")
    || el.querySelector(":scope .band-name")
    || el.querySelector(":scope > td")
    || el;
}

function decorateAnchors() {
  if (!FLAG_CTX) return;
  document.querySelectorAll(".loc-badge").forEach(b => b.remove());
  document.querySelectorAll("[data-anchor]").forEach(unwrapMarks);
  const byKey = flagsByAnchor();

  document.querySelectorAll("circle.dot.flagged").forEach(d => d.classList.remove("flagged"));

  document.querySelectorAll("[data-anchor]").forEach(el => {
    const key = el.dataset.anchor;
    (byKey[key] || []).forEach(f => {
      if (!f.anchor.quote) return;
      if (key.startsWith("graph:")) {
        // A flagged reading: enlarge that dot instead of highlighting text.
        const tip = f.anchor.quote.replace(/^Reading: /, "");
        el.querySelectorAll("circle.dot").forEach(d => { if (d.getAttribute("data-tip") === tip) d.classList.add("flagged"); });
      } else {
        highlightQuote(el, f.anchor.quote);
      }
    });
    // Count this spot plus anything nested in it (a section includes its
    // rows, a row its graph), so collapsed parts still show where to look.
    const keys = [key, ...[...el.querySelectorAll("[data-anchor]")].map(c => c.dataset.anchor)];
    const flags = keys.flatMap(k => byKey[k] || []);
    if (!flags.length) return;
    badgeSlot(el).insertAdjacentHTML("beforeend", badgeHtml(flags, `data-loc-keys="${escapeHtml(keys.join("|"))}" data-loc-label="${escapeHtml(el.dataset.anchorLabel)}"`));
  });
}

function onBadgeClick(e) {
  const badge = e.target.closest && e.target.closest(".loc-badge");
  if (!badge) return;
  e.preventDefault();
  e.stopPropagation();
  FLAG_CTX.showFlagsPanel({ type: "location", keys: badge.dataset.locKeys.split("|"), title: badge.dataset.locLabel });
}

/* ---- Jump from a flag card to where it was raised ---- */
function goToFlagLocation(flag) {
  const root = document.getElementById("modal-root");
  if (root) root.innerHTML = "";
  if (!flag.anchor) return;
  const key = flag.anchor.key;
  if (key.startsWith("chat:")) document.querySelector('.tab-btn[data-tab="assistant"]').click();
  const el = document.querySelector(`[data-anchor="${CSS.escape(key)}"]`);
  if (!el) {
    // Usually an assistant answer from another reviewer's browser.
    openModal("Where this was flagged", `
      <div class="qa-loc">${escapeHtml(flag.anchor.label)} — not in your chat history (assistant chats are saved per browser).</div>
      ${flag.anchor.quote ? `<blockquote class="flag-quote">${escapeHtml(flag.anchor.quote)}</blockquote>` : ""}
      ${flag.anchor.context ? `<div class="flag-context">${escapeHtml(flag.anchor.context)}</div>` : ""}`);
    return;
  }
  const panel = el.closest(".tab-panel");
  if (panel) document.querySelector(`.tab-btn[data-tab="${panel.id.replace("tab-", "")}"]`).click();
  const acc = el.closest(".acc-row");
  if (acc) acc.classList.add("open");
  const band = el.closest(".band-row");
  if (band) band.classList.add("open");
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("flash");
  void el.offsetWidth; // restart the animation
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 2400);
}
