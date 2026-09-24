#!/usr/bin/env python3
"""Build the assistant's full-knowledge record for each patient.

The chat assistant can look up anything in a patient's chart through tools
(see assets/js/assistant.js). Those tools read the file this script writes:

  data/<patient folder>/record.json

It holds the complete clinical content of the patient's FHIR bundle --
every observation reading, encounter, condition, medication order,
procedure, immunization, visit note, care plan, device, imaging study and
allergy -- flattened into compact rows, plus the plain text of the
patient's generator documents (Patient_Profile / Limitations / Methodology
.docx, or profiles/*.json + README.md + BUILD_REPORT.txt for the
Synthea-modules cohort).

Dropped on purpose: Claim / ExplanationOfBenefit (billing, >30% of a
bundle's bytes, no clinical content), Provenance, and FHIR boilerplate
(meta, identifiers, narrative div duplicates, base64 DiagnosticReport
copies of the same note already present as a DocumentReference).

Usage:
  python3 scripts/build_agent_records.py            # every folder in data/patients.json
  python3 scripts/build_agent_records.py --only ckd # one patient id
"""

import argparse
import base64
import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

SKIP_TYPES = {"Claim", "ExplanationOfBenefit", "Provenance", "Composition"}
GENERATED_FILES = {"index.json", "content.json", "wearable.json", "record.json"}


# ---------- small FHIR helpers ----------

def display(concept):
    if not concept:
        return None
    for c in concept.get("coding") or []:
        if c.get("display"):
            return c["display"]
    return concept.get("text")


def code(concept):
    for c in (concept or {}).get("coding") or []:
        if c.get("code"):
            return c["code"]
    return None


def ref_id(ref):
    """'urn:uuid:abc' / 'Encounter/abc' -> 'abc'."""
    if not ref or not ref.get("reference"):
        return None
    r = ref["reference"]
    if r.startswith("urn:uuid:"):
        return r[len("urn:uuid:"):]
    return r.rsplit("/", 1)[-1]


def day(ts):
    return ts[:10] if ts else None


def minute(ts):
    return ts[:16] if ts else None


def num(v):
    if isinstance(v, float):
        return round(v, 3)
    return v


def value_of(r):
    """Observation / component value -> (value, unit)."""
    if "valueQuantity" in r:
        q = r["valueQuantity"]
        return num(q.get("value")), q.get("unit") or q.get("code")
    if "valueCodeableConcept" in r:
        return display(r["valueCodeableConcept"]), None
    for k in ("valueString", "valueBoolean", "valueInteger", "valueDateTime"):
        if k in r:
            return r[k], None
    if "valueRange" in r:
        lo, hi = r["valueRange"].get("low", {}), r["valueRange"].get("high", {})
        return f"{lo.get('value')}–{hi.get('value')}", lo.get("unit") or hi.get("unit")
    return None, None


def prune(d):
    return {k: v for k, v in d.items() if v not in (None, "", [], {})}


# ---------- FHIR bundle -> record ----------

def build_record(bundle):
    by_id = {}
    for e in bundle.get("entry", []):
        r = e.get("resource") or {}
        if r.get("id"):
            by_id[r["id"]] = r

    def name_of(ref):
        rid = ref_id(ref)
        target = by_id.get(rid) if rid else None
        if target:
            return display(target.get("code")) or display(target.get("medicationCodeableConcept")) or display(target.get("type"))
        return (ref or {}).get("display")

    rec = {k: [] for k in (
        "encounters", "observations", "conditions", "medications", "medication_administrations",
        "procedures", "immunizations", "diagnostic_reports", "notes", "care_plans", "care_teams",
        "devices", "imaging", "allergies", "supplies")}
    rec["patient"] = {}
    skipped = {}

    for e in bundle.get("entry", []):
        r = e.get("resource") or {}
        t = r.get("resourceType")
        if t in SKIP_TYPES:
            skipped[t] = skipped.get(t, 0) + 1
            continue
        # DocumentReference links its encounter as context.encounter[0].
        ctx_enc = (r.get("context") or {}).get("encounter")
        enc = ref_id(r.get("encounter") or (ctx_enc[0] if isinstance(ctx_enc, list) and ctx_enc else ctx_enc))

        if t == "Patient":
            nm = (r.get("name") or [{}])[0]
            ext = {}
            for x in r.get("extension") or []:
                u = x.get("url", "")
                if u.endswith("us-core-race") or u.endswith("us-core-ethnicity"):
                    for sub in x.get("extension") or []:
                        if sub.get("url") == "text":
                            ext["race" if "race" in u else "ethnicity"] = sub.get("valueString")
                elif u.endswith("birthsex"):
                    ext["birth_sex"] = x.get("valueCode")
            addr = (r.get("address") or [{}])[0]
            rec["patient"] = prune({
                "name": " ".join((nm.get("given") or []) + [nm.get("family") or ""]).strip(),
                "gender": r.get("gender"),
                "birth_date": r.get("birthDate"),
                "deceased": r.get("deceasedDateTime") or r.get("deceasedBoolean"),
                "marital_status": display(r.get("maritalStatus")),
                "city": addr.get("city"), "state": addr.get("state"),
                "language": display(((r.get("communication") or [{}])[0]).get("language")),
                **ext,
            })

        elif t == "Encounter":
            period = r.get("period") or {}
            rec["encounters"].append(prune({
                "id": r["id"],
                "start": minute(period.get("start")), "end": minute(period.get("end")),
                "class": (r.get("class") or {}).get("code"),
                "type": display((r.get("type") or [None])[0]),
                "reason": "; ".join(filter(None, [display(c) for c in r.get("reasonCode") or []]
                                           + [name_of(x) for x in r.get("reasonReference") or []])),
                "practitioner": (((r.get("participant") or [{}])[0]).get("individual") or {}).get("display"),
                "location": (((r.get("location") or [{}])[0]).get("location") or {}).get("display"),
            }))

        elif t == "Observation":
            date = day(r.get("effectiveDateTime") or (r.get("effectivePeriod") or {}).get("start") or r.get("issued"))
            cat = code((r.get("category") or [None])[0])
            panel = display(r.get("code"))
            if r.get("component"):
                for comp in r["component"]:
                    v, u = value_of(comp)
                    rec["observations"].append(prune({
                        "date": date, "name": display(comp.get("code")), "code": code(comp.get("code")),
                        "value": v, "unit": u, "category": cat, "panel": panel, "encounter": enc,
                    }))
            else:
                v, u = value_of(r)
                rec["observations"].append(prune({
                    "date": date, "name": panel, "code": code(r.get("code")),
                    "value": v, "unit": u, "category": cat, "encounter": enc,
                }))

        elif t == "Condition":
            rec["conditions"].append(prune({
                "name": display(r.get("code")), "code": code(r.get("code")),
                "onset": day(r.get("onsetDateTime") or (r.get("onsetPeriod") or {}).get("start")),
                "abatement": day(r.get("abatementDateTime")),
                "clinical_status": code(r.get("clinicalStatus")),
                "verification": code(r.get("verificationStatus")),
                "category": code((r.get("category") or [None])[0]),
                "recorded": day(r.get("recordedDate")),
                "encounter": enc,
            }))

        elif t == "MedicationRequest":
            med = display(r.get("medicationCodeableConcept")) or name_of(r.get("medicationReference"))
            dosage = []
            for di in r.get("dosageInstruction") or []:
                parts = []
                if di.get("text"):
                    parts.append(di["text"])
                rep = ((di.get("timing") or {}).get("repeat") or {})
                if rep.get("frequency"):
                    parts.append(f"{rep['frequency']}x per {rep.get('period', 1)} {rep.get('periodUnit', '')}".strip())
                for dr in di.get("doseAndRate") or []:
                    dq = dr.get("doseQuantity")
                    if dq:
                        parts.append(f"dose {dq.get('value')} {dq.get('unit') or ''}".strip())
                if di.get("asNeededBoolean"):
                    parts.append("as needed")
                for ai in di.get("additionalInstruction") or []:
                    parts.append(display(ai))
                if parts:
                    dosage.append(", ".join(filter(None, parts)))
            rec["medications"].append(prune({
                "name": med,
                "code": code(r.get("medicationCodeableConcept")),
                "authored": day(r.get("authoredOn")),
                "status": r.get("status"), "intent": r.get("intent"),
                "dosage": "; ".join(dosage),
                "reason": "; ".join(filter(None, [display(c) for c in r.get("reasonCode") or []]
                                           + [name_of(x) for x in r.get("reasonReference") or []])),
                "encounter": enc,
            }))

        elif t == "MedicationAdministration":
            rec["medication_administrations"].append(prune({
                "name": display(r.get("medicationCodeableConcept")) or name_of(r.get("medicationReference")),
                "date": day(r.get("effectiveDateTime") or (r.get("effectivePeriod") or {}).get("start")),
                "status": r.get("status"), "encounter": enc,
            }))

        elif t == "Procedure":
            pp = r.get("performedPeriod") or {}
            rec["procedures"].append(prune({
                "name": display(r.get("code")), "code": code(r.get("code")),
                "date": day(r.get("performedDateTime") or pp.get("start")),
                "status": r.get("status"),
                "reason": "; ".join(filter(None, [display(c) for c in r.get("reasonCode") or []]
                                           + [name_of(x) for x in r.get("reasonReference") or []])),
                "encounter": enc,
            }))

        elif t == "Immunization":
            rec["immunizations"].append(prune({
                "name": display(r.get("vaccineCode")),
                "date": day(r.get("occurrenceDateTime")),
                "status": r.get("status"), "encounter": enc,
            }))

        elif t == "DiagnosticReport":
            # Note-type reports duplicate the DocumentReference note text; keep
            # the report row (name/date/linked results), not the base64 copy.
            rec["diagnostic_reports"].append(prune({
                "name": display(r.get("code")),
                "date": day(r.get("effectiveDateTime") or r.get("issued")),
                "results": [name_of(x) for x in r.get("result") or []],
                "encounter": enc,
            }))

        elif t == "DocumentReference":
            text = []
            for c in r.get("content") or []:
                a = c.get("attachment") or {}
                if a.get("data"):
                    try:
                        text.append(base64.b64decode(a["data"]).decode("utf-8", "replace").strip())
                    except Exception:
                        pass
            rec["notes"].append(prune({
                "date": day(r.get("date") or ((r.get("context") or {}).get("period") or {}).get("start")),
                "type": display(r.get("type")),
                "text": "\n\n".join(text),
                "encounter": enc,
            }))

        elif t == "CarePlan":
            period = r.get("period") or {}
            rec["care_plans"].append(prune({
                "name": " / ".join(filter(None, [display(c) for c in r.get("category") or []])),
                "start": day(period.get("start")), "end": day(period.get("end")),
                "status": r.get("status"),
                "addresses": [name_of(x) for x in r.get("addresses") or []],
                "activities": [display((a.get("detail") or {}).get("code")) for a in r.get("activity") or []],
                "encounter": enc,
            }))

        elif t == "CareTeam":
            period = r.get("period") or {}
            rec["care_teams"].append(prune({
                "start": day(period.get("start")), "end": day(period.get("end")),
                "status": r.get("status"),
                "reason": "; ".join(filter(None, [display(c) for c in r.get("reasonCode") or []])),
                "members": [(p.get("member") or {}).get("display") for p in r.get("participant") or []],
            }))

        elif t == "Device":
            rec["devices"].append(prune({
                "name": display(r.get("type")) or ((r.get("deviceName") or [{}])[0]).get("name"),
                "manufactured": day(r.get("manufactureDate")),
                "expires": day(r.get("expirationDate")),
                "status": r.get("status"),
            }))

        elif t == "ImagingStudy":
            rec["imaging"].append(prune({
                "date": day(r.get("started")),
                "procedure": display((r.get("procedureCode") or [None])[0]),
                "series": [prune({
                    "modality": (s.get("modality") or {}).get("display") or (s.get("modality") or {}).get("code"),
                    "body_site": (s.get("bodySite") or {}).get("display"),
                }) for s in r.get("series") or []],
                "encounter": enc,
            }))

        elif t == "AllergyIntolerance":
            rec["allergies"].append(prune({
                "name": display(r.get("code")),
                "recorded": day(r.get("recordedDate")),
                "category": r.get("category"), "criticality": r.get("criticality"),
                "clinical_status": code(r.get("clinicalStatus")),
                "reactions": [display(m) for rx in r.get("reaction") or [] for m in rx.get("manifestation") or []],
            }))

        elif t == "SupplyDelivery":
            rec["supplies"].append(prune({
                "name": display((r.get("suppliedItem") or {}).get("itemCodeableConcept")),
                "quantity": ((r.get("suppliedItem") or {}).get("quantity") or {}).get("value"),
                "date": day(r.get("occurrenceDateTime")),
            }))

        elif t == "Medication":
            pass  # resolved into medication rows via medicationReference

        else:
            skipped[t] = skipped.get(t, 0) + 1

    date_key = lambda row: row.get("date") or row.get("start") or row.get("authored") or row.get("onset") or row.get("recorded") or ""
    for k, v in rec.items():
        if isinstance(v, list):
            v.sort(key=date_key)
    rec["omitted_resource_types"] = skipped
    return rec


# ---------- documents ----------

def docx_text(path):
    xml = zipfile.ZipFile(path).read("word/document.xml").decode("utf-8")
    out = []
    for para in re.findall(r"<w:p[ >].*?</w:p>", xml, re.S):
        text = "".join(re.findall(r"<w:t[^>]*>([^<]*)</w:t>", para))
        text = (text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
                    .replace("&quot;", '"').replace("&apos;", "'"))
        if text.strip():
            out.append(text)
    return "\n".join(out)


def doc_kind(name):
    n = name.lower()
    if "limitation" in n:
        return "limitations"
    if "methodology" in n:
        return "methodology"
    if "profile" in n:
        return "profile"
    return re.sub(r"\W+", "_", Path(name).stem.lower())


def collect_documents(folder):
    docs = {}
    for p in sorted(folder.glob("*.docx")):
        docs[doc_kind(p.name)] = {"source": p.name, "text": docx_text(p)}
    for p in sorted((folder / "profiles").glob("*.json")) if (folder / "profiles").is_dir() else []:
        docs["profile"] = {"source": f"profiles/{p.name}", "text": json.dumps(json.load(open(p)), indent=1)}
    # Cohort-level docs shared by the Synthea-modules patients (2/5/6):
    # large and not patient-specific, so they're lookup-only, not always sent.
    for name, kind in (("README.md", "cohort_readme"), ("BUILD_REPORT.txt", "cohort_build_report")):
        if (folder / name).exists():
            docs[kind] = {"source": name, "text": (folder / name).read_text(errors="replace"), "lookup_only": True}
    return docs


# ---------- per-patient driver ----------

def find_bundle(folder):
    candidates = [p for p in list(folder.glob("*.json")) + list(folder.glob("fhir/*.json"))
                  if p.name not in GENERATED_FILES]
    for p in sorted(candidates, key=lambda p: -p.stat().st_size):
        with open(p) as f:
            head = f.read(4096)
        if '"Bundle"' in head:
            return p
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", help="patient id from data/patients.json")
    args = ap.parse_args()

    patients = json.load(open(DATA / "patients.json"))
    for pt in patients:
        if args.only and pt["id"] != args.only:
            continue
        folder = DATA / pt["folder"]
        bundle_path = find_bundle(folder)
        if not bundle_path:
            print(f"!! {pt['id']}: no FHIR bundle found in {folder}", file=sys.stderr)
            continue
        rec = build_record(json.load(open(bundle_path)))
        rec["source_bundle"] = str(bundle_path.relative_to(folder))
        rec["documents"] = collect_documents(folder)
        out = folder / "record.json"
        out.write_text(json.dumps(rec, separators=(",", ":"), ensure_ascii=False))
        counts = ", ".join(f"{k}={len(v)}" for k, v in rec.items() if isinstance(v, list) and v)
        print(f"{pt['id']:18} {out.stat().st_size / 1e6:5.2f} MB  {counts}  docs={list(rec['documents'])}")


if __name__ == "__main__":
    main()
