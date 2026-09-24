# Patient Chart Review — Build Spec

## What this is

A synthetic-data QA tool wearing a clinical-review UI. A doctor reads each
synthetic patient as if it were a real chart, using clinical judgment to
catch things that don't hold together biologically — a frozen lab value
across a decade, vitals that contradict a diagnosis, wearable signals that
don't move the way the clinical condition says they should. Every finding
becomes a structured flag that an AI/data engineering team can act on to fix
the generation pipeline.

The doctor is **not** treating a patient. They're QAing a dataset, using a
realistic clinical-review UI as the vehicle because that lens is what
surfaces inconsistencies a generation pipeline would otherwise miss.

**Primary users:** a reviewing doctor (browses patients, flags issues) and
an AI engineering team (reads the flags, fixes the generator).

## Tech stack

Static site — plain HTML/CSS/JS (no build step required), so it runs
locally by opening `index.html` and deploys straight to GitHub Pages with
zero config. Use vanilla JS for interactivity (tabs, accordions, drawer);
no framework needed unless you (Claude Code) judge the assistant-chat
panel needs component state badly enough to justify adding one — if so,
prefer a CDN-loaded React over a build toolchain, to keep "just open the
file" working.

## Data sources

Each patient's data lives in its own folder, under the top-level `data/`
folder (renamed from the downloaded "synthetic patients" folder). The
**real, current folder names** are:

```
data/
  1- CKD/
  2,5,6/                  ← combined folder, 3 sub-patients inside:
                             P01 (ADHD), P02 (Sedentary), P03 (Deficit) —
                             each with its own docx/CSV/FHIR set
  3-family history/
  4-athlete/
  7-Hypothyroidism/
  8-Disordered_Eating/
  9-Ordinary_Person/
```

Note the gaps and grouping are real, not a mistake to "fix" — 2, 5, and 6
were generated together as one combined folder with three sub-patients.
Treat `2,5,6/` as three separate patients in the UI (P01, P02, P03), not
one. That makes **9 total patients across 7 folders.**

Per patient (per sub-patient, inside `2,5,6/`), the same file set repeats:

- `Patient_Profile.docx` — human-readable summary (demographics, clinical
  trajectory, meds, active conditions, key labs)
- `Limitations.docx` — the generation pipeline's own self-critique of that
  profile's synthetic-data flaws
- `*_Curation_Methodology.docx` — how the patient was generated
- `modified_daily.csv` — ~100 days of wearable data (steps, resting HR,
  sleep efficiency, SpO2, stress, etc.)
- a weekly-summary CSV — per-week aggregates of the same wearable features
- a FHIR `Bundle` JSON (can be 10s of MB — do not parse this at UI runtime)

**Do not read the raw FHIR bundle from the UI.** Run
`scripts/fhir_biomarker_index.py` (already written, included in this repo)
against each patient's FHIR file first, e.g.:

```
python3 scripts/fhir_biomarker_index.py "data/1- CKD/patient_bundle.json" > "data/1- CKD/index.json"
```

`--batch` expects a flat folder of `.json` files — it does not walk
subfolders. Given the structure above, either run it once per patient
folder (7 calls, or 9 if you split `2,5,6/` into its three sub-patients
first), or ask Claude Code to add a `--recursive` option that walks
`data/` and matches each patient's FHIR file by whatever naming pattern
it actually has (check the real filenames first — quote folder names
containing spaces or commas, like `"data/1- CKD"` and `"data/2,5,6"`,
since an unquoted comma or space will break the shell command).

This produces a small `*_index.json` per patient with six sections:
`biomarkers` (numeric, chartable, includes `trajectory_available` per
biomarker), `qualitative_observations` (survey scores, dipstick findings —
not chartable), `conditions` (includes `abatement: null` = never marked
resolved), `medications`, `allergies`, `encounters`. **The UI reads only
this JSON, never the raw bundle.**

You'll also need to hand-parse or script-extract from the docx files:
the narrative summary content, the `Limitations.docx` bullet points, and
the wearable CSV daily/weekly stats (steps, resting HR, sleep efficiency,
SpO2, stress — mean and a short recent-window sparkline).

## Visual design

- **Typography:** Newsreader (serif) for headings, IBM Plex Sans for body
  text, IBM Plex Mono for all numbers/data/timestamps/tags. Load from
  Google Fonts.
- **Palette:** warm-neutral paper background (`#F6F5F1`), white surfaces,
  near-black ink (`#1B1D22`), muted gray text (`#6B6F76`). Status colors:
  rust `#B8461E` = open/high-severity/high-relevance, teal `#29685C` =
  fixed/resolved, amber `#A97B12` = medium-severity/medium-relevance,
  neutral gray = low-relevance.
- Rounded corners (~6-8px), thin `1px solid #E3E1DA` borders, no drop
  shadows except a subtle hover lift on cards. This should read as a
  precise data tool, not a generic SaaS dashboard.

## Screens

### 1. Patient Review (the main screen)

**Left drawer (slide-out, closed by default):** list of all patients,
each showing name + condition tag. Triggered by a hamburger icon in the
top bar. Click a patient to switch the whole screen's data to them
(client-side — just swap which patient's JSON/parsed-docx data is loaded).

**Top bar:** drawer toggle, brand mark, current patient name + condition
tag, link to the Team Dashboard screen, doctor identity (name/avatar).

**Status banner** (persistent, below top bar): four stats — open flags,
fixed & verified, total notes, current version number — plus a "view
version history" link.

**Two tabs:** "Patient overview" and "Ask the assistant". Tab state is
just show/hide, no routing needed.

#### Overview tab

In order, top to bottom:

1. **Narrative summary** — 3-4 sentences: who the patient is, what
   they're dealing with, their major medications. Plain prose, not a
   bulleted list.

2. **Categories accordion** (one bordered container, each category a
   collapsible row, all in one accordion so only relevant sections are
   open at once):

   - **Diagnosed conditions** (high relevance) — split into two groups:
     - *Current struggles*: conditions clearly ongoing.
     - *Past / unclosed*: conditions with no resolution recorded in the
       chart (`abatement: null` from the index JSON) — explicitly call
       out that resolution status is unclear, not assumed resolved.
     Each condition name that has a build-out detail page (see Condition
     Detail screen below) should be a real link with a hover state and a
     trailing chevron (›); conditions without a fleshed-out page stay as
     plain text — don't fake a link to nowhere.

   - **Medications** (high relevance) — grouped by what they're treating
     (e.g., cardiac / blood pressure / diabetes / respiratory), each drug
     shown with its real dose and unit pulled from the FHIR
     `medicationCodeableConcept` display string (e.g. "Lisinopril 10 mg"),
     and "as needed" noted for PRN drugs.

   - **Clinical numbers** (biomarkers, not conditions) — this is the
     important one, get the distinction right:
     - **Charted**: any biomarker in the index JSON with
       `trajectory_available: true` gets an actual line/point graph
       (SVG or Canvas) plotted from its `readings` array, with a shaded
       reference-range band where clinically relevant (e.g., CKD Stage 3
       eGFR band).
     - **Recorded — not yet indexed / single reading**: everything else
       shows only its latest value in a plain list row, honestly labeled
       — don't imply a trend exists when `trajectory_available` is
       `false` or the biomarker hasn't been indexed at all. Give each row
       a "Check for a trajectory" action that, when clicked, looks at
       that biomarker's `reading_count` and either reveals a real chart
       (if more readings exist) or an honest "only N reading(s) indexed
       so far" note. This is meant to simulate "ask the assistant to
       chart something" — build it as real interactivity against the
       index JSON, not a fake button.

   - **Wearable variables** — from the daily CSV: resting HR, SpO2,
     sleep efficiency, steps/day, stress score. Each row: label, a
     relevance tag (high/medium/low — tie relevance to how directly the
     variable connects to this patient's specific conditions, e.g.
     resting HR and SpO2 are high-relevance for a CKD/anemia/sleep-apnea
     patient), current value, and a small sparkline from the last ~8
     days of the CSV.

   - **Flagged inconsistencies** — the doctor's own findings. Each flag
     card has: title, one-sentence description, a type tag (pick one:
     Cross-modal mismatch / Frozen value / Clinical-internal
     contradiction / Wearable-internal inconsistency), a severity tag
     (High/Medium), an "Add comment" button, and an "Ask agent to fix →"
     button. A fixed flag additionally shows a
     `FIXED: <old value> → <new value>` tag and an audit line
     ("Fixed by AI agent · <date>" or "Flagged by Dr. X · <date>").
     Flags are created by the doctor — there's no "not an issue, keep
     open" state, since the doctor wouldn't flag something they think is
     fine.

   - **Already noted by the pipeline** (low relevance, collapsed by
     default) — pull directly from `Limitations.docx`. Two buttons:
     "Confirm, no action needed" and "Add an exception."

   Mentions of flags/limitations/inconsistencies belong **only** in the
   "Flagged inconsistencies" and "Already noted by the pipeline" rows.
   Don't reference them elsewhere in the UI (chat replies, condition
   detail pages, etc.) — keep judgment calls confined to those two
   places; everywhere else just shows data.

#### Assistant tab

A chat panel with full context of that patient's index JSON + docx
summaries. Message bubbles, a couple of quick-prompt chips
("Summarize all inconsistencies", "What would a real chart show here?"),
and a text input. Wiring this to a real LLM API is out of scope for the
first pass — a static/scripted demo conversation is fine to start.

### 2. Condition Detail (one per condition that has enough data to fill it)

Reached by clicking a linked condition name from the Overview accordion.
Contents, scoped to just that one condition:

- Header: condition name, diagnosed-date tag, one-paragraph pathway
  description.
- The relevant chartable biomarker(s) for this condition specifically
  (e.g., eGFR for CKD), same chart style as the main Clinical Numbers
  section.
- The wearable variables most tied to this specific condition (a subset
  of the full wearable list, not all five).
- The slice of the medication list that treats this condition.

Only build detail pages for conditions where there's enough real,
specific data to fill one meaningfully — don't create empty/generic
detail pages for every diagnosis.

### 3. Team Dashboard

Separate screen, linked from the top bar of Patient Review.

- Aggregate stat chips: profiles reviewed, total flags, open, fixed.
- **Flags by patient**: horizontal split bars (open vs. fixed proportion)
  per patient — one bar per patient (9 total), not per folder (7 folders,
  since `2,5,6/` holds 3 patients). Label each bar with the patient's
  condition, not the raw folder name.
- **Most common flag types**: horizontal bars by the four flag-type tags,
  descending — this is what tells the engineering team where the
  generation pipeline is weakest.
- **Recent activity feed**: chronological list of flag/fix events across
  multiple doctors (support more than one reviewer from the start — name
  attribution matters here).

## Cross-cutting requirements

- **Multi-patient from day one** — don't hardcode to one patient; the
  drawer/patient-switcher needs to actually load different data.
- **Versioning** — each patient profile has a version number; a fixed
  flag bumps it. Show version history (list of past versions with what
  changed) somewhere reachable from the status banner.
- **Audit trail** — every flag and every fix records who (doctor name or
  "AI agent") and when.
- Keep the whole thing skimmable — this is a working tool for repeated
  daily use by a doctor reviewing many profiles, not a one-time report.
