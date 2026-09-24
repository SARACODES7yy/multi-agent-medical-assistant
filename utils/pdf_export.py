"""Branded PDF export for clinical documents (SOAP notes, prescriptions, invoices, referrals).

Renders an HTML fragment onto a letterhead using PyMuPDF's Story engine (already a
project dependency, no extra system libraries required so it stays Render/Docker safe).
Multi-page output is handled automatically; content is never shrunk to fit one page.
"""

import io
import logging
from typing import Optional

import pymupdf

logger = logging.getLogger(__name__)

_PAGE_CSS = """
body { font-family: sans-serif; font-size: 11px; color: #1f2733; line-height: 1.5; }
h1 { font-size: 18px; margin: 0 0 2px 0; color: #1F8A72; }
h2 { font-size: 14px; margin: 14px 0 6px 0; color: #14504a; border-bottom: 1px solid #d7e3e0; padding-bottom: 3px; }
h3 { font-size: 12px; margin: 10px 0 4px 0; color: #1F8A72; }
p { margin: 4px 0; }
table { border-collapse: collapse; width: 100%; margin: 6px 0; }
th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid #e4e9ee; font-size: 10.5px; }
th { color: #14504a; }
.letterhead { border-bottom: 2px solid #1F8A72; padding-bottom: 8px; margin-bottom: 12px; }
.lh-name { font-size: 18px; font-weight: bold; color: #14504a; }
.lh-sub { font-size: 10.5px; color: #5a6b7b; margin-top: 2px; }
.lh-meta { font-size: 10px; color: #8294a6; margin-top: 6px; }
.sig { margin-top: 24px; font-size: 10.5px; color: #5a6b7b; }
.sig-line { border-top: 1px solid #96a0bd; width: 220px; margin-top: 26px; padding-top: 3px; }
.badge { display: inline-block; padding: 1px 7px; border-radius: 8px; font-size: 9.5px; color: #ffffff; }
.muted { color: #8294a6; }
ul { margin: 4px 0 4px 18px; padding: 0; }
li { margin: 2px 0; }
"""


def render_pdf_bytes(body_html: str, user_css: str = "") -> bytes:
    """Render an HTML fragment to A4 PDF bytes. Never raises; returns b'' on failure."""
    html = f"<html><body>{body_html}</body></html>"
    css = _PAGE_CSS + (user_css or "")
    try:
        buf = io.BytesIO()
        writer = pymupdf.DocumentWriter(buf)
        mediabox = pymupdf.paper_rect("a4")
        where = mediabox + (48, 56, -48, -56)
        story = pymupdf.Story(html=html, user_css=css)
        more = 1
        while more:
            dev = writer.begin_page(mediabox)
            more, _ = story.place(where)
            story.draw(dev)
            writer.end_page()
        writer.close()
        return buf.getvalue()
    except Exception as e:
        logger.error("PDF render failed: %s", e)
        return b""


def _esc(s) -> str:
    return (
        str(s if s is not None else "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def letterhead(doctor_name: str, qualification: Optional[str] = None,
               clinic: Optional[str] = None, meta_lines: Optional[list] = None) -> str:
    """Build the branded letterhead block shared by all clinical PDFs."""
    sub_bits = [b for b in (qualification, clinic) if b]
    meta = "".join(f'<div class="lh-meta">{_esc(m)}</div>' for m in (meta_lines or []))
    return (
        '<div class="letterhead">'
        f'<div class="lh-name">{_esc(doctor_name or "Medical Assistant")}</div>'
        + (f'<div class="lh-sub">{_esc(" · ".join(sub_bits))}</div>' if sub_bits else "")
        + meta
        + "</div>"
    )


def signature_block(name: str, label: str = "Signature", stamp: Optional[str] = None) -> str:
    stamp_html = f'<div class="muted">{_esc(stamp)}</div>' if stamp else ""
    return (
        '<div class="sig">'
        f'<div class="sig-line">{_esc(name or "")}</div>'
        f'<div>{_esc(label)}</div>'
        + stamp_html
        + "</div>"
    )


def _doctor_letterhead(doctor_profile: Optional[dict], meta_lines: Optional[list] = None) -> str:
    prof = doctor_profile or {}
    return letterhead(
        prof.get("name") or "Medical Assistant",
        prof.get("qualification"),
        clinic=prof.get("clinic"),
        meta_lines=meta_lines,
    )


def _fmt_dt(value) -> str:
    s = str(value or "")
    if not s:
        return ""
    return s.replace("T", " ").split(".")[0].split("+")[0].strip()


def build_soap_pdf(note: dict, doctor_profile: Optional[dict] = None,
                   patient_label: str = "") -> bytes:
    """Render a SOAP note dict into branded A4 PDF bytes. Never raises."""
    note = note or {}
    meta = [
        f"Patient: {patient_label}" if patient_label else "",
        f"Date: {_fmt_dt(note.get('created_at'))}",
    ]
    meta = [m for m in meta if m]
    if note.get("status") == "signed":
        meta.append(f"Status: Signed {_fmt_dt(note.get('signed_at'))}")
    else:
        meta.append("Status: DRAFT — not for clinical use until signed")

    sections = [
        ("Subjective", note.get("subjective")),
        ("Objective", note.get("objective")),
        ("Assessment", note.get("assessment")),
        ("Plan", note.get("plan")),
    ]
    body = "".join(f"<h2>{title}</h2><p>{_esc(text)}</p>" for title, text in sections if text)

    html = (
        _doctor_letterhead(doctor_profile, meta)
        + "<h1>SOAP Note</h1>"
        + body
        + signature_block(
            (doctor_profile or {}).get("name") or "",
            stamp="Digitally signed via HealthMate clinical suite" if note.get("status") == "signed" else "DRAFT — unsigned",
        )
    )
    return render_pdf_bytes(html)


def build_prescription_pdf(rx: dict, doctor_profile: Optional[dict] = None,
                           patient_label: str = "") -> bytes:
    """Render a prescription dict into branded A4 PDF bytes. Never raises."""
    rx = rx or {}
    meta = [
        f"Patient: {patient_label}" if patient_label else "",
        f"Date: {_fmt_dt(rx.get('created_at'))}",
    ]
    meta = [m for m in meta if m]
    if rx.get("status") == "signed":
        meta.append(f"Status: Signed {_fmt_dt(rx.get('signed_at'))}")
    else:
        meta.append("Status: DRAFT — not valid until signed")

    rows = []
    for i, item in enumerate(rx.get("items") or [], 1):
        if not isinstance(item, dict):
            rows.append(f"<tr><td>{i}</td><td colspan='6'>{_esc(item)}</td></tr>")
            continue
        rows.append(
            "<tr>"
            f"<td>{i}</td>"
            f"<td>{_esc(item.get('drug'))}</td>"
            f"<td>{_esc(item.get('dose'))}</td>"
            f"<td>{_esc(item.get('route') or 'oral')}</td>"
            f"<td>{_esc(item.get('frequency'))}</td>"
            f"<td>{_esc(item.get('duration'))}</td>"
            f"<td>{_esc(item.get('refills') or '0')}</td>"
            "</tr>"
        )

    html = _doctor_letterhead(doctor_profile, meta) + "<h1>&#8477; Prescription</h1>"
    if rows:
        html += (
            "<table><thead><tr><th>#</th><th>Drug</th><th>Dose</th><th>Route</th>"
            "<th>Frequency</th><th>Duration</th><th>Refills</th></tr></thead>"
            f"<tbody>{''.join(rows)}</tbody></table>"
        )
    if rx.get("warnings"):
        warn_items = "".join(f"<li>{_esc(w)}</li>" for w in rx["warnings"])
        html += f"<h3>Warnings</h3><ul>{warn_items}</ul>"
    if rx.get("advice"):
        html += f"<h3>Advice</h3><p>{_esc(rx['advice'])}</p>"
    html += signature_block(
        (doctor_profile or {}).get("name") or "",
        stamp="Digitally signed via HealthMate clinical suite" if rx.get("status") == "signed" else "DRAFT — unsigned",
    )
    return render_pdf_bytes(html)
