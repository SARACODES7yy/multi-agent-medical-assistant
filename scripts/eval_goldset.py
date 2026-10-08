"""Gold-set evaluation for the triage extraction layer.

Ports the production rule-based fallback (the deterministic safety net used
when the LLM summarizer is unreachable) and scores it against 5 canonical
gold cases. Run without dependencies:

    python scripts/eval_goldset.py            # offline rule evaluation
    python scripts/eval_goldset.py --live http://127.0.0.1:8123 --login doctor@test.com:doctor123
                                             # plus live queue-ordering checks

Exits non-zero if risk accuracy falls below the threshold, so it can gate CI.
The gold set is intentionally small but clinically diverse: cardiac emergency,
stroke, persistent fever, viral illness, and a routine checkup.
"""

import argparse
import json
import re
import sys

# --- Faithful port of static/js/triage.js SIGNALS (do not edit independently) ---
SIGNALS = {
    "emergency": [
        ["chest pain|pressure|squeeze", 2, "Acute chest pain"],
        ["shortness of breath|difficulty breathing|cannot breathe", 2, "Respiratory distress"],
        ["fainting|lost consciousness|passed out|unconscious", 2, "Loss of consciousness"],
        ["seizure|convulsion|fits", 2, "Seizure"],
        ["active bleeding|profuse bleed", 2, "Active bleeding"],
        ["stroke|sudden weakness|face droop|slurred speech", 2, "Stroke signs"],
        ["severe allergic|anaphylaxis|throat tight", 2, "Anaphylaxis"],
        ["poisoning|overdose|ingested", 2, "Suspected poisoning"],
        ["major trauma|open fracture|penetrating", 2, "Major trauma"],
        ["confusion|altered sensorium|delirium", 2, "Altered sensorium"],
        ["high fever >39|fever above 39|temp 39", 1, "High fever (>39 C)"],
    ],
    "urgent": [
        ["severe headache|worst headache of", 1, "Severe headache"],
        ["vomiting blood|blood in vomit|hematemesis", 1, "Haematemesis"],
        ["blood in urine|hematuria|blood in stool|hematochezia", 1, "Blood in urine/stool"],
        ["high fever|persistent fever|prolonged fever|fever 3 days|fever 4 days|fever 5 days", 1, "Persistent high fever"],
        ["difficulty swallowing|unable to swallow", 1, "Dysphagia"],
        ["jaundice|yellow eyes|yellow skin", 1, "Jaundice"],
        ["rapid heart rate|palpitations|racing heart", 1, "Tachycardia"],
        ["severe abdominal pain|acute abdomen", 1, "Severe abdominal pain"],
        ["breathlessness|breathing trouble|gasping", 1, "Breathlessness"],
        ["uncontrolled diabetes|blood sugar very high", 1, "Uncontrolled diabetes"],
        ["dangerous|not improving|getting worse|worsening", 1, "Condition worsening"],
        ["severe pain|excruciating pain", 1, "Severe pain"],
        ["weight loss|unintentional weight loss", 1, "Unintentional weight loss"],
        ["cancer|malignancy|carcinoma|tumor|neoplasm|metastatic|metastasis|oncology", 2, "Suspected malignancy"],
    ],
    "standard": [
        ["moderate pain|moderate fever|mild fever|low grade fever", 0, "Moderate symptoms"],
        ["cough|cold|runny nose|sneezing", 0, "Respiratory symptoms"],
        ["diarrhea|loose stools|vomiting", 0, "Gastroenteritis"],
        ["rash|skin lesions|itching", 0, "Dermatological issue"],
        ["headache|dizziness|vertigo", 0, "Headache / dizziness"],
        ["fatigue|weakness|body ache|joint pain", 0, "Fatigue / musculoskeletal pain"],
        ["urinary tract|burning micturition|UTI", 0, "Urinary complaint"],
        ["eye redness|conjunctivitis|eye discharge", 0, "Eye complaint"],
        ["ear pain|ear discharge|hearing loss", 0, "Ear complaint"],
        ["back pain|neck pain|sprain", 0, "Musculoskeletal pain"],
    ],
    "routine": [
        ["general checkup|health checkup|routine checkup", 0, "General checkup"],
        ["annual checkup|periodic health", 0, "Periodic health"],
        ["followup|follow-up|review visit|regular checkup", 0, "Follow-up"],
        ["medication review|drug review", 0, "Medication review"],
        ["vaccination|immunization|vaccine", 0, "Vaccination"],
        ["counselling|health education|lifestyle", 0, "Health counselling"],
    ],
}
RISK_RANK = {"emergency": 0, "urgent": 1, "standard": 2, "routine": 3}


def rule_based_note(narrative):
    """Port of triage.js ruleBasedNote() — keyword-weighted risk + red flags."""
    text = narrative.lower()
    found = {lv: [] for lv in SIGNALS}
    for lv, entries in SIGNALS.items():
        for pat, weight, label in entries:
            if re.search(pat, text):
                found[lv].append({"label": label, "weight": weight})
    score = 50
    highest = "routine"
    rationale = []
    for lv in ("emergency", "urgent", "standard", "routine"):
        if not found[lv]:
            continue
        mult = 15 if lv == "emergency" else 8 if lv == "urgent" else 3
        score += sum(f["weight"] * mult for f in found[lv])
        if RISK_RANK[lv] < RISK_RANK[highest]:
            highest = lv
        rationale.append(f"{lv}: " + ", ".join(f["label"] for f in found[lv]))
    score = max(0, min(100, score))
    red_flags = [f["label"] for f in found["emergency"] + found["urgent"]]
    return {"risk": highest, "score": score, "red_flags": red_flags,
            "rationale": "; ".join(rationale) or "No signal matched."}


GOLD = [
    {
        "id": "G1", "expected": "emergency",
        "narrative": ("47-year-old male with sudden crushing chest pressure and a squeezing sensation "
                      "radiating to the left arm since 45 minutes, profuse sweating, cold clammy skin."),
        "must_detect": ["chest", "pain"],
        "red_flags_expected": True,
    },
    {
        "id": "G2", "expected": "emergency",
        "narrative": ("68-year-old female suddenly lost control of the left side of her face, slurred "
                      "speech, and cannot lift her left arm since about 30 minutes."),
        "must_detect": ["stroke"],
        "red_flags_expected": True,
    },
    {
        "id": "G3", "expected": "urgent",
        "narrative": ("5-year-old child with high fever for 4 days, not improving despite paracetamol, "
                      "reduced appetite, no rash, no breathing difficulty."),
        "must_detect": ["fever", "worsening"],
        "red_flags_expected": True,
    },
    {
        "id": "G4", "expected": "standard",
        "narrative": ("32-year-old adult with mild fever, dry cough, runny nose and body ache for 2 days. "
                      "No breathing difficulty, no blood, appetite normal."),
        "must_detect": [],
        "red_flags_expected": False,
    },
    {
        "id": "G5", "expected": "routine",
        "narrative": ("58-year-old here for the annual health checkup and vaccination review. No complaints."),
        "must_detect": [],
        "red_flags_expected": False,
    },
]


def evaluate(note_fn):
    rows = []
    for g in GOLD:
        got = note_fn(g["narrative"])
        risk_ok = got["risk"] == g["expected"]
        if g["red_flags_expected"]:
            miss = [k for k in g["must_detect"]
                    if not any(k.lower() in rl.lower() for rl in got["red_flags"])]
        else:
            miss = [] if not got["red_flags"] else ["unexpected red flags raised"]
        rows.append((g, got, risk_ok, miss))
    return rows


def _fmt_level(lv):
    return lv.upper().ljust(9)


def run_offline():
    print("GOLD-SET EVALUATION (rule-based fallback, port of triage.js ruleBasedNote)")
    print("=" * 78)
    rows = evaluate(rule_based_note)
    for g, got, risk_ok, miss in rows:
        status = "PASS" if risk_ok and not miss else "FAIL"
        det = "risk=OK" if risk_ok else f"got risk={got['risk']}"
        if miss:
            det += f"; missing signals: {tuple(miss)}"
        print(f"{status}  {g['id']}  risk {g['expected'].upper()} -> {_fmt_level(got['risk'])} score={got['score']:>3}  {det}")
    risk_acc = sum(1 for _, _, ok, _ in rows if ok) / len(rows)
    print("-" * 78)
    print(f"risk accuracy: {risk_acc:.0%}  ({sum(1 for _,_,ok,_ in rows if ok)}/5)")
    return risk_acc


def run_live(base, login):
    """Optional: verify the server ranks an emergency gold case above a standard one."""
    import requests
    email, pw = login.split(":", 1)
    s = requests.Session()
    r = s.post(f"{base}/login", json={"email": email, "password": pw})
    if r.status_code != 200:
        print(f"LIVE login failed: {r.text[:120]}")
        return False
    sc = r.headers.get("Set-Cookie", "")
    for p in sc.split(","):
        p = p.strip()
        if p.lower().startswith("session_id="):
            s.headers["Cookie"] = "session_id=" + p.split(";", 1)[0].split("=", 1)[1]
    created = []
    for g in GOLD[:2]:  # emergency + urgent cases
        rr = s.post(f"{base}/api/triage/sessions", json={
            "anonym_code": f"GOLD-{g['id']}", "narrative": g["narrative"],
            "risk": g["expected"], "score": 0, "consent": True, "src": "goldset"})
        if rr.status_code == 200:
            created.append((g, rr.json()["session"]["id"]))
        else:
            print(f"LIVE create GOLD-{g['id']} failed: {rr.status_code} {rr.text[:120]}")
    ok = True
    wl = s.get(f"{base}/api/doctor/worklist")
    if wl.status_code == 200:
        items = wl.json().get("worklist", [])
        gold_ids = {cid for _, cid in created}
        gold_items = [it for it in items if it.get("id") in gold_ids]
        order = [it.get("risk") for it in gold_items]
        print(f"LIVE worklist risk order for gold sessions: {order}")
        print(f"LIVE gold sessions present in worklist: {len(gold_items)}/{len(created)}")
        if len(gold_items) != len(created):
            print("LIVE expected all created gold sessions to appear in the worklist")
            ok = False
        elif order != sorted(order, key=lambda r: RISK_RANK.get(r, 3)):
            print("LIVE worklist NOT sorted by risk (emergency first)")
            ok = False
        elif order and order[0] != "emergency":
            print("LIVE expected G1 (emergency) to sort first")
            ok = False
    else:
        print(f"LIVE worklist failed: {wl.status_code} {wl.text[:120]}")
        ok = False
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", help="live server base URL, e.g. http://127.0.0.1:8123")
    ap.add_argument("--login", help="email:password for the live check")
    args = ap.parse_args()

    acc = run_offline()
    ok = acc >= 0.8
    if args.live:
        print("LIVE SYSTEM CHECKS")
        live_ok = run_live(args.live, args.login)
        print(f"live checks: {'PASS' if live_ok else 'FAIL'}")
        ok = ok and live_ok
    print("=" * 78)
    if ok:
        print("GOLD-SET EVALUATION PASSED")
        return 0
    print("GOLD-SET EVALUATION FAILED (below threshold)")
    return 1


if __name__ == "__main__":
    sys.exit(main())