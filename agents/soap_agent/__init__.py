from .soap_generator import SOAPGenerator


class SOAPAgent:
    """Agent that drafts structured SOAP notes for doctor review and sign-off."""

    def __init__(self, config):
        self.generator = SOAPGenerator(config)

    def generate(self, triage, chat_history=None, profile=None):
        return self.generator.generate(triage, chat_history, profile)

    def to_full_text(self, soap):
        return self.generator.to_full_text(soap)
