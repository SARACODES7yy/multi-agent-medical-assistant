"""Deterministic drug-interaction checker over a bundled curated dataset.

The dataset (`data/drug_interactions.json`) is a small curated map of common
pairs seen in Indian outpatient prescribing. It is advisory: severity labels
prompt a clinician to verify, never a substitute for clinical judgement.
"""

import json
import logging
import os
import re

logger = logging.getLogger(__name__)

_DATA_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "drug_interactions.json")

_cache = None


def _load():
    global _cache
    if _cache is None:
        try:
            with open(_DATA_PATH, encoding="utf-8") as fh:
                _cache = json.load(fh)
        except Exception as e:
            logger.error("drug_interactions.json load failed: %s", e)
            _cache = {"aliases": {}, "interactions": []}
    return _cache


def normalize_drug(name: str) -> str:
    """Strip strength/form packaging and fold in the alias table."""
    if not name:
        return ""
    raw = str(name).lower()
    text = re.sub(r"\d+(\.\d+)?\s*(mg|mcg|g|ml|mg/ml|units?)\b", " ", raw)
    text = re.sub(r"tab|cap|capsule|tablet|syrup|susp|suspension|inj|injection|drops?\b", " ", text)
    text = re.sub(r"\b(after|before|with)\s+food\b", " ", text)
    text = re.sub(r"\([^)]*\)", " ", text)
    text = re.sub(r"[^a-z ]", " ", text)
    token = text.strip().split()
    if not token:
        return ""
    canonical = token[0]
    aliases = _load().get("aliases", {})
    return aliases.get(canonical, canonical)


def check_pair(a: str, b: str):
    data = _load()
    for inc in data.get("interactions", []):
        if (inc["drug_a"] == a and inc["drug_b"] == b) or (inc["drug_b"] == a and inc["drug_a"] == b):
            return inc
    return None


def check_drugs(raw_names):
    """Given a list of raw drug names, return [{a, b, severity, effect}] conflicts."""
    data = _load()
    canon = [normalize_drug(n) for n in (raw_names or [])]
    seen = []
    for name, c in zip(raw_names or [], canon):
        if c and c not in [s[1] for s in seen]:
            seen.append((name, c))
    conflicts = []
    for i in range(len(seen)):
        for j in range(i + 1, len(seen)):
            a_label, a = seen[i]
            b_label, b = seen[j]
            if a == b:
                continue
            inc = check_pair(a, b)
            if inc:
                conflicts.append({
                    "drug_a": a_label, "drug_b": b_label,
                    "severity": inc["severity"], "effect": inc["effect"],
                })
    return conflicts


def warning_lines(items):
    """Produce human readable warning strings for prescription `items`.

    Each item is a dict with a `drug` key. Returns a list of strings like
    `INTERACTION (MAJOR): Amoxycillin + Metronidazole — <effect>`.
    """
    drugs = [(i.get("drug") or "") for i in (items or []) if isinstance(i, dict)]
    conflicts = check_drugs(drugs)
    return [
        f"INTERACTION ({c['severity'].upper()}): {c['drug_a']} + {c['drug_b']} — {c['effect']}"
        for c in conflicts
    ]