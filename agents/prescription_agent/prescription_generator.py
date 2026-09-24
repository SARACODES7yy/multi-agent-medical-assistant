"""Prescription generation agent.

Turns the doctor's shorthand prescribing intent ("tab paracetamol 650 TDS x 5d")
into a structured prescription (drug, dose, route, frequency, duration, refills)
for a general practitioner. Cross-checks the patient's allergies and conditions
from the profile and surfaces conflicts as warnings. The doctor reviews, edits
and signs the draft; nothing is finalised automatically.
"""

import json
import logging
import re
from typing import Dict, Optional

logger = logging.getLogger(__name__)

_SYSTEM = (
    "You are a prescription formatting assistant for a general practitioner. "
    "Convert the doctor's prescribing intent into a structured prescription. "
    "Rules: use ONLY drugs, doses, and instructions stated or clearly implied by "
    "the doctor's intent — never invent or substitute drugs. If a field is not "
    "stated, use '?'. Cross-check each drug against the patient's allergies, "
    "conditions and current medications from the profile; put any potential "
    "conflict, duplication or caution in 'warnings'. Keep language concise. "
    "Respond with ONLY a JSON object."
)

_JSON_SHAPE = (
    '{\n'
    '  "items": [\n'
    '    {"drug": "medicine name", "dose": "e.g. 650 mg", "route": "e.g. oral",\n'
    '     "frequency": "e.g. TDS / once daily at night", "duration": "e.g. 5 days",\n'
    '     "refills": "0", "instructions": "e.g. after food"}\n'
    '  ],\n'
    '  "warnings": ["potential allergy/interaction/caution notes, empty list if none"],\n'
    '  "advice": "brief general advice to accompany the prescription"\n'
    '}'
)


def _parse_json(text: str) -> Optional[Dict]:
    cleaned = re.sub(r"^```(?:json)?\s*", "", (text or "").strip(), flags=re.I)
    cleaned = re.sub(r"\s*```$", "", cleaned).strip()
    try:
        return json.loads(cleaned)
    except Exception:
        m = re.search(r"\{.*\}", cleaned, flags=re.S)
        if m:
            try:
                return json.loads(m.group(0))
            except Exception:
                return None
    return None


def _fmt_list(v) -> str:
    if isinstance(v, (list, tuple)):
        return ", ".join(str(x) for x in v if x) or "None"
    return str(v or "None")


def _clean_item(item) -> Dict:
    if not isinstance(item, dict):
        return {"drug": str(item or "?"), "dose": "?", "route": "?",
                "frequency": "?", "duration": "?", "refills": "0", "instructions": ""}
    return {
        "drug": str(item.get("drug") or "?"),
        "dose": str(item.get("dose") or "?"),
        "route": str(item.get("route") or "?"),
        "frequency": str(item.get("frequency") or "?"),
        "duration": str(item.get("duration") or "?"),
        "refills": str(item.get("refills") or "0"),
        "instructions": str(item.get("instructions") or ""),
    }


class PrescriptionGenerator:
    """Generates a structured prescription draft from the doctor's intent text."""

    def __init__(self, config):
        self.llm = config.conversation.llm

    def _build_prompt(self, intent_text: str, profile: Dict, triage: Optional[Dict]) -> str:
        profile = profile or {}
        triage = triage or {}
        profile_bits = {
            "allergies": profile.get("allergies"),
            "conditions": profile.get("conditions"),
            "current_medications": profile.get("medications"),
            "treatments": profile.get("treatments"),
            "medical_history": profile.get("medical_history"),
            "age_band": triage.get("age_band"),
            "sex": triage.get("sex"),
        }
        profile_text = "\n".join(f"- {k}: {v}" for k, v in profile_bits.items() if v) or "(no profile data)"
        context = ""
        if triage:
            context = (
                f"\nCONSULTATION CONTEXT:\n"
                f"- Chief complaints: {_fmt_list(triage.get('chief_complaints'))}\n"
                f"- Triage summary: {_fmt_list(triage.get('summary'))}\n"
            )

        return f"""PATIENT SAFETY PROFILE:
{profile_text}{context}

DOCTOR'S PRESCRIBING INTENT:
{intent_text}

Using ONLY the drugs and doses stated above, draft the prescription. Return JSON exactly in this shape:
{_JSON_SHAPE}"""

    def generate(self, intent_text: str, profile: Optional[Dict] = None,
                 triage: Optional[Dict] = None) -> Dict:
        """Return {'items': [...], 'warnings': [...], 'advice': str}. Falls back gracefully."""
        intent_text = (intent_text or "").strip()
        if not intent_text:
            return {"items": [], "warnings": [], "advice": ""}
        prompt = self._build_prompt(intent_text, profile or {}, triage)
        try:
            resp = self.llm.invoke([("system", _SYSTEM), ("human", prompt)])
            data = _parse_json(getattr(resp, "content", str(resp)))
        except Exception as e:
            logger.error("Prescription generation failed: %s", e)
            data = None
        if not isinstance(data, dict):
            data = {}
        items_raw = data.get("items")
        items = [_clean_item(i) for i in items_raw] if isinstance(items_raw, list) else []
        warnings_raw = data.get("warnings")
        warnings = [str(w) for w in warnings_raw if str(w).strip()] if isinstance(warnings_raw, list) else []
        return {
            "items": items,
            "warnings": warnings,
            "advice": str(data.get("advice") or ""),
        }
