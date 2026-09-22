from .image_classifier import ImageClassifier

class ImageAnalysisAgent:
    """
    Agent responsible for analyzing uploaded medical images / documents.
    Uses local OCR (RapidOCR) + text LLM when possible, Gemini vision as fallback.
    """

    def __init__(self, config):
        self.image_classifier = ImageClassifier(
            vision_model=config.medical_cv.vision_llm,
            ocr_text_model=getattr(config.medical_cv, "ocr_llm", None),
        )

    # classify image
    def analyze_image(self, image_path: str) -> str:
        """Classifies images as medical or non-medical and determines their type."""
        return self.image_classifier.classify_image(image_path)

    # extract structured info from medical documents
    def analyze_medical_image(self, image_path: str, extra_context: str = "") -> str:
        """Extracts structured medical information from uploaded reports/documents."""
        return self.image_classifier.analyze_medical_image(image_path, extra_context)