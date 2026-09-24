#!/usr/bin/env bash
# Copy only what the deployed site serves into dist/ (Cloudflare Pages output).
# Raw FHIR bundles, .docx/.csv/.xlsx/.pdf sources and the duplicate
# "synthetic patients/" folder stay out: the UI reads index/content/wearable
# JSON, and the assistant reads record.json (scripts/build_agent_records.py).
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist
mkdir -p dist/data
cp index.html dashboard.html login.html dist/
cp -R assets dist/
cp data/patients.json dist/data/
python3 - <<'PY'
import json, shutil
from pathlib import Path
for p in json.load(open("data/patients.json")):
    src, dst = Path("data") / p["folder"], Path("dist/data") / p["folder"]
    dst.mkdir(parents=True, exist_ok=True)
    for name in ("index.json", "content.json", "wearable.json", "record.json"):
        shutil.copy2(src / name, dst / name)
PY
du -sh dist
