"""PDF text extraction for uploaded documents (MediAssist)."""

import logging
from pathlib import Path
from typing import Tuple

logger = logging.getLogger(__name__)

_converter = None


def _get_converter():
    """Lazily build a lightweight docling converter (text + OCR only, no page images)."""
    global _converter
    if _converter is None:
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import (
            PdfPipelineOptions,
            TableFormerMode,
            RapidOcrOptions,
        )
        from docling.datamodel.object_detection_engine_options import (
            OnnxRuntimeObjectDetectionEngineOptions,
        )
        from docling.document_converter import DocumentConverter, PdfFormatOption

        pipeline_options = PdfPipelineOptions(
            generate_page_images=False,
            generate_picture_images=False,
            do_ocr=True,
            do_table_structure=True,
            do_formula_enrichment=False,
            do_picture_description=False,
        )
        try:
            pipeline_options.ocr_options = RapidOcrOptions()  # rapidocr ONNX (no torch)
        except Exception:
            pass
        try:
            pipeline_options.layout_options.engine_options = OnnxRuntimeObjectDetectionEngineOptions()
        except Exception:
            pass
        pipeline_options.table_structure_options.mode = TableFormerMode.FAST

        _converter = DocumentConverter(
            format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)}
        )
    return _converter


def _convert_pdf_inproc(path: str) -> Tuple[str, int]:
    """Run the docling converter in-process and return ``(markdown, page_count)``.

    Only ever called from the isolated worker process, never from the web
    server: docling/onnxruntime inference has killed small containers before.
    """
    try:
        converter = _get_converter()
        result = converter.convert(path)
        doc = result.document
        return doc.export_to_markdown(), len(doc.pages)
    except Exception as e:
        logger.warning(f"docling extraction failed ({e}); retrying with plain text pipeline")
        # Fall back: default converter (no custom pipeline) for tricky PDFs.
        from docling.document_converter import DocumentConverter as DC
        plain = DC()
        result = plain.convert(path)
        doc = result.document
        return doc.export_to_markdown(), len(doc.pages)


def extract_pdf_text(path: str, max_pages: int = 50) -> Tuple[str, int]:
    """Extract text from a PDF using docling (handles native + scanned pages via OCR).

    The heavy conversion runs in an isolated child process so an
    onnxruntime crash/OOM cannot take down the web server; a dead worker
    surfaces here as ``ValueError``. Returns ``(text, page_count)``.
    Raises ``ValueError`` when the document has more pages than
    ``max_pages`` or no readable text could be extracted.
    """
    import os as _os
    from utils.isolated_worker import run_isolated
    timeout = int(_os.getenv("PDF_TIMEOUT", "240"))
    try:
        res = run_isolated("pdf", [path], timeout=timeout)
    except Exception as e:
        raise ValueError(f"Could not extract text from PDF: {e}")
    if not res or res.get("error"):
        raise ValueError(f"Could not extract text from PDF: {(res or {}).get('error', 'worker failed')}")
    text, page_count = res.get("text", ""), res.get("pages", 0)
    if page_count > max_pages:
        raise ValueError(
            f"PDF has {page_count} pages (max allowed: {max_pages}). "
            f"Please upload a document with at most {max_pages} pages."
        )
    if not text or len(text.strip()) < 1:
        raise ValueError("No readable text found in the uploaded PDF. It may be an image-only document.")
    return text.strip(), page_count


def pdf_page_count(path: str) -> int:
    """Return the number of pages in a PDF without full OCR (best-effort)."""
    try:
        import fitz  # type: ignore
        with fitz.open(path) as f:
            return f.page_count
    except Exception:
        try:
            import pypdf
            with open(path, "rb") as f:
                return len(pypdf.PdfReader(f).pages)
        except Exception:
            return -1