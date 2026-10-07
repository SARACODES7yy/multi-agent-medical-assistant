# MediAssist — Multi-Agent Medical Triage Assistant

A working prototype of a multi-agent **medical triage + care-coordination** platform for low-resource
health settings (public hospitals, PHCs, industrial/campus health units). It is a **live system running
on synthetic demo data** — every patient record shown is fabricated for the showcase; nothing here
should be used for real clinical decisions.

> **Educational, non-diagnostic prototype.** The AI layer gives advisory triage only. In a real
> emergency, call your local emergency number.

---

## 1. Problem Statement coverage

Built around the hackathon brief (emergency/safety + language + India-relevance + multi-agent).

| PS requirement | What the prototype does |
|---|---|
| **Emergency detection & priority** | Multi-signal emergency/urgent rules run client-side (`ruleBasedNote`) AND server-side risk ranking (`_RISK_RANK`). Emergency sessions **page the whole care team** and **cannot be silently downgraded or completed without explicit acknowledgement**. |
| **OCR report intake** | Lab/report upload → isolated onnxruntime OCR worker (never blocks the API) → structured `key_values` + `abnormal_flags` → critical-lab toast + worklist priority. |
| **Multi-agent pipeline** | Chat routing across specialist agents (triage, RAG over patient records, prescription/soap generation, lab interpretation) driven by `agents/agent_decision.py`. |
| **India relevance** | 6 UI languages + 12 voice locales, facility types (PHC, govt hospital, industrial/campus units), regional scenarios (fever camps, immunization days, MCH). |
| **Patient safety rails** | Informed-consent gate (server-enforced), emergency guardrails, follow-up scheduler + daily clinical digest, batch validation with per-item status transitions. |

## 2. Architecture

```
browser (intake / queue / chat / profile)
   │
   ▼
FastAPI app (app.py) ──┐
   │                   ├─ agents/        clinical LLM agents + RAG
   │                   ├─ models/        db (SQLite ⇄ Supabase), PatientRAG
   │                   ├─ utils/         OCR worker, notifications, digest, interactions
   │                   └─ static/        triage UI, i18n (6 languages), chat
   ▼
SQLite (./data/medical.db)  ·  optional Supabase  ·  Qdrant (patient RAG vectors)
```

- **Storage abstraction**: `models/db.py` exposes one `Database` interface with SQLite and Supabase
  backends; the app is written against the interface.
- **Audit**: server-side append-only `audit_log` (both backends) records consent decisions, session
  saves, emergency escalations, blocked downgrades/completions, status changes, and ambulance requests.
  Staff read it via `GET /api/staff/audit`.
- **Digest scheduler**: a background loop dispatches a per-doctor daily digest of due follow-ups,
  critical labs, pending drafts and unpaid invoices (`utils/notify.py`).

## 3. Feature map

- **Triage intake** — narrative + (optional) OCR report → structured note (`risk`, `score`, red flags,
  chief complaints, expected findings, missing info, follow-up questions, extracted tests). Consent
  must be confirmed before anything is generated or persisted.
- **Reviewer queue** — server-priority worklist (critical labs → triage risk → queue status), manual
  pin/drag ordering, per-item Schedule/Complete, batch validate, emergency confirm-modals.
- **Chat** — multi-agent assistant over patient records (per-patient RAG with identity-metadata
  filtering), history + translation of replies into regional languages.
- **Appointments** — role-aware: patients book calls against doctor availability; staff see an
  appointments view (today, pending, confirmed, completed) with confirm/reject flows.
- **OCR lab reports** — upload, extract, flag, and escalate abnormal/critical values.
- **SOAP & prescriptions** — clinician-facing SOAP generation and **doctor-signed prescription
  drafts** (patient intents never auto-prescribe).
- **Billing & checkups (demo showcase)** — invoices and health-checkup requests stay visible to
  demonstrate the full journey; all data is synthetic.
- **Emergency (trial)** — `/emergency` is a **simulated** ambulance request flow: sign-in required,
  GPS quantized to ~1 km, phone masked, everything flagged `simulated`, nothing dispatched.

## 4. Safety & privacy controls

| Control | Where | Behavior |
|---|---|---|
| Informed consent | `POST /api/triage/sessions` | Hard gate: request is rejected (400) if `consent != true`. |
| Emergency guardrails | upsert + `PATCH /api/triage/session/{id}` | Downgrade of an emergency → 409. Completion requires `confirm_emergency=true`. |
| Care-team paging | upsert | New emergency session → notification to every doctor. |
| Server audit trail | `db.add_audit` / `GET /api/staff/audit` | Append-only; includes blocked actions with actor identity. |
| Right to erasure | `POST /api/profile/delete` | Deletes profile, sessions, labs, SOAP, prescriptions, invoices, bookings, notifications **and RAG vectors**. |
| Data portability | `GET /api/profile/export` | Returns everything the platform holds about the caller. |
| RAG PII minimisation | `models/patient_rag.py` | Names, DOB, ID numbers and emergency contacts are **never embedded** into vectors. |
| Ambulance (trial) | `POST /api/ambulance/request` | Auth required; GPS quantized; phone masked; `simulated=true`. |
| Non-diagnostic stance | every surface | "Advisory only" labels; no prescription on patient intent; no real dispatch. |

## 5. Run it

```bash
pip install -r requirements.txt
python app.py                 # http://localhost:8000  (env: PORT, HOST, USE_SUPABASE, DATA_DIR)
```

Demo login: `doctor@test.com` / `doctor123` (doctor role), or register a patient account.

### Verification

| Check | Command | What it verifies |
|---|---|---|
| UI regression (52) | `python /tmp/opencode/pw_final.py` | Themes, queue, chat, analytics, mobile, 0 JS errors |
| Safety/privacy (25) | `python /tmp/opencode/safety_check.py` | Consent gate, emergency guards, audit, ambulance, export/delete |
| Gold-set (5) | `python scripts/eval_goldset.py` | Rule fallback risk accuracy + live worklist ordering |
| i18n drift | `python scripts/check_i18n.py` | All UI keys present in all 6 languages |

`scripts/eval_goldset.py` and `scripts/check_i18n.py` live in the repo so the quality gates travel
with the code.

## 6. Honest limitations

- The triage summarizer runs as a client-side LLM call with a deterministic keyword-weighted fallback
  (`ruleBasedNote`); the gold set scores the fallback layer, not the LLM's extraction verbatim.
- Ambulance, billing and prescriptions are show-cased features on synthetic data, not delivery systems.
- Clinical grade, device connectivity and real-world staffing workflows are out of scope for this build.