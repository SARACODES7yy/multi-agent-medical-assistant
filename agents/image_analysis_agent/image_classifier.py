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
        """Run RapidOCR (memoized) and return the extracted text joined by newlines."""
        if image_path in self._ocr_cache:
            return self._ocr_cache[image_path]

        text = ""
        try:
            engine = _get_ocr()
            result = engine(image_path)
            if result is not None and result.txts:
                texts = [t if isinstance(t, str) else t[0] for t in result.txts]
                text = "\n".join(texts)
        except Exception as e:
            print(f"[ImageAnalyzer] OCR failed: {e}")

        self._ocr_cache[image_path] = text
        return text

    # ------------------------------------------------------------------
    # Classification (used by the routing graph)
    # ------------------------------------------------------------------
    def classify_image(self, image_path: str) -> str:
        """Classify the image as medical/non-medical and determine its type."""
        print(f"[ImageAnalyzer] Classifying image: {image_path}")

        ocr_text = self._ocr_image(image_path)

        if self.ocr_text_model is not None and len(ocr_text.strip()) >= 15:
            print(f"[ImageAnalyzer] Classifying via OCR text ({len(ocr_text.strip())} chars)")
            return self._classify_from_text(ocr_text)

        print("[ImageAnalyzer] OCR text insufficient -> vision classification")
        return self._classify_from_vision(image_path)

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

        RapidOCR runs locally; the LLM receives only the extracted text
        (never the image), so even non-vision models work for the analysis.
        Returns a structured triage note as JSON text.
        """
        print(f"[ImageAnalyzer] Extracting medical information from: {image_path}")

        ocr_text = self._ocr_image(image_path)
        print(f"[ImageAnalyzer] OCR extracted {len(ocr_text.strip())} chars -> using text model")
        return self._extract_from_ocr_text(ocr_text, extra_context)

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