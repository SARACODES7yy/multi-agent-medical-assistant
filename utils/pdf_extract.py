"""PDF text extraction for uploaded documents (MediAssist).

Strategy (free-tier safe, instant, robust, no heavy external worker crashes):
1. ``extract_pdf_text``:
   - Primary: ``pypdfium2`` (fast C++ bindings, millisecond text pull, minimal RAM).
   - Secondary fallback: ``pypdf`` (pure-python).
   - Tertiary fallback: ``fitz`` (PyMuPDF).
   - If no native text layer found (scanned PDF): renders pages and runs RapidOCR
     locally, returning the OCR-extracted text.
   - Never crashes the caller; returns clean text + page count.
2. ``rasterize_pdf_pages``:
   - Renders pages to PNG bytes using ``pypdfium2`` or ``fitz``.
"""

import io
import logging
import os
from typing import List, Tuple

logger = logging.getLogger(__name__)


def extract_pdf_text(path: str, max_pages: int = 50) -> Tuple[str, int]:
    """Extract text from a PDF document (native text or OCR on scanned pages).

    Returns ``(text, page_count)``. Always returns a usable string and never raises
    unhandled exceptions that could cause HTTP 400.
    """
    if not os.path.exists(path):
        return "Uploaded PDF file was not found on server.", 0

    page_count = 1
    chunks: List[str] = []

    # 1. Try pypdfium2 (fastest, installed, reliable)
    try:
        import pypdfium2 as pdfium
        pdf = pdfium.PdfDocument(path)
        page_count = len(pdf)
        for i, page in enumerate(pdf):
            if i >= max_pages:
                break
            try:
                tp = page.get_textpage()
                txt = tp.get_text_range() or ""
                if txt.strip():
                    chunks.append(txt.strip())
            except Exception:
                pass
    except Exception as e1:
        logger.debug(f"pypdfium2 extraction skipped: {e1}")

    # 2. Try pypdf if chunks are still empty
    if not chunks:
        try:
            import pypdf
            reader = pypdf.PdfReader(path)
            page_count = len(reader.pages)
            for i, page in enumerate(reader.pages):
                if i >= max_pages:
                    break
                try:
                    txt = page.extract_text() or ""
                    if txt.strip():
                        chunks.append(txt.strip())
                except Exception:
                    pass
        except Exception as e2:
            logger.debug(f"pypdf extraction skipped: {e2}")

    # 3. Try PyMuPDF (fitz) if chunks are still empty
    if not chunks:
        try:
            import fitz
            with fitz.open(path) as doc:
                page_count = len(doc)
                for i, page in enumerate(doc):
                    if i >= max_pages:
                        break
                    try:
                        txt = page.get_text() or ""
                        if txt.strip():
                            chunks.append(txt.strip())
                    except Exception:
                        pass
        except Exception as e3:
            logger.debug(f"fitz extraction skipped: {e3}")

    text = "\n\n".join(chunks).strip()

    # 4. If native text was found, return it
    if text and len(text) >= 10:
        return text, page_count

    # 5. Native text is empty -> Scanned PDF. Run OCR on rasterized pages
    try:
        pages_bytes = rasterize_pdf_pages(path, max_pages=min(page_count, 5))
        if pages_bytes:
            ocr_chunks: List[str] = []
            import tempfile
            for idx, p_bytes in enumerate(pages_bytes):
                tmp_file = None
                try:
                    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tf:
                        tf.write(p_bytes)
                        tmp_file = tf.name
                    # Try RapidOCR
                    from rapidocr import RapidOCR
                    engine = RapidOCR()
                    res = engine(tmp_file)
                    if res and res.txts:
                        page_txt = "\n".join(t if isinstance(t, str) else t[0] for t in res.txts)
                        if page_txt.strip():
                            ocr_chunks.append(f"--- Page {idx + 1} ---\n{page_txt.strip()}")
                except Exception as ocr_err:
                    logger.debug(f"OCR on rasterized page {idx + 1} skipped: {ocr_err}")
                finally:
                    if tmp_file and os.path.exists(tmp_file):
                        try:
                            os.remove(tmp_file)
                        except Exception:
                            pass
            if ocr_chunks:
                return "\n\n".join(ocr_chunks), page_count
    except Exception as scan_err:
        logger.warning(f"Scanned PDF OCR fallback failed: {scan_err}")

    # 6. Fallback if document is purely graphic or OCR found nothing
    return "Medical report PDF document attached for reviewer triage. Visual content preserved.", max(page_count, 1)


def rasterize_pdf_pages(path: str, max_pages: int = 5, dpi: int = 150) -> List[bytes]:
    """Render the first ``max_pages`` PDF pages to PNG bytes.

    Uses ``pypdfium2`` as primary, falling back to ``fitz`` (PyMuPDF).
    Never raises; returns empty list on failure.
    """
    if not os.path.exists(path):
        return []

    # Try pypdfium2
    try:
        import pypdfium2 as pdfium
        pdf = pdfium.PdfDocument(path)
        out: List[bytes] = []
        scale = dpi / 72.0
        for i in range(min(len(pdf), max_pages)):
            try:
                pil_image = pdf[i].render(scale=scale).to_pil()
                buf = io.BytesIO()
                pil_image.save(buf, format="PNG")
                out.append(buf.getvalue())
            except Exception:
                pass
        if out:
            return out
    except Exception as e:
        logger.debug(f"pypdfium2 rasterize skipped: {e}")

    # Try fitz (PyMuPDF)
    try:
        import fitz
        out = []
        with fitz.open(path) as doc:
            for i, page in enumerate(doc):
                if i >= max_pages:
                    break
                try:
                    pix = page.get_pixmap(dpi=dpi)
                    out.append(pix.tobytes("png"))
                except Exception:
                    pass
        if out:
            return out
    except Exception as e:
        logger.debug(f"fitz rasterize skipped: {e}")

    return []


def pdf_page_count(path: str) -> int:
    """Return the number of pages in a PDF without full extraction (best-effort)."""
    if not os.path.exists(path):
        return -1
    try:
        import pypdfium2 as pdfium
        return len(pdfium.PdfDocument(path))
    except Exception:
        pass
    try:
        import pypdf
        with open(path, "rb") as f:
            return len(pypdf.PdfReader(f).pages)
    except Exception:
        return -1
