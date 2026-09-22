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


def extract_pdf_text(path: str, max_pages: int = 50) -> Tuple[str, int]:
    """Extract text from a PDF using docling (handles native + scanned pages via OCR).

    Returns ``(text, page_count)``. Raises ``ValueError`` when the document has more
    pages than ``max_pages`` or no readable text could be extracted.
    """
    text = ""
    page_count = 0
    try:
        converter = _get_converter()
        result = converter.convert(path)
        doc = result.document
        page_count = len(doc.pages)
        if page_count > max_pages:
            raise ValueError(
                f"PDF has {page_count} pages (max allowed: {max_pages}). "
                f"Please upload a document with at most {max_pages} pages."
            )
        text = doc.export_to_markdown()
    except ValueError:
        raise
    except Exception as e:
        logger.warning(f"docling extraction failed ({e}); retrying with plain text pipeline")
        try:
            converter = _get_converter()
            # Fall back: default converter (no custom pipeline) for tricky PDFs.
            from docling.document_converter import DocumentConverter as DC
            plain = DC()
            result = plain.convert(path)
            doc = result.document
            page_count = len(doc.pages)
            if page_count > max_pages:
                raise ValueError(
                    f"PDF has {page_count} pages (max allowed: {max_pages}). "
                    f"Please upload a document with at most {max_pages} pages."
                )
            text = doc.export_to_markdown()
        except ValueError:
            raise
        except Exception as e2:
            raise ValueError(f"Could not extract text from PDF: {e2}")

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