#!/usr/bin/env python3
"""Normalize each patient's daily + weekly wearable data into one canonical
wearable.json. The raw daily/weekly CSVs (and 3 xlsx weekly files) use three
different column-naming schemes across the 9 patients for the WEEKLY files;
the daily files share the same raw column names across all three schemas,
so the feature list below is read verbatim from each daily CSV. The UI reads
only the normalized output, never the raw files.

Usage: python3 scripts/normalize_wearables.py [data_root]  (default: data)
"""

import csv
import json
import sys
from pathlib import Path

import openpyxl

FEATURES = [
    "steps", "distance", "calories", "bpm", "resting_hr", "rmssd", "spo2",
    "full_sleep_breathing_rate", "nightly_temperature", "sleep_duration",
    "sleep_efficiency", "minutesAwake", "stress_score",
    "very_active_minutes", "sedentary_minutes",
]

# folder -> config. weekly_format is one of:
#   "xlsx_long"  - xlsx sheet "Weekly Trends", rows keyed by a 'feature' column
#   "csv_bare"   - csv with feature names as-is, only week_number (no dates)
#   "csv_mean"   - csv with "<feature>_mean" columns, has week/start_date/end_date
PATIENTS = {
    "1- CKD": {
        "daily": "modified_daily.csv",
        "weekly": "CKD_weekly_trends.xlsx",
        "weekly_format": "xlsx_long",
    },
    "2-adhd": {
        "daily": "wearable/P01_adhd_daily.csv",
        "weekly": "wearable/P01_adhd_weekly.csv",
        "weekly_format": "csv_mean",
    },
    "3-family history": {
        "daily": "vernon_daily.csv",
        "weekly": "Normal_weekly_trends.xlsx",
        "weekly_format": "xlsx_long",
    },
    "4-athlete": {
        "daily": "shelton_daily.csv",
        "weekly": "Athlete_weekly_trends.xlsx",
        "weekly_format": "xlsx_long",
    },
    "5-sedentary": {
        "daily": "wearable/P02_sedentary_daily.csv",
        "weekly": "wearable/P02_sedentary_weekly.csv",
        "weekly_format": "csv_mean",
    },
    "6-deficit": {
        "daily": "wearable/P03_deficit_daily.csv",
        "weekly": "wearable/P03_deficit_weekly.csv",
        "weekly_format": "csv_mean",
    },
    "7-Hypothyroidism": {
        "daily": "profile_1_hypothyroidism_daily_90d.csv",
        "weekly": "profile_1_hypothyroidism_weekly_summary.csv",
        "weekly_format": "csv_bare",
    },
    "8-Disordered_Eating": {
        "daily": "profile_2_disordered_eating_daily_90d.csv",
        "weekly": "profile_2_disordered_eating_weekly_summary.csv",
        "weekly_format": "csv_bare",
    },
    "9-Ordinary_Person": {
        "daily": "profile_3_ordinary_daily_90d.csv",
        "weekly": "profile_3_ordinary_weekly_summary.csv",
        "weekly_format": "csv_bare",
    },
}


def to_number(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return value
    value = str(value).strip()
    if value == "":
        return None
    try:
        return float(value)
    except ValueError:
        return None


def read_daily(path: Path):
    with path.open(newline="") as f:
        rows = list(csv.DictReader(f))
    out = []
    for row in rows:
        date = row.get("date")
        if not date:
            continue
        out.append({
            "date": date,
            **{feat: to_number(row.get(feat)) for feat in FEATURES},
        })
    out.sort(key=lambda r: r["date"])
    return out


def read_weekly_xlsx_long(path: Path):
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb["Weekly Trends"]
    rows = list(ws.iter_rows(values_only=True))
    header_idx = next(i for i, r in enumerate(rows) if r and r[0] == "week_number")
    header = rows[header_idx]
    idx = {name: i for i, name in enumerate(header)}
    weeks = {}
    for r in rows[header_idx + 1:]:
        if not r or r[idx["week_number"]] is None:
            continue
        wk = r[idx["week_number"]]
        feature = r[idx["feature"]]
        if feature not in FEATURES:
            continue
        bucket = weeks.setdefault(wk, {
            "week_number": wk,
            "week_start": r[idx["week_start"]],
            "week_end": r[idx["week_end"]],
            **{feat: None for feat in FEATURES},
        })
        bucket[feature] = to_number(r[idx["average"]])
    return [weeks[k] for k in sorted(weeks)]


def read_weekly_csv_bare(path: Path):
    with path.open(newline="") as f:
        rows = list(csv.DictReader(f))
    out = []
    for row in rows:
        out.append({
            "week_number": to_number(row.get("week_number") or row.get("week")),
            "week_start": None,
            "week_end": None,
            **{feat: to_number(row.get(feat)) for feat in FEATURES},
        })
    return out


def read_weekly_csv_mean(path: Path):
    with path.open(newline="") as f:
        rows = list(csv.DictReader(f))
    out = []
    for row in rows:
        out.append({
            "week_number": to_number(row.get("week")),
            "week_start": row.get("start_date"),
            "week_end": row.get("end_date"),
            **{feat: to_number(row.get(f"{feat}_mean")) for feat in FEATURES},
        })
    return out


WEEKLY_READERS = {
    "xlsx_long": read_weekly_xlsx_long,
    "csv_bare": read_weekly_csv_bare,
    "csv_mean": read_weekly_csv_mean,
}


def main():
    data_root = Path(sys.argv[1] if len(sys.argv) > 1 else "data")
    for folder, cfg in PATIENTS.items():
        patient_dir = data_root / folder
        daily = read_daily(patient_dir / cfg["daily"])
        weekly = WEEKLY_READERS[cfg["weekly_format"]](patient_dir / cfg["weekly"])
        out_path = patient_dir / "wearable.json"
        out_path.write_text(json.dumps({"daily": daily, "weekly": weekly}, indent=2, default=str))
        print(f"{folder}: {len(daily)} daily rows, {len(weekly)} weekly rows -> {out_path}")


if __name__ == "__main__":
    main()
