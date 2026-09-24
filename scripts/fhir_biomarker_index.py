#!/usr/bin/env python3
"""Build a small, UI-safe index from a patient's FHIR Bundle.

The UI never reads a raw FHIR bundle directly (they can run tens of MB) --
it reads only the JSON this script produces. Output has six sections:
biomarkers, qualitative_observations, conditions, medications, allergies,
encounters.

Usage:
  # one bundle -> stdout
  python3 fhir_biomarker_index.py "data/1- CKD/ckd_stage3_patient_Azalee124_Maggio310.json"

  # one bundle -> file
  python3 fhir_biomarker_index.py "data/1- CKD/ckd_stage3_patient_Azalee124_Maggio310.json" -o "data/1- CKD/index.json"

  # flat folder of *.json bundles -> <out>/<stem>_index.json each (does not walk subfolders)
  python3 fhir_biomarker_index.py --batch some_flat_folder --out some_flat_folder

  # walk data/, one patient per immediate subfolder, write <patient_dir>/index.json
  python3 fhir_biomarker_index.py --recursive data
"""

import argparse
import json
import sys
from pathlib import Path


def coding(concept):
    return (concept or {}).get("coding", [{}])[0] if (concept or {}).get("coding") else {}


def display_of(concept):
    if not concept:
        return None
    c = coding(concept)
    return c.get("display") or concept.get("text")


def code_of(concept):
    return coding(concept).get("code") if concept else None


# Synthea encodes social-history / demographic survey answers (PRAPARE, PhenX,
# employment, address, ...) as Condition and Observation resources alongside
# real clinical data. They're not diagnoses or lab findings, so they're
# dropped rather than shown next to actual clinical content.
ADMINISTRATIVE_KEYWORDS = [
    "employment", "unemployed", "labor force", "education", "high school", "criminal record",
    "refugee", "housing", "insurance", "transportation", "armed forces",
    "farm work", "income", "preferred language", "address", "marital status",
    "medication review due", "risk activity involvement",
    "safe where you currently live", "afraid of your partner",
    "jail, prison, detention", "see or talk to people", "family members you live with",
    "prapare", "phenx",
]


def is_administrative(label):
    if not label:
        return False
    lowered = label.lower()
    return any(kw in lowered for kw in ADMINISTRATIVE_KEYWORDS)


def load_bundle(path: Path):
    with path.open() as f:
        data = json.load(f)
    if data.get("resourceType") != "Bundle" or "entry" not in data:
        raise ValueError(f"{path} does not look like a FHIR Bundle")
    return [e["resource"] for e in data["entry"] if "resource" in e]


def build_biomarkers_and_qualitative(resources):
    quant = {}   # code -> {display, unit, readings: [...]}
    qual = {}    # code -> {display, readings: [...]}

    for r in resources:
        if r.get("resourceType") != "Observation":
            continue
        date = r.get("effectiveDateTime") or r.get("issued")
        code_concept = r.get("code")

        if "valueQuantity" in r:
            code = code_of(code_concept) or display_of(code_concept)
            vq = r["valueQuantity"]
            bucket = quant.setdefault(code, {
                "code": code,
                "label": display_of(code_concept) or code,
                "unit": vq.get("unit"),
                "readings": [],
            })
            bucket["readings"].append({"date": date, "value": vq.get("value")})

        elif "valueString" in r or "valueCodeableConcept" in r:
            label = display_of(code_concept)
            if is_administrative(label):
                continue
            code = code_of(code_concept) or label
            value = r.get("valueString") or display_of(r.get("valueCodeableConcept"))
            bucket = qual.setdefault(code, {
                "code": code,
                "label": label or code,
                "readings": [],
            })
            bucket["readings"].append({"date": date, "value": value})

        elif "component" in r:
            if is_administrative(display_of(code_concept)):
                continue
            for comp in r["component"]:
                comp_concept = comp.get("code")
                comp_code = code_of(comp_concept) or display_of(comp_concept)
                if "valueQuantity" in comp:
                    vq = comp["valueQuantity"]
                    bucket = quant.setdefault(comp_code, {
                        "code": comp_code,
                        "label": display_of(comp_concept) or comp_code,
                        "unit": vq.get("unit"),
                        "readings": [],
                    })
                    bucket["readings"].append({"date": date, "value": vq.get("value")})
                elif "valueString" in comp or "valueCodeableConcept" in comp:
                    value = comp.get("valueString") or display_of(comp.get("valueCodeableConcept"))
                    if value is None:
                        continue
                    bucket = qual.setdefault(comp_code, {
                        "code": comp_code,
                        "label": display_of(comp_concept) or comp_code,
                        "readings": [],
                    })
                    bucket["readings"].append({"date": date, "value": value})

    biomarkers = []
    for entry in quant.values():
        readings = sorted(
            [rd for rd in entry["readings"] if rd["date"]],
            key=lambda rd: rd["date"],
        )
        reading_count = len(readings)
        biomarkers.append({
            "code": entry["code"],
            "label": entry["label"],
            "unit": entry["unit"],
            "reading_count": reading_count,
            "trajectory_available": reading_count >= 2,
            "latest": readings[-1] if readings else None,
            "readings": readings,
        })
    biomarkers.sort(key=lambda b: b["label"] or "")

    qualitative = []
    for entry in qual.values():
        readings = sorted(
            [rd for rd in entry["readings"] if rd["date"]],
            key=lambda rd: rd["date"],
        )
        qualitative.append({
            "code": entry["code"],
            "label": entry["label"],
            "reading_count": len(readings),
            "latest": readings[-1] if readings else None,
            "readings": readings,
        })
    qualitative.sort(key=lambda q: q["label"] or "")

    return biomarkers, qualitative


def build_conditions(resources):
    by_code = {}
    for r in resources:
        if r.get("resourceType") != "Condition":
            continue
        code_concept = r.get("code")
        label = display_of(code_concept)
        if is_administrative(label):
            continue
        code = code_of(code_concept) or label
        onset = r.get("onsetDateTime") or r.get("recordedDate") or ""
        existing = by_code.get(code)
        if existing is None or onset > existing["_onset_sort"]:
            by_code[code] = {
                "code": code,
                "label": display_of(code_concept) or code,
                "clinical_status": coding(r.get("clinicalStatus")).get("code"),
                "onset": r.get("onsetDateTime"),
                "recorded_date": r.get("recordedDate"),
                "abatement": r.get("abatementDateTime"),
                "_onset_sort": onset,
            }
    conditions = list(by_code.values())
    for c in conditions:
        del c["_onset_sort"]
    conditions.sort(key=lambda c: c["onset"] or c["recorded_date"] or "")
    return conditions


def is_as_needed(request):
    if request.get("asNeededBoolean") or request.get("asNeededCodeableConcept"):
        return True
    for d in request.get("dosageInstruction") or []:
        if d.get("asNeededBoolean") or d.get("asNeededCodeableConcept"):
            return True
    return False


def dosage_summary(dosage_instructions, as_needed):
    if as_needed:
        return "as needed"
    if not dosage_instructions:
        return None
    d = dosage_instructions[0]
    repeat = (d.get("timing") or {}).get("repeat") or {}
    freq = repeat.get("frequency")
    period = repeat.get("period")
    unit = repeat.get("periodUnit")
    if freq and period and unit:
        unit_word = {"d": "day", "h": "hour", "wk": "week"}.get(unit, unit)
        if freq == 1 and period == 1:
            return f"once per {unit_word}"
        return f"{freq}x per {period} {unit_word}"
    return None


def build_medications(resources):
    by_key = {}
    for r in resources:
        if r.get("resourceType") != "MedicationRequest":
            continue
        concept = r.get("medicationCodeableConcept")
        text = display_of(concept)
        if not text:
            continue
        key = code_of(concept) or text
        authored = r.get("authoredOn") or ""
        as_needed = is_as_needed(r)
        entry = by_key.setdefault(key, {
            "code": code_of(concept),
            "text": text,
            "status": r.get("status"),
            "as_needed": as_needed,
            "dosage": dosage_summary(r.get("dosageInstruction"), as_needed),
            "first_authored": authored,
            "last_authored": authored,
            "requester": (r.get("requester") or {}).get("display"),
            "_count": 0,
        })
        entry["_count"] += 1
        entry["as_needed"] = entry["as_needed"] or as_needed
        if authored and (not entry["first_authored"] or authored < entry["first_authored"]):
            entry["first_authored"] = authored
        if authored and authored >= entry["last_authored"]:
            entry["last_authored"] = authored
            entry["status"] = r.get("status")
            entry["dosage"] = dosage_summary(r.get("dosageInstruction"), as_needed) or entry["dosage"]
    meds = list(by_key.values())
    for m in meds:
        m["fill_count"] = m.pop("_count")
    meds.sort(key=lambda m: m["text"])
    return meds


def build_allergies(resources):
    by_code = {}
    for r in resources:
        if r.get("resourceType") != "AllergyIntolerance":
            continue
        concept = r.get("code")
        code = code_of(concept) or display_of(concept)
        by_code[code] = {
            "code": code,
            "label": display_of(concept) or code,
            "category": (r.get("category") or [None])[0],
            "criticality": r.get("criticality"),
            "clinical_status": coding(r.get("clinicalStatus")).get("code"),
            "recorded_date": r.get("recordedDate"),
        }
    allergies = list(by_code.values())
    allergies.sort(key=lambda a: a["recorded_date"] or "")
    return allergies


def build_encounters(resources, recent=15):
    encounters = []
    for r in resources:
        if r.get("resourceType") != "Encounter":
            continue
        period = r.get("period") or {}
        type_concept = (r.get("type") or [None])[0]
        encounters.append({
            "start": period.get("start"),
            "end": period.get("end"),
            "type": display_of(type_concept),
            "location": ((r.get("location") or [{}])[0].get("location") or {}).get("display"),
        })
    encounters.sort(key=lambda e: e["start"] or "", reverse=True)
    return {
        "total": len(encounters),
        "recent": encounters[:recent],
    }


def build_index(path: Path):
    resources = load_bundle(path)
    biomarkers, qualitative = build_biomarkers_and_qualitative(resources)
    return {
        "source_file": path.name,
        "biomarkers": biomarkers,
        "qualitative_observations": qualitative,
        "conditions": build_conditions(resources),
        "medications": build_medications(resources),
        "allergies": build_allergies(resources),
        "encounters": build_encounters(resources),
    }


def find_bundle_in_patient_dir(patient_dir: Path, out_name: str):
    """A patient folder either has one FHIR bundle *.json at its top level,
    or (for the already-split 2/5/6 folders) inside a fhir/ subfolder."""
    candidates = [p for p in sorted(patient_dir.glob("*.json")) if p.name != out_name]
    candidates += sorted((patient_dir / "fhir").glob("*.json"))
    bundles = []
    for c in candidates:
        try:
            with c.open() as f:
                head = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue
        if head.get("resourceType") == "Bundle" and "entry" in head:
            bundles.append(c)
    if not bundles:
        return None
    # prefer the largest bundle if more than one candidate qualifies
    bundles.sort(key=lambda p: p.stat().st_size, reverse=True)
    return bundles[0]


def run_recursive(data_root: Path, out_name: str):
    for patient_dir in sorted(p for p in data_root.iterdir() if p.is_dir()):
        bundle_path = find_bundle_in_patient_dir(patient_dir, out_name)
        if bundle_path is None:
            print(f"skip {patient_dir.name}: no FHIR bundle found", file=sys.stderr)
            continue
        index = build_index(bundle_path)
        out_path = patient_dir / out_name
        out_path.write_text(json.dumps(index, indent=2))
        print(f"{patient_dir.name}: {bundle_path.relative_to(patient_dir)} -> {out_path.relative_to(data_root.parent)}")


def run_batch(folder: Path, out_dir: Path):
    out_dir.mkdir(parents=True, exist_ok=True)
    for path in sorted(folder.glob("*.json")):
        try:
            index = build_index(path)
        except ValueError as e:
            print(f"skip {path.name}: {e}", file=sys.stderr)
            continue
        out_path = out_dir / f"{path.stem}_index.json"
        out_path.write_text(json.dumps(index, indent=2))
        print(f"{path.name} -> {out_path}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("bundle", nargs="?", help="path to a single FHIR bundle JSON file")
    parser.add_argument("-o", "--out", help="output file (single-bundle mode) or output dir (--batch mode)")
    parser.add_argument("--batch", metavar="DIR", help="flat folder of *.json bundles (does not walk subfolders)")
    parser.add_argument("--recursive", metavar="DATA_ROOT", help="walk DATA_ROOT, one patient per immediate subfolder")
    parser.add_argument("--out-name", default="index.json", help="output filename used by --recursive (default: index.json)")
    args = parser.parse_args()

    if args.recursive:
        run_recursive(Path(args.recursive), args.out_name)
    elif args.batch:
        run_batch(Path(args.batch), Path(args.out) if args.out else Path(args.batch))
    elif args.bundle:
        index = build_index(Path(args.bundle))
        text = json.dumps(index, indent=2)
        if args.out:
            Path(args.out).write_text(text)
        else:
            print(text)
    else:
        parser.error("provide a bundle path, or --batch DIR, or --recursive DATA_ROOT")


if __name__ == "__main__":
    main()
