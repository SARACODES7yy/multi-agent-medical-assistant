import os
import re
import json
import base64
from mimetypes import guess_type

from typing import TypedDict
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.output_parsers import JsonOutputParser

_ocr_engine = None


def _get_ocr():
    """Lazily initialize the RapidOCR engine (first call downloads/loads models)."""
    global _ocr_engine
    if _ocr_engine is None:
        from rapidocr import RapidOCR
        _ocr_engine = RapidOCR()
    return _ocr_engine


def _has_vision_key():
    """True when a Google/Gemini key is configured (real vision model available)."""
    return bool(os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY"))


class ClassificationDecision(TypedDict):
    """Output structure for the decision agent."""
    image_type: str
    reasoning: str
    confidence: float


class ImageClassifier:
    """
    Analyzes uploaded images. For documents/text-bearing images it runs RapidOCR locally,
    then uses a cheap text-only model to classify AND extract structured info (no vision quota).
    For images with no extractable text (X-rays, photos, etc.) it falls back to Gemini vision.
    """

    def __init__(self, vision_model, ocr_text_model=None):
        self.vision_model = vision_model
        self.ocr_text_model = ocr_text_model
        self.json_parser = JsonOutputParser(pydantic_object=ClassificationDecision)
        self._ocr_cache = {}

    def local_image_to_data_url(self, image_path: str) -> str:
        """
        Get the url of a local image
        """
        mime_type, _ = guess_type(image_path)

        if mime_type is None:
            mime_type = "application/octet-stream"

        with open(image_path, "rb") as image_file:
            base64_encoded_data = base64.b64encode(image_file.read()).decode("utf-8")

        return f"data:{mime_type};base64,{base64_encoded_data}"

    def _ocr_image(self, image_path: str) -> str:
        """Run RapidOCR to extract text from a lab report / document.

        Attempts isolated child process first; falls back immediately to
        in-process RapidOCR if worker returns None. Memoizes results.
        """
        if image_path in self._ocr_cache:
            return self._ocr_cache[image_path]

        text = ""
        # 1. Try isolated worker with short timeout
        try:
            import os as _os
            from utils.isolated_worker import run_isolated
            timeout = int(_os.getenv("OCR_TIMEOUT", "20"))
            res = run_isolated("ocr", [image_path], timeout=timeout)
            if res and res.get("texts"):
                text = "\n".join(res.get("texts", []) or []).strip()
        except Exception as e:
            print(f"[ImageAnalyzer] Isolated OCR worker skipped: {e}")

        # 2. In-process RapidOCR fallback if worker returned empty
        if not text:
            try:
                from rapidocr import RapidOCR
                engine = RapidOCR()
                res = engine(image_path)
                txts = (res.txts if res is not None else None) or []
                text = "\n".join(t if isinstance(t, str) else t[0] for t in txts).strip()
            except Exception as direct_err:
                print(f"[ImageAnalyzer] Direct RapidOCR fallback skipped: {direct_err}")

        self._ocr_cache[image_path] = text
        return text

    # ------------------------------------------------------------------
    # Classification (used by the routing graph)
    # ------------------------------------------------------------------
    def classify_image(self, image_path: str) -> str:
        """Classify the image as medical/non-medical and determine its type."""
        print(f"[ImageAnalyzer] Classifying image: {image_path}")

        # Try fast OCR first
        ocr_text = self._ocr_image(image_path)
        if self.ocr_text_model is not None and len(ocr_text.strip()) >= 15:
            print(f"[ImageAnalyzer] Classifying via OCR text ({len(ocr_text.strip())} chars)")
            try:
                return self._classify_from_text(ocr_text)
            except Exception as ce:
                print(f"[ImageAnalyzer] OCR text classification failed: {ce}")

        # If no readable text or classification failed, use vision model if available
        if _has_vision_key():
            try:
                print("[ImageAnalyzer] Classifying via vision model")
                return self._classify_from_vision(image_path)
            except Exception as e:
                print(f"[ImageAnalyzer] Vision classification failed: {e}")

        return {"image_type": "MEDICAL REPORT", "reasoning": "Document uploaded for medical triage", "confidence": 0.85}


    def _classify_from_text(self, ocr_text: str) -> str:
        """Classify a document from its OCR-extracted text using the cheap text model."""
        system_prompt = SystemMessage(content="You are an expert in medical document triage.")
        user_prompt = HumanMessage(content=(
            "The following text was extracted from an uploaded image via OCR:\n\n"
            f"--- BEGIN OCR TEXT ---\n{ocr_text}\n--- END OCR TEXT ---\n\n"
            "Determine if this is a medical image/document. If it is, classify it as: "
            "'MEDICAL REPORT', 'PRESCRIPTION', 'LAB REPORT', 'CHEST X-RAY', 'SKIN PHOTO', 'OTHER MEDICAL IMAGE'. "
            "If it's not a medical image, return 'NON-MEDICAL'.\n"
            "Answer in JSON only:\n"
            "{{\n"
            '  "image_type": "IMAGE TYPE",\n'
            '  "reasoning": "brief reasoning",\n'
            '  "confidence": 0.9\n'
            "}}"
        ))

        response = self.ocr_text_model.invoke([system_prompt, user_prompt])
        try:
            return self.json_parser.parse(response.content)
        except json.JSONDecodeError:
            print("[ImageAnalyzer] Warning: Response was not valid JSON.")
            return {"image_type": "unknown", "reasoning": "Invalid JSON response", "confidence": 0.0}

    def _classify_from_vision(self, image_path: str) -> str:
        """Original vision-based classification (fallback for non-text images)."""
        system_prompt = SystemMessage(content="You are an expert in medical imaging. Analyze the uploaded image.")
        user_prompt = HumanMessage(content=[
            {"type": "text", "text": (
                """
                Determine if this is a medical image. If it is, classify it as:
                'MEDICAL REPORT', 'PRESCRIPTION', 'LAB REPORT', 'CHEST X-RAY', 'SKIN PHOTO', 'OTHER MEDICAL IMAGE'. If it's not a medical image, return 'NON-MEDICAL'.
                You must provide your answer in JSON format with the following structure:
                {{
                "image_type": "IMAGE TYPE",
                "reasoning": "Your step-by-step reasoning for selecting this agent",
                "confidence": 0.95  // Value between 0.0 and 1.0 indicating your confidence in this classification task
                }}
                """
            )},
            {"type": "image_url", "image_url": {"url": self.local_image_to_data_url(image_path)}}
        ])

        response = self.vision_model.invoke([system_prompt, user_prompt])

        try:
            return self.json_parser.parse(response.content)
        except json.JSONDecodeError:
            print("[ImageAnalyzer] Warning: Response was not valid JSON.")
            return {"image_type": "unknown", "reasoning": "Invalid JSON response", "confidence": 0.0}

    # ------------------------------------------------------------------
    # Structured extraction
    # ------------------------------------------------------------------
    def analyze_medical_image(self, image_path: str, extra_context: str = "") -> str:
        """
        Extract structured medical information from an uploaded image.

        RapidOCR extracts text locally; Groq text model parses structured values.
        Lightning-fast, highly accurate for lab reports, prescriptions, and summaries.
        Falls back to vision model only for visual images without text.
        """
        print(f"[ImageAnalyzer] Extracting medical information from: {image_path}")

        ocr_text = self._ocr_image(image_path)
        print(f"[ImageAnalyzer] OCR extracted {len(ocr_text.strip())} chars")

        if len(ocr_text.strip()) >= 20 and self.ocr_text_model is not None:
            try:
                return self._extract_from_ocr_text(ocr_text, extra_context)
            except Exception as ocr_parse_err:
                print(f"[ImageAnalyzer] Groq OCR parsing failed: {ocr_parse_err}")

        # If image has minimal/no text (e.g. skin photo, X-ray) or OCR parse failed, try vision
        if _has_vision_key():
            try:
                print("[ImageAnalyzer] Running vision model extraction")
                return self._extract_from_vision(image_path, extra_context)
            except Exception as e:
                print(f"[ImageAnalyzer] Vision extraction failed: {e}")

        # Final resilient fallback if both OCR and vision fail
        if len(ocr_text.strip()) > 0:
            return (
                '```json\n{\n  "document_type": "Medical Document",\n  "date": null,\n  "patient_details": null,\n'
                f'  "key_values": [],\n  "abnormal_flags": [],\n  "summary": "Medical report text extracted via OCR.",\n'
                '  "missing_information": []\n}\n```\n\n'
                f"### Extracted OCR Text\n\n{ocr_text.strip()}"
            )
        return (
            '```json\n{\n  "document_type": "Medical Image",\n  "date": null,\n  "patient_details": null,\n'
            '  "key_values": [],\n  "abnormal_flags": [],\n  "summary": "Medical image attached for reviewer triage.",\n'
            '  "missing_information": []\n}\n```'
        )

    def _extract_from_ocr_text(self, ocr_text: str, extra_context: str = "") -> str:
        """Use the text-only model on OCR output to produce structured JSON plus a clinical insight in ONE call."""
        system_prompt = SystemMessage(
            content=(
                "You are a medical information extraction assistant for a non-diagnostic healthcare "
                "triage system. You organize and summarize text extracted from medical documents via OCR. "
                "You never diagnose, prescribe treatment, or replace a qualified professional. "
                "After the structured JSON block, optionally add a short '## Clinical Insight (AI-generated)' "
                "plain-language interpretation of the findings."
            )
        )
        user_prompt = HumanMessage(content=(
            "The following text was extracted from a medical document image via OCR:\n\n"
            f"--- BEGIN OCR TEXT ---\n{ocr_text}\n--- END OCR TEXT ---\n\n"
            "Extract the following structured information. Return your answer in JSON format:\n"
            "{\n"
            '  "document_type": "type of document (e.g. lab report, prescription, letter)",\n'
            '  "date": "document date if visible, else null",\n'
            '  "patient_details": "visible patient details (anonymized - no full names/IDs), else null",\n'
            '  "key_values": ["list of key medical measurements, results, medications, or findings with their values"],\n'
            '  "abnormal_flags": ["list of any values flagged abnormal or outside reference range, if clearly indicated"],\n'
            '  "summary": "2-3 sentence plain summary of the document content",\n'
            '  "missing_information": ["any important information that is absent, e.g. units, dates, reference ranges"]\n'
            "}\n"
            "If the OCR text does not appear to be a medical document, set document_type to 'NONE' and "
            "summary to 'No recognizable medical document found in the uploaded image.'\n"
            "If document_type is NONE or NON-MEDICAL, stop after the JSON and do NOT add a clinical insight section.\n"
            "Otherwise, after the closing JSON fence, add a short '## Clinical Insight (AI-generated)' section "
            "(about 200-300 words) interpreting the findings: what the report shows, anything notable, "
            "and what to review with a doctor. Keep it factual, neutral, and non-alarming.\n"
            f"Additional context from the user: {extra_context if extra_context else 'None'}"
        ))

        response = self.ocr_text_model.invoke([system_prompt, user_prompt])
        return response.content

    def _extract_from_vision(self, image_path: str, extra_context: str = "") -> str:
        """Original Gemini vision extraction, used as fallback for non-text images.
        Returns structured JSON plus an optional clinical insight in one call."""
        system_prompt = SystemMessage(
            content=(
                "You are a medical information extraction assistant for a non-diagnostic healthcare "
                "triage system. You organize and summarize the information visible in uploaded medical "
                "reports, prescriptions, lab reports, and health documents. You never diagnose, prescribe "
                "treatment, or replace a qualified professional. After the structured JSON block, "
                "optionally add a short '## Clinical Insight (AI-generated)' plain-language interpretation."
            )
        )
        user_prompt = HumanMessage(content=[
            {"type": "text", "text": (
                "Extract the following structured information from this medical document image. "
                "Return your answer in JSON format:\n"
                "{\n"
                '  "document_type": "type of document (e.g. lab report, prescription, letter)",\n'
                '  "date": "document date if visible, else null",\n'
                '  "patient_details": "visible patient details (anonymized - no full names/IDs), else null",\n'
                '  "key_values": ["list of key medical measurements, results, medications, or findings with their values"],\n'
                '  "abnormal_flags": ["list of any values flagged abnormal or outside reference range, if clearly indicated"],\n'
                '  "summary": "2-3 sentence plain summary of the document content",\n'
                '  "missing_information": ["any important information that is absent, e.g. units, dates, reference ranges"]\n'
                "}\n"
                "If the image does not contain a medical document, set document_type to 'NONE' and "
                "summary to 'No recognizable medical document found in the uploaded image.'\n"
                "If document_type is NONE or NON-MEDICAL, stop after the JSON and do NOT add a clinical insight section.\n"
                "Otherwise, after the closing JSON fence, add a short '## Clinical Insight (AI-generated)' section "
                "(about 200-300 words) interpreting the findings: what the report shows, anything notable, "
                "and what to review with a doctor. Keep it factual, neutral, and non-alarming.\n"
                f"Additional context from the user: {extra_context if extra_context else 'None'}"
            )},
            {"type": "image_url", "image_url": {"url": self.local_image_to_data_url(image_path)}}
        ])

        response = self.vision_model.invoke([system_prompt, user_prompt])
        return response.content

    def describe_page_images(self, pages, extra_context=""):
        """Describe scanned-PDF pages (PNG bytes) via the vision model.

        One vision call per page; results joined with page headers. Returns ""
        on any failure (callers fall back to a clean error message).
        """
        if not pages:
            return ""
        system_prompt = SystemMessage(
            content=(
                "You are a medical information extraction assistant for a non-diagnostic healthcare "
                "triage system. You organize and summarize text visible in medical document pages. "
                "You never diagnose, prescribe treatment, or replace a qualified professional."
            )
        )
        out = []
        try:
            import base64
            for i, png in enumerate(pages):
                data_url = "data:image/png;base64," + base64.b64encode(png).decode()
                user_prompt = HumanMessage(content=[
                    {"type": "text", "text": (
                        f"This is page {i + 1} of an uploaded medical document. "
                        "Transcribe the visible medical content (test names, values, dates, findings) "
                        "as structured text. If the page is not a medical document, say so briefly.\n"
                        f"Additional context from the user: {extra_context if extra_context else 'None'}"
                    )},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ])
                out.append(f"--- Page {i + 1} ---\n" + str(self.vision_model.invoke([system_prompt, user_prompt]).content))
        except Exception as e:
            print(f"[ImageAnalyzer] Page-vision description failed: {e}")
            return ""
        return "\n\n".join(out)

    # ------------------------------------------------------------------
    # Insight generation
    # ------------------------------------------------------------------
    def _append_insight(self, extraction_json: str, extra_context: str = "") -> str:
        """
        Combine the structured extraction JSON with an AI-generated clinical insight.
        The insight is produced from the extracted JSON, giving the user a plain-language
        interpretation of what the report conveys.
        """
        cleaned = extraction_json.strip()
        if cleaned.startswith("```"):
            cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.I).rstrip("`").strip()

        doc_type = ""
        try:
            structured = json.loads(cleaned)
            if isinstance(structured, dict):
                doc_type = str(structured.get("document_type", "") or "").upper()
        except json.JSONDecodeError:
            structured = None

        footer = ("\n\n---\n\n*This output is for informational purposes only and is not a diagnosis. "
                  "Please share this report with a qualified healthcare professional to confirm any findings.*")

        insight = self._generate_insight(cleaned, extra_context)

        if doc_type in ("NONE", "NON-MEDICAL"):
            return ("```json\n" + cleaned + "\n```\n\n---\n\n"
                    "**Clinical Insight:** The uploaded image does not appear to contain a medical report, "
                    "so no medical insight can be derived." + footer)

        return (
            "```json\n" + cleaned + "\n```\n\n---\n\n"
            "## Clinical Insight (AI-generated)\n\n"
            + insight.strip() + footer
        )

    def _generate_insight(self, structured_json: str, extra_context: str = "") -> str:
        """Feed the extracted JSON to the text LLM and return a plain-language clinical insight."""
        system_prompt = SystemMessage(
            content=(
                "You are a careful clinical interpreter for a non-diagnostic healthcare triage system. "
                "Given a structured JSON extracted from an uploaded medical report image, you produce a "
                "clear, plain-language insight about what the report conveys. You never diagnose, never "
                "prescribe treatment, and always recommend that a qualified healthcare professional "
                "confirm any findings."
            )
        )
        user_prompt = HumanMessage(content=(
            "Here is the structured information extracted from an uploaded medical document:\n\n"
            f"--- BEGIN STRUCTURED REPORT ---\n{structured_json}\n--- END STRUCTURED REPORT ---\n\n"
            f"Additional context from the user: {extra_context if extra_context else 'None'}\n\n"
            "Write a short, human-readable insight (about 200-300 words) with these sections:\n"
            "- **What the report shows**: plain-language summary of the document and its main findings.\n"
            "- **Notable findings**: cautiously call out anything in 'abnormal_flags' or 'key_values' "
            "that appears abnormal or potentially concerning; note that values need clinical "
            "confirmation and professional interpretation.\n"
            "- **What to review with a doctor**: observations to discuss, what to bring to a "
            "consultation, and anything important that is missing (per 'missing_information').\n"
            "Keep it factual, neutral, and non-alarming. If the JSON indicates this is not a medical "
            "document or contains no findings, say so instead of inventing insights. "
            "Reply in plain markdown without extra preamble."
        ))

        response = self.ocr_text_model.invoke([system_prompt, user_prompt])
        return response.content