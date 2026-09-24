import os
import logging
from pathlib import Path
from typing import Dict, List, Tuple, Any

logger = logging.getLogger(__name__)


class _FallbackDocument:
    """Drop-in stand-in for a docling document when docling is not installed.

    Only exposes ``export_to_markdown`` (the surface used by
    ``content_processor``), built from plain-text extraction.
    """

    def __init__(self, text: str):
        self._text = text

    def export_to_markdown(self, page_break_placeholder: str = "",
                           image_placeholder: str = "") -> str:
        return self._text


class MedicalDocParser:
    """
    Handles parsing of medical research documents.

    Primary path uses docling (page/figure/table extraction + OCR). docling is
    imported lazily so the app can boot and serve PDFs on boxes where docling
    is not installed (Render removed it to avoid ONNX OOM); those boxes fall
    back to fast plain-text extraction via pypdfium2/pypdf.
    """
    def __init__(self):
        self.logger = logging.getLogger(__name__)
        self.logger.info("Medical Document Parser initialized!")

    def _docling_available(self) -> bool:
        try:
            import docling  # noqa: F401
            return True
        except Exception:
            return False

    def _page_image(self, page, document):
        """
        Extract a PIL image for a page, handling API differences across docling versions.
        """
        try:
            image = page.image
            if image is None:
                return None
            if hasattr(image, "pil_image"):
                return image.pil_image
            if hasattr(image, "pil"):
                return image.pil
        except Exception:
            pass
        # Fallback: use the get_image API if available
        try:
            return page.get_image(document)
        except Exception as e:
            self.logger.warning(f"Could not extract page image: {e}")
            return None

    def _parse_with_text_fallback(self, document_path: str) -> Tuple[Any, List[str]]:
        """Lightweight extraction when docling is unavailable: returns (doc, [])."""
        pages: List[str] = []
        try:
            import pypdfium2 as pdfium
            pdf = pdfium.PdfDocument(document_path)
            for page in pdf:
                tp = page.get_textpage()
                pages.append(tp.get_text_range())
        except Exception as e:
            self.logger.warning(f"pypdfium2 extraction failed ({e}); trying pypdf")
            try:
                import pypdf
                with open(document_path, "rb") as f:
                    reader = pypdf.PdfReader(f)
                    for page in reader.pages:
                        pages.append(page.extract_text() or "")
            except Exception as e2:
                raise ValueError(f"Could not extract text from PDF: {e2}")
        text = "\n\n".join(p for p in pages if p and p.strip())
        self.logger.info("Using plain-text PDF fallback (docling not installed)")
        return _FallbackDocument(text), []

    def _parse_with_docling(self, document_path: str, output_dir: str,
                            image_resolution_scale: float, do_ocr: bool,
                            do_tables: bool, do_formulas: bool,
                            do_picture_desc: bool) -> Tuple[Any, List[str]]:
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import (
            PdfPipelineOptions,
            TableFormerMode,
            RapidOcrOptions,
            smolvlm_picture_description,
        )
        from docling.datamodel.object_detection_engine_options import OnnxRuntimeObjectDetectionEngineOptions
        from docling.document_converter import DocumentConverter, PdfFormatOption
        from docling_core.types.doc import PictureItem, TableItem

        # Create output directory if it doesn't exist
        output_dir_path = Path(output_dir)
        output_dir_path.mkdir(parents=True, exist_ok=True)

        # Configure pipeline options
        pipeline_options = PdfPipelineOptions(
            generate_page_images=True,
            generate_picture_images=True,
            images_scale=image_resolution_scale,
            do_ocr=do_ocr,
            do_table_structure=do_tables,
            do_formula_enrichment=do_formulas,
            do_picture_description=do_picture_desc
        )
        try:
            pipeline_options.ocr_options = RapidOcrOptions()
        except Exception:
            pass
        try:
            # Force ONNX runtime layout model (torch-free).
            pipeline_options.layout_options.engine_options = OnnxRuntimeObjectDetectionEngineOptions()
        except Exception:
            pass
        try:
            pipeline_options.table_structure_options.mode = TableFormerMode.ACCURATE
        except Exception:
            pass

        converter = DocumentConverter(
            format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)}
        )

        # Convert document
        conversion_res = converter.convert(document_path)
        doc_filename = conversion_res.input.file.stem

        # Save page images
        for page_no, page in conversion_res.document.pages.items():
            try:
                page_image = self._page_image(page, conversion_res.document)
                if page_image is not None:
                    page_image_filename = output_dir_path / f"{doc_filename}-{page_no}.png"
                    with page_image_filename.open("wb") as fp:
                        page_image.save(fp, format="PNG")
            except Exception as e:
                self.logger.warning(f"Could not save page image {page_no}: {e}")

        # Save images of figures and tables
        table_counter = 0
        picture_counter = 0
        image_paths = []

        for element, _level in conversion_res.document.iterate_items():
            if isinstance(element, TableItem):
                try:
                    table_counter += 1
                    element_image_filename = output_dir_path / f"{doc_filename}-table-{table_counter}.png"
                    image = element.get_image(conversion_res.document)
                    if image is not None:
                        with element_image_filename.open("wb") as fp:
                            image.save(fp, "PNG")
                except Exception as e:
                    self.logger.warning(f"Could not save table image: {e}")

            if isinstance(element, PictureItem):
                try:
                    picture_path = f"{doc_filename}-picture-{picture_counter}.png"
                    element_image_filename = output_dir_path / picture_path
                    image = element.get_image(conversion_res.document)
                    if image is not None:
                        with element_image_filename.open("wb") as fp:
                            image.save(fp, "PNG")
                        image_paths.append(str(element_image_filename))
                    picture_counter += 1
                except Exception as e:
                    self.logger.warning(f"Could not save picture {picture_counter}: {e}")
                    picture_counter += 1

        # Extract images for summarization
        images = []
        for picture in conversion_res.document.pictures:
            ref = picture.get_ref().cref
            image = picture.image
            if image:
                images.append(str(image.uri))

        return conversion_res.document, images

    def parse_document(
            self,
            document_path: str,
            output_dir: str,
            image_resolution_scale: float = 2.0,
            do_ocr: bool = True,
            do_tables: bool = True,
            do_formulas: bool = False,
            do_picture_desc: bool = False
            ) -> Tuple[Any, List[str]]:
        """
        Parse the document and extract structured content and images.

        Args:
            document_path: Path to the document to parse
            output_dir: Directory to save extracted images
            image_resolution_scale: Resolution scale for extracted images
            do_ocr: Enable OCR processing
            do_tables: Enable table structure extraction
            do_formulas: Enable formula enrichment
            do_picture_desc: Enable picture description generation

        Returns:
            Tuple containing (parsed_document, list_of_image_paths)
        """
        if self._docling_available():
            try:
                return self._parse_with_docling(
                    document_path, output_dir, image_resolution_scale,
                    do_ocr, do_tables, do_formulas, do_picture_desc,
                )
            except Exception as e:
                self.logger.warning(f"docling extraction failed ({e}); using text fallback")
        return self._parse_with_text_fallback(document_path)