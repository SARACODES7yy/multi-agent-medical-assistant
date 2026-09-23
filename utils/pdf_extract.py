"""PDF text extraction for uploaded documents (MediAssist).

Strategy (free-tier safe, no torch/onnx in the web server):
1. ``extract_pdf_text`` — pure-python text pull via pypdf (covers native-text
   lab reports; tiny RAM, milliseconds).
2. Scanned/image-only PDFs have no text layer: callers fall back to
   ``rasterize_pdf_pages`` (PyMuPDF, also light) + the Gemini vision model.

docling is deliberately NOT used here: its onnxruntime pipeline has
OOM-killed 512MB containers, and the installed build needs torch.
"""

import logging
from typing import List, Tuple

logger = logging.getLogger(__name__)


def extract_pdf_text(path: str, max_pages: int = 50) -> Tuple[str, int]:
    """Extract embedded text from a PDF with pypdf (fast, tiny memory).

    Returns ``(text, page_count)``. Raises ``ValueError`` when the document
    has more pages than ``max_pages`` or contains no readable text layer
    (image-only scan — callers should rasterize + use vision instead).
    """
    try:
        import pypdf
        reader = pypdf.PdfReader(path)
        page_count = len(reader.pages)
    except Exception as e:
        raise ValueError(f"Could not read PDF: {e}")
    if page_count > max_pages:
        raise ValueError(
            f"PDF has {page_count} pages (max allowed: {max_pages}). "
            f"Please upload a document with at most {max_pages} pages."
        )
    chunks = []
    for page in reader.pages:
        try:
            chunks.append(page.extract_text() or "")
        except Exception:
            chunks.append("")
    text = "\n".join(chunks)
    if not text or len(text.strip()) < 1:
        raise ValueError("No readable text found in the uploaded PDF. It may be an image-only document.")
    return text.strip(), page_count


def rasterize_pdf_pages(path: str, max_pages: int = 5, dpi: int = 150) -> List[bytes]:
    """Render the first ``max_pages`` PDF pages to PNG bytes (for vision LLMs).

    PyMuPDF only — no onnx/torch, safe to run in the web process.
    Raises ``ValueError`` on failure.
    """
    try:
        import fitz  # PyMuPDF
        out = []
        with fitz.open(path) as doc:
            for i, page in enumerate(doc):
                if i >= max_pages:
                    break
                pix = page.get_pixmap(dpi=dpi)
                out.append(pix.tobytes("png"))
        if not out:
            raise ValueError("PDF has no renderable pages.")
        return out
    except ValueError:
        raise
    except Exception as e:
        raise ValueError(f"Could not rasterize PDF: {e}")


def pdf_page_count(path: str) -> int:
    """Return the number of pages in a PDF without full extraction (best-effort)."""
    try:
        import pypdf
        with open(path, "rb") as f:
            return len(pypdf.PdfReader(f).pages)
    except Exception:
        return -1
