from .prescription_generator import PrescriptionGenerator


class PrescriptionAgent:
    """Agent that formats a doctor's prescribing intent into a structured,
    reviewable prescription with safety warnings."""

    def __init__(self, config):
        self.generator = PrescriptionGenerator(config)

    def generate(self, intent_text, profile=None, triage=None):
        return self.generator.generate(intent_text, profile, triage)
