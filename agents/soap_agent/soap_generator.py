"""SOAP note generation agent.

Turns a triage session + patient chat history + profile into a structured
Subjective / Objective / Assessment / Plan note for a general practitioner.
The doctor reviews and signs the draft; nothing is finalised automatically.
"""

import json
import logging
import re
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

_SYSTEM = (
    "You are a clinical documentation assistant for a general practitioner. "
    "Draft a SOAP note (Subjective, Objective, Assessment, Plan) strictly from the "
    "information provided. Never invent findings, vitals, diagnoses, or medications "
    "that are not present in the source. If a section has no supporting information, "
    "write 'Not documented'. Keep language concise and professional. "
    "Respond with ONLY a JSON object."
)

_JSON_SHAPE = (
    '{\n'
    '  "subjective": "chief complaint, history of present illness, patient-reported symptoms, relevant history",\n'
    '  "objective": "vitals, exam findings, lab/imaging results actually documented",\n'
    '  "assessment": "differential/working diagnosis with reasoning, clearly labelled as AI-drafted",\n'
    '  "plan": "investigations, treatment, medications only if documented, follow-up, safety-netting"\n'
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


class SOAPGenerator:
    """Generates a structured SOAP draft from triage + chat + profile context."""

    def __init__(self, config):
        self.llm = config.conversation.llm

    def _build_prompt(self, triage: Dict, chat_history: List[Dict], profile: Dict) -> str:
        triage = triage or {}
        profile = profile or {}
        transcript_lines = []
        for m in (chat_history or [])[-30:]:
            role = m.get("role", "")
            who = "Patient" if role == "user" else (m.get("agent") or "Assistant")
            content = (m.get("content") or "").strip()
            if content:
                transcript_lines.append(f"{who}: {content[:600]}")
        transcript = "\n".join(transcript_lines) or "(no chat transcript available)"

        profile_bits = {
            "name": profile.get("name"),
            "dob": profile.get("dob"),
            "gender": profile.get("gender"),
            "allergies": profile.get("allergies"),
            "conditions": profile.get("conditions"),
            "medications": profile.get("medications"),
            "medical_history": profile.get("medical_history"),
            "family_history": profile.get("family_history"),
        }
        profile_text = "\n".join(f"- {k}: {v}" for k, v in profile_bits.items() if v) or "(no profile data)"

        return f"""PATIENT PROFILE:
{profile_text}

TRIAGE SESSION:
- Age band: {_fmt_list(triage.get("age_band"))}
- Sex: {_fmt_list(triage.get("sex"))}
- Scenario: {_fmt_list(triage.get("scenario"))}
- Narrative: {_fmt_list(triage.get("narrative"))}
- Risk level: {_fmt_list(triage.get("risk"))} (score {_fmt_list(triage.get("score"))})
- Triage summary: {_fmt_list(triage.get("summary"))}
- Timeline: {_fmt_list(triage.get("timeline"))}
- Chief complaints: {_fmt_list(triage.get("chief_complaints"))}
- Red flags: {_fmt_list(triage.get("red_flags"))}
- Missing info: {_fmt_list(triage.get("missing_info"))}
- Suggested tests: {_fmt_list(triage.get("tests"))}

CONSULTATION TRANSCRIPT:
{transcript}

Using ONLY the information above, draft the SOAP note. Return JSON exactly in this shape:
{_JSON_SHAPE}"""

    def generate(self, triage: Dict, chat_history: Optional[List[Dict]] = None,
                 profile: Optional[Dict] = None) -> Dict:
        """Return {'subjective','objective','assessment','plan'} dict. Falls back gracefully."""
        prompt = self._build_prompt(triage or {}, chat_history or [], profile or {})
        try:
            resp = self.llm.invoke([("system", _SYSTEM), ("human", prompt)])
            data = _parse_json(getattr(resp, "content", str(resp)))
        except Exception as e:
            logger.error("SOAP generation failed: %s", e)
            data = None
        if not isinstance(data, dict):
            data = {}
        out = {
            "subjective": str(data.get("subjective") or "Not documented"),
            "objective": str(data.get("objective") or "Not documented"),
            "assessment": str(data.get("assessment") or "Not documented"),
            "plan": str(data.get("plan") or "Not documented"),
        }
        return out

    @staticmethod
    def to_full_text(soap: Dict) -> str:
        return (
            f"S (Subjective):\n{soap.get('subjective','')}\n\n"
            f"O (Objective):\n{soap.get('objective','')}\n\n"
            f"A (Assessment):\n{soap.get('assessment','')}\n\n"
            f"P (Plan):\n{soap.get('plan','')}"
        )
