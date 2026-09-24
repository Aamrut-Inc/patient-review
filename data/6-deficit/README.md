# Test user profiles — Synthea with custom modules

The same three archetypes as `user_profiles/`, regenerated with **two purpose-written Synthea
modules** that close the two biggest limitations of that build. The earlier builds are untouched:

| build | generator | P01 age | weight trajectory | med time-of-day |
|---|---|---|---|---|
| `user_profiles/` | Synthea, stock modules | **16** (forced) | ❌ none | ❌ none |
| `user_profiles_promptehr/` | PromptEHR | adult (z = −1.16) | ❌ none | ❌ none |
| **`user_profiles_synthea_modules/`** ← this | Synthea + 2 custom modules | **28** | ✅ **25 monthly weigh-ins** | ✅ **"Every morning"** |

## The two modules

`modules/adult_adhd.json` — Synthea's stock `attention_deficit_disorder.json` is **children only**:
its code is `192127007` *Child attention deficit disorder* and an `Age_Guard` ends the condition at
18. That is the sole reason base-build P01 had to be a 16-year-old paired with a young-**adult**
wearable trace. This module keeps ADHD active into adulthood using SNOMED `406506008`, and sets
`prescription.instructions` to a SNOMED timing qualifier — which **does** reach FHIR as
`dosageInstruction.additionalInstruction`, so morning dosing is now expressible.

`modules/weight_trajectory.json` — stock Synthea records a weight at wellness encounters but no
deliberate *trajectory*. P02 and P03 are both built around a **weight plateau** that previously
appeared nowhere in the data. This module emits monthly Body Weight + BMI over two years:
8 months of active loss (≈ −0.9 kg/month), then a **plateau** (≈ −0.03 kg/month). It uses
`SetAttribute.expression` (CQL-lite) for the arithmetic — supported by the engine, unused by any
of the 242 stock modules — and is date-gated to 2019+ so the curve overlaps the 2021–22 wearable
windows.

## The three profiles

| | P01 | P02 | P03 |
|---|---|---|---|
| **Archetype** | ADHD (**adult**) | Sedentary older adult | Caloric-deficit mismatch |
| **Person** | M, **28** | F, **70** | F, **39** |
| **BMI** | 27.6 | 28.0 | 30.3 |
| **Key conditions** | **ADHD (406506008)**, obesity | **Obstructive sleep apnea**, sleep disorder, prediabetes, obesity | Obesity, asthma |
| **Medication** | Methylphenidate 20 mg, **every morning** | HCTZ, lisinopril, amlodipine | fluticasone, albuterol, levonorgestrel IUD |
| **Weight** | 89.1 → 81.4 kg (25 pts) | 72.8 → 65.1 kg (21 pts) | 72.0 → 64.3 kg (23 pts) |
| **Plateau** | from pt 9, −0.03 kg/mo | from pt 10, −0.03 kg/mo | from pt 9, −0.03 kg/mo |

P02 is arguably a **better** archetype fit than the base build: it landed **obstructive sleep apnea
+ sleep disorder**, a genuine physiological mechanism for a sleep-driven plateau, where the base
build had only osteoarthritis.

## Layout

```
user_profiles_synthea_modules/
├── README.md · BUILD_REPORT.txt/.pdf
├── modules/          adult_adhd.json, weight_trajectory.json   ← the custom modules
├── profiles/         3 profile JSONs (now carry basic_facts.weight_trajectory)
├── fhir/             3 FHIR R4 documents, 498–561 resources, all validated
├── wearable/         6 CSVs — byte-identical to user_profiles/
├── scripts/          build + FHIR scripts for this variant
└── synthea_source/   raw Synthea FHIR bundle per selected patient
```

The wearable half is **unchanged** (same LifeSnaps participants, windows and values), so this build
is directly comparable to the other two.

## Reproducing

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@17; export PATH="$JAVA_HOME/bin:$PATH"
cd synthea
./run_synthea --exporter.csv.export=true --exporter.baseDirectory=<out>/adhd \
   -d ../user_profiles_synthea_modules/modules -p 400 -s 8801 -g M -a 25-45 -r 20210906
#  ... -p 210 -s 8802 -g F -a 65-72 -r 20220121     (P02)
#  ... -p 200 -s 8803 -g F -a 35-45 -r 20220119     (P03)
cd .. && python3 user_profiles_synthea_modules/scripts/build_profiles_modules.py
python3 user_profiles_synthea_modules/scripts/build_fhir.py
```

`-d` **adds** to the stock module set (`Module.addModules`), it does not replace it — so these
patients still get the full stock comorbidity model.

## Limitations that remain

1. **Medication time-of-day is coded, not a clock time.** `"Every morning"` is a SNOMED qualifier.
   The prescription schema has **no** clock-time field, so an exact "08:00" is still impossible.
2. **SNOMED codes could not be validated offline** — Synthea ships no terminology file. `406506008`
   (ADHD) and `307145004` (Every morning) should be checked against a terminology server.
3. **Synthea's own weight observations interleave** with the module's, under the same LOINC code,
   and do not follow the curve. The builder removes them with an interpolation-based outlier filter
   (a true point sits within 1.0 kg of the midpoint of its neighbours); this also drops a few
   legitimate points, which is why the series are 21–25 rather than 25 long.
4. **Occupation, training, caffeine, diet, family history** — still not modelled, and a module
   could only supply them by inventing content wholesale.
5. **Driving Synthea's own `Weight` VitalSign from the trajectory was attempted and reverted** —
   `VitalSign.expression` evaluates once rather than per pass and froze the series.
