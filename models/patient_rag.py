import os
import uuid
import logging
from config import Config, DEFAULT_EMBEDDING_MODEL, get_embedding_model
from qdrant_client import QdrantClient, models
from qdrant_client.http.models import Distance, VectorParams

config = Config()
logger = logging.getLogger(__name__)


def _get_embedding_model():
    return get_embedding_model()


class PatientRAG:
    """Per-patient RAG over Qdrant (dense vectors + patient_id metadata filtering)."""

    def __init__(self):
        self.collection_name = "patient_medical_records"
        self.client = QdrantClient(path=config.rag.vector_local_path)
        self.embedding_model = _get_embedding_model()
        self.embedding_dim = config.rag.embedding_dim
        self._ensure_collection()

    def _ensure_collection(self):
        names = [c.name for c in self.client.get_collections().collections]
        if self.collection_name not in names:
            self.client.create_collection(
                collection_name=self.collection_name,
                vectors_config={"dense": VectorParams(size=self.embedding_dim, distance=Distance.COSINE)},
                sparse_vectors_config={"sparse": models.SparseVectorParams(index=models.SparseIndexParams(on_disk=False))},
            )
            logger.info(f"Created collection: {self.collection_name}")

    def _embed(self, text):
        return self.embedding_model.embed_query(text)

    def add_patient_data(self, patient_id, text, source=""):
        """Upsert a text chunk tagged with patient_id."""
        vector = self._embed(text)
        point_id = str(uuid.uuid4())
        self.client.upsert(
            collection_name=self.collection_name,
            points=[models.PointStruct(id=point_id, vector={"dense": vector},
                                       payload={"patient_id": patient_id, "source": source, "text": text})],
            wait=True,
        )
        logger.info(f"Added patient data for {patient_id} ({point_id})")

    def delete_patient_data(self, patient_id, source=None):
        """Delete all (or a source subset of) points for a patient."""
        filter_must = [models.FieldCondition(key="patient_id", match=models.MatchValue(value=patient_id))]
        if source:
            filter_must.append(models.FieldCondition(key="source", match=models.MatchValue(value=source)))
        self.client.delete(
            collection_name=self.collection_name,
            points_selector=models.FilterSelector(
                filter=models.Filter(must=filter_must)
            ),
            wait=True,
        )
        logger.info(f"Deleted patient data for {patient_id} (source={source or 'all'})")

    def add_profile_as_document(self, profile):
        """Turn a patient profile into a RAG document and upsert."""
        user_id = profile["user_id"]
        fields = []
        for key in ("name", "qualification", "dob", "medical_history", "allergies", "conditions", "treatments",
                    "gender", "blood_group", "height", "weight", "blood_pressure", "medications", "family_history",
                    "surgeries", "vaccination", "smoking", "alcohol", "exercise", "diet",
                    "emergency_name", "emergency_phone"):
            val = profile.get(key)
            if val:
                fields.append(f"{key}: {val}")
        text = "Patient profile:\n" + "\n".join(fields)
        self.add_patient_data(user_id, text, source="profile")

    def add_instruction(self, instruction_text, patient_id, source=""):
        """Add a doctor/nurse instruction to a patient's records."""
        text = f"Doctor instruction:\n{instruction_text}"
        self.add_patient_data(patient_id, text, source=source)

    def retrieve(self, patient_id, query, k=5):
        """Retrieve top-k chunks for a patient filtered by patient_id."""
        query_vector = self._embed(query)
        results = self.client.query_points(
            collection_name=self.collection_name,
            query=query_vector,
            using="dense",
            query_filter=models.Filter(
                must=[models.FieldCondition(key="patient_id", match=models.MatchValue(value=patient_id))]
            ),
            limit=k,
            with_payload=True,
        )
        return [{"content": r.payload.get("text", ""), "score": r.score, "source": r.payload.get("source", "")} for r in results.points]
