import logging
from typing import List, Dict, Any

class QueryExpander:
    """
    Expands user queries with medical terminology to improve retrieval.
    """
    def __init__(self, config):
        self.logger = logging.getLogger(f"{self.__module__}")
        self.config = config
        self.model = config.rag.llm
        
    def expand_query(self, original_query: str) -> Dict[str, Any]:
        """
        Expand the original query with relevant medical terms.
        
        Short / highly-specific queries (e.g. a single symptom or a named test)
        are passed through unchanged — sending them through the LLM costs a full
        Groq call and tends to dilute an already-precise retrieval. We only pay
        for expansion when the query is genuinely broad or ambiguous.
        """
        self.logger.info(f"Expanding query: {original_query}")

        q = str(original_query or "").strip()
        tokens = [t for t in re.split(r"\s+", q) if t]
        is_short = len(q) <= 18 or len(tokens) <= 2

        if is_short:
            self.logger.info(f"   Query is short/specific (len={len(q)}, tokens={len(tokens)}) - passing through unchanged (saves a Groq call)")
            return {
                "original_query": original_query,
                "expanded_query": original_query
            }

        # Generate expansions - only for genuinely broad queries
        expanded_query = self._generate_expansions(original_query)
        
        return {
            "original_query": original_query,
            "expanded_query": expanded_query.content
        }
    
    def _generate_expansions(self, query: str) -> str:
        """Use LLM to expand query with medical terminology."""
        prompt = f"""
        As a medical expert, expand the following query with relevant medical terminology, 
        synonyms, and related concepts that would help in retrieving relevant medical information:
        
        User Query: {query}
        
        Expand the query only if you feel like it is required, otherwise keep the user query intact.
        Be specific to the medical or any other domain mentioned in the ueer query, do not add other medical domains.
        If the user query asks about answering in tabular format, include that in the expanded query and do not answer in tabular format yourself.
        Provide only the expanded query without explanations.
        """
        expansion = self.model.invoke(prompt)
        
        return expansion