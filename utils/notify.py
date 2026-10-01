"""In-app notifications + daily clinical digest for doctor/patient workflows.

Notification rows live in the shared `notifications` table (SQLite or Supabase)
and are surfaced through the topbar bell. The daily digest aggregates the items
a doctor should act on today: due follow-ups, critical labs, pending drafts and
unpaid invoices. Channel hooks (email/SMS) can be added later behind the same
`dispatch` function without touching the UI contract.
"""

import logging
import os
import json
import uuid
from datetime import datetime, date, timezone

logger = logging.getLogger(__name__)


def _severity(flags) -> int:
    """0 none, 1 abnormal, 2 critical — matches app._lab_severity."""
    worst = 0
    for f in flags or []:
        text = (f if isinstance(f, str) else json.dumps(f, ensure_ascii=False)).lower()
        if isinstance(f, dict):
            text = " ".join(str(v) for v in f.values()).lower()
        if "critical" in text or "severe" in text:
            worst = max(worst, 2)
        else:
            worst = max(worst, 1)
    return worst


def create_notification(db, user_id, kind, title, body="", link=""):
    """Persist an in-app notification. Returns the row dict or None."""
    try:
        return db.create_notification(user_id, kind, title, body, link)
    except Exception as e:
        logger.error("create_notification failed: %s", e)
        return None


def _today():
    return date.today().isoformat()


def _due_followups(db):
    """Triage sessions with a follow_up_date <= today that are not completed."""
    out = []
    for s in db.get_triage_sessions(limit=200):
        fu = (s.get("follow_up_date") or "").strip()
        if not fu:
            continue
        day = fu[:10]
        if day and day <= _today() and s.get("status") != "completed":
            out.append(s)
    return out


def _critical_labs(db):
    out = []
    for lab in db.get_recent_lab_results(limit=200):
        if _severity(lab.get("flags")) >= 2:
            out.append(lab)
    return out


def _drafts(db):
    try:
        soaps = sum(1 for s in db.get_triage_sessions(limit=100) if s.get("status") == "requested")
    except Exception:
        soaps = 0
    return {"draft_soap": 0, "draft_rx": 0, "new_requests": soaps}


def build_daily_digest(db):
    """Aggregate today's clinical action items into a digest payload."""
    followups = _due_followups(db)
    labs = _critical_labs(db)
    drafts = _drafts(db)

    items = [
        {"kind": "followup_due", "count": len(followups),
         "rows": [{"patient": s.get("user_id"), "session": s.get("id"),
                   "date": (s.get("follow_up_date") or "")[:10]} for s in followups[:20]]},
        {"kind": "lab_critical", "count": len(labs),
         "rows": [{"patient": l.get("user_id"), "flags": l.get("flags") or [], "file": l.get("filename") or ""}
                  for l in labs[:20]]},
    ]
    try:
        invoices = db.list_invoices()
        unpaid = [i for i in invoices if i.get("status") != "paid"]
        items.append({"kind": "invoice_unpaid", "count": len(unpaid),
                      "rows": [{"patient": i.get("patient_id"), "no": i.get("invoice_no"),
                                "total": i.get("total"), "currency": i.get("currency", "INR")} for i in unpaid[:20]]})
        items.append({"kind": "new_requests", "count": drafts["new_requests"], "rows": []})
    except Exception as e:
        logger.warning("digest invoice scan skipped: %s", e)

    summary = {it["kind"]: it["count"] for it in items}
    summary["total"] = sum(it["count"] for it in items)
    return {
        "date": _today(),
        "summary": summary,
        "items": items,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


def _digest_text(digest) -> str:
    lines = []
    if digest["summary"].get("followup_due"):
        lines.append(f"{digest['summary']['followup_due']} follow-up(s) due today")
    if digest["summary"].get("lab_critical"):
        lines.append(f"{digest['summary']['lab_critical']} critical lab result(s)")
    if digest["summary"].get("invoice_unpaid"):
        lines.append(f"{digest['summary']['invoice_unpaid']} unpaid invoice(s)")
    if digest["summary"].get("new_requests"):
        lines.append(f"{digest['summary']['new_requests']} new triage request(s)")
    return "; ".join(lines) if lines else "All caught up — no pending action items today."


def dispatch_digest(db, create_fn=None):
    """Create one digest notification per doctor/nurse for today.

    Dedupes per user+date by checking an existing digest notification today.
    """
    create_fn = create_fn or create_notification
    digest = build_daily_digest(db)
    if not digest["summary"]["total"]:
        return digest, 0
    sent = 0
    today = _today()
    for doc in db.get_doctors() or []:
        uid = doc.get("id")
        if not uid:
            continue
        try:
            existing = db.get_notifications(uid, limit=100)
            if any(n.get("kind") == "digest" and (n.get("created_at") or "").startswith(today) for n in existing):
                continue
        except Exception:
            pass
        title = f"Daily clinical digest — {today}"
        body = _digest_text(digest)
        if create_fn(db, uid, "digest", title, body, link="/"):
            sent += 1
    return digest, sent


def notify_followups_due(db):
    """Create follow-up-due notifications for all doctors (used by the scheduler)."""
    created = 0
    for s in _due_followups(db):
        patient_id = s.get("user_id")
        for doc in db.get_doctors() or []:
            uid = doc.get("id")
            if not uid:
                continue
            n = create_notification(db, uid, "followup_due",
                                    "Follow-up due",
                                    f"Patient {str(patient_id)[:8]} has a follow-up due "
                                    f"({str(s.get('follow_up_date'))[:10]}).",
                                    link="/")
            if n:
                created += 1
    return created