"""
Configuration file for the Multi-Agent Medical Chatbot

LLM and Embedding models use Google Gemini via the langchain-google-genai package.
Set the GOOGLE_API_KEY environment variable (in .env) to authenticate.

Each llm definition has a unique temperature value relevant to the specific class.
All LLM calls retry on Gemini rate-limit errors, honoring the server retry_delay.
"""

import os
import time
import re
from dotenv import load_dotenv

try:
    from langchain_groq import ChatGroq
    _GROQ_AVAILABLE = True
except Exception:
    _GROQ_AVAILABLE = False

try:
    from langchain_openai import ChatOpenAI
    _OPENROUTER_AVAILABLE = True
except Exception:
    _OPENROUTER_AVAILABLE = False

load_dotenv()

DEFAULT_LLM_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.6-flash")
DEFAULT_EMBEDDING_MODEL = os.getenv("GEMINI_EMBEDDING_MODEL", "gemini-embedding-001")

GROQ_API_KEY = os.getenv("GROQ_API_KEY")
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
GROQ_MAX_TOKENS = int(os.getenv("GROQ_MAX_TOKENS", "8192"))

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
OPENROUTER_BASE_URL = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
OPENROUTER_MODEL = os.getenv("OPENROUTER_MODEL", "openrouter/auto")
OPENROUTER_MAX_TOKENS = int(os.getenv("OPENROUTER_MAX_TOKENS", "8192"))

# Cloudflare Workers AI
CLOUDFLARE_ACCOUNT_ID = os.getenv("CLOUDFLARE_ACCOUNT_ID")
CLOUDFLARE_API_TOKEN = os.getenv("CLOUDFLARE_API_TOKEN")
CLOUDFLARE_AI_MODEL = os.getenv("CLOUDFLARE_AI_MODEL", "@cf/meta/llama-4-scout-17b-16e-instruct")
CLOUDFLARE_BASE_URL = (
    f"https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1"
    if CLOUDFLARE_ACCOUNT_ID else ""
)

_GROQ_VERIFIED = None


class LocalHashEmbeddings:
    """Deterministic, offline token-hash embeddings (no API key required).

    Implements the subset of the langchain Embeddings interface used by the
    project (embed_query / embed_documents) so the app can start without a
    Google credential. Suitable for keeping the pipeline functional when no
    cloud embedding key is configured.
    """

    def __init__(self, dim=3072):
        self.dim = dim
        self._seed = 0x9E3779B97F4A7C15

    def _tokenize(self, text):
        words = [w.lower() for w in re.findall(r"[A-Za-z0-9']+", text or "")]
        tokens = []
        for w in words:
            for n in (1, 2):
                if len(w) >= n:
                    grams = [w[i:i + n] for i in range(len(w) - n + 1)]
                    tokens.extend(grams)
        return tokens

    def _hash(self, token):
        h = self._seed
        for ch in token.encode("utf-8"):
            h = ((h ^ ch) * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
        return h

    def _vector(self, text):
        vec = [0.0] * self.dim
        for token in self._tokenize(text):
            h = self._hash(token)
            idx = int(h) % self.dim
            sign = 1.0 if h & 1 else -1.0
            vec[idx] += sign
        norm = (sum(v * v for v in vec) ** 0.5) or 1.0
        return [v / norm for v in vec]

    def embed_query(self, text):
        return self._vector(text)

    def embed_documents(self, texts):
        return [self._vector(t) for t in texts]


def get_embedding_model():
    """Gemini embeddings when a Google credential exists, else offline fallback."""
    if os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY"):
        from langchain_google_genai import GoogleGenerativeAIEmbeddings
        return GoogleGenerativeAIEmbeddings(model=DEFAULT_EMBEDDING_MODEL)
    return LocalHashEmbeddings(dim=3072)


def gemini_llm(temperature=0.1, **kw):
    from langchain_google_genai import ChatGoogleGenerativeAI
    inner = ChatGoogleGenerativeAI(model=DEFAULT_LLM_MODEL, temperature=temperature, transport="rest", **kw)
    return inner.with_retry(retry_if_exception_type=(Exception,), stop_after_attempt=2)


def groq_llm(temperature=0.1, **kw):
    inner = ChatGroq(model=GROQ_MODEL, temperature=temperature, max_tokens=GROQ_MAX_TOKENS, **kw)
    # Retry once on transient failures (including HTTP 429) so a single
    # burst does not surface to the browser and cause it to re-fire.
    # Configured via .with_retry to stay a proper langchain Runnable.
    return inner.with_retry(retry_if_exception_type=(Exception,), stop_after_attempt=2)


def openrouter_llm(temperature=0.1, **kw):
    """Primary triage/OCR LLM via OpenRouter (OpenAI-compatible endpoint).

    Uses the ChatOpenAI client with a custom base_url so it talks to
    OpenRouter's API instead of OpenAI. Lets any OpenRouter-served model be
    used for the medical-image OCR/triage agent.
    """
    inner = ChatOpenAI(
        model=OPENROUTER_MODEL,
        base_url=OPENROUTER_BASE_URL,
        api_key=OPENROUTER_API_KEY,
        temperature=temperature,
        max_tokens=OPENROUTER_MAX_TOKENS,
        **kw,
    )
    return inner.with_retry(retry_if_exception_type=(Exception,), stop_after_attempt=2)


def cloudflare_llm(temperature=0.1, **kw):
    """LLM via Cloudflare Workers AI (OpenAI-compatible)."""
    if not CLOUDFLARE_API_TOKEN or not CLOUDFLARE_ACCOUNT_ID:
        raise ValueError("Cloudflare Workers AI credentials missing (CLOUDFLARE_API_TOKEN/ACCOUNT_ID)")
    from langchain_openai import ChatOpenAI

    inner = ChatOpenAI(
        model=CLOUDFLARE_AI_MODEL,
        temperature=temperature,
        max_tokens=int(os.getenv("CLOUDFLARE_MAX_TOKENS", "8192")),
        api_key=CLOUDFLARE_API_TOKEN,
        base_url=CLOUDFLARE_BASE_URL,
        **kw,
    )
    return inner.with_retry(retry_if_exception_type=(Exception,), stop_after_attempt=2)


# ----------------------------------------------------------------------
# Runtime multi-provider fallback chain
# ----------------------------------------------------------------------
from typing import Any, List, Optional  # noqa: E402

from langchain_core.callbacks import CallbackManagerForLLMRun  # noqa: E402
from langchain_core.language_models.chat_models import BaseChatModel  # noqa: E402
from langchain_core.messages import AIMessage, BaseMessage  # noqa: E402
from langchain_core.outputs import ChatGeneration, ChatResult  # noqa: E402
from pydantic import Field  # noqa: E402


class FallbackChatModel(BaseChatModel):
    """Chat model that tries each underlying provider in order until one succeeds.

    Used so a Groq outage/rate-limit transparently fails over to OpenRouter,
    then Cloudflare, then Gemini (order configurable via env), instead of
    surfacing an error to the user.
    """

    models: List[Any] = Field(default_factory=list)
    provider_names: List[str] = Field(default_factory=list)

    @property
    def _llm_type(self) -> str:
        return "fallback"

    def _generate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[CallbackManagerForLLMRun] = None,
        **kwargs: Any,
    ) -> ChatResult:
        last_err: Optional[Exception] = None
        for name, model in zip(self.provider_names, self.models):
            try:
                out = model.invoke(messages, stop=stop) if stop else model.invoke(messages)
                if not isinstance(out, AIMessage):
                    out = AIMessage(content=str(getattr(out, "content", out)))
                return ChatResult(generations=[ChatGeneration(message=out)])
            except Exception as e:  # provider failed -> try the next one
                last_err = e
                print(f"[FallbackLLM] {name} failed -> next provider: {e}")
        raise RuntimeError(
            f"All LLM providers failed ({' -> '.join(self.provider_names)}): {last_err}"
        )


def _provider_registry():
    """name -> (availability_check, factory(temperature, **kw) -> chat model)."""
    return {
        "groq": (
            lambda: _GROQ_AVAILABLE and bool(GROQ_API_KEY),
            lambda temperature=0.1, **kw: groq_llm(temperature=temperature, **kw),
        ),
        "openrouter": (
            lambda: _OPENROUTER_AVAILABLE and bool(OPENROUTER_API_KEY),
            lambda temperature=0.1, **kw: openrouter_llm(temperature=temperature, **kw),
        ),
        "cloudflare": (
            lambda: bool(CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID),
            lambda temperature=0.1, **kw: cloudflare_llm(temperature=temperature, **kw),
        ),
        "gemini": (
            lambda: bool(os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")),
            lambda temperature=0.1, **kw: gemini_llm(temperature=temperature, **kw),
        ),
    }


def _text_chain_order():
    raw = os.getenv("TEXT_FALLBACK_PROVIDERS") or os.getenv("FALLBACK_PROVIDERS") or "groq,openrouter,cloudflare,gemini"
    return [p.strip().lower() for p in raw.split(",") if p.strip()]


def _build_provider_chain(order, temperature=0.1, **kw):
    """Return [(name, factory)] for every provider in `order` that is configured."""
    registry = _provider_registry()
    chain = []
    for name in order:
        entry = registry.get(name)
        if not entry:
            print(f"[FallbackLLM] unknown provider '{name}' in fallback order — skipped")
            continue
        available, factory = entry
        try:
            if not available():
                continue
            # Validate construction now so a broken provider never lands in the chain.
            factory(temperature=temperature, **kw)
            chain.append((name, factory))
        except Exception as e:
            print(f"[FallbackLLM] provider '{name}' unavailable ({e}) — skipped")
    return chain


def llm(temperature=0.1, **kw):
    """Primary text LLM with a real runtime fallback chain.

    Honors TEXT_FALLBACK_PROVIDERS / FALLBACK_PROVIDERS (comma-separated,
    default "groq,openrouter,cloudflare,gemini"). On a per-request failure the
    next available provider in the chain is tried; when none is left the last
    error is raised.
    """
    chain = _build_provider_chain(_text_chain_order())
    if not chain:
        # No provider configured at all — preserve old behavior (Gemini last resort).
        return gemini_llm(temperature=temperature, **kw)
    models = [f(temperature=temperature, **kw) for _, f in chain]
    names = [n for n, _ in chain]
    fb = FallbackChatModel(models=models, provider_names=names)
    print(f"[llm] provider chain: {' -> '.join(names)}")
    return fb


class RateLimitRetryLLM:
    """Wraps a ChatGoogleGenerativeAI and retries on transient rate-limit errors."""
    def __init__(self, inner, max_retries=1):
        self.inner = inner
        self.max_retries = max_retries

    def invoke(self, *args, **kwargs):
        delay = 5.0
        for attempt in range(self.max_retries):
            try:
                return self.inner.invoke(*args, **kwargs)
            except Exception as e:
                s = str(e)
                # Hard daily quota (e.g. Groq GenerateRequestsPerDay) is NOT a
                # transient error: sleeping/retrying is pointless. Fall back to
                # Gemini (key present -> GOOGLE_API_KEY) so /chat keeps working.
                hard_quota = (
                    'GenerateRequestsPerDay' in s
                    or 'GenerateRequestsPerDay' in s
                    or 'GenerateRequestsPerDay' in s
                    or 'GenerateRequestsPerDay' in s
                    or 'request quota' in s.lower()
                    or 'daily' in s.lower() and ('limit' in s.lower() or 'quota' in s.lower())
                )
                if hard_quota:
                    print("[RateLimitRetryLLM] Groq daily quota -> falling back to Gemini")
                    try:
                        return gemini_llm(temperature=0.1).invoke(*args, **kwargs)
                    except Exception as e2:
                        raise RuntimeError(
                            "Groq daily quota exhausted and Gemini fallback failed: " + str(e2)
                        )
                # Transient rate limit: honor the reported backoff, retry if room
                if 'rate' in s.lower() or 'quota' in s.lower() or '429' in s:
                    m = re.search(r'seconds[{\s]+(\d+(?:\.\d+)?)', s)
                    delay = float(m.group(1)) if m else max(delay, 5)
                    if attempt < self.max_retries - 1:
                        time.sleep(delay)
                        continue
                raise
        raise RuntimeError("LLM request failed after retries")
    def __getattr__(self, name):
        return getattr(self.inner, name)



class AgentDecisoinConfig:
    def __init__(self):
        self.llm = llm(temperature=0.1)
        self.context_limit = 20


class ConversationConfig:
    def __init__(self):
        self.llm = llm(temperature=0.7)
        self.context_limit = 20


class WebSearchConfig:
    def __init__(self):
        self.llm = llm(temperature=0.3)
        self.context_limit = 20


class RAGConfig:
    def __init__(self):
        self.vector_db_type = "qdrant"
        self.embedding_dim = 3072
        self.embedding_model = DEFAULT_EMBEDDING_MODEL
        self.distance_metric = "Cosine"
        self.use_local = True
        _data_dir = os.getenv("DATA_DIR", "./data").rstrip("/\\")
        self.vector_local_path = os.path.join(_data_dir, "qdrant_db_v2")
        self.doc_local_path = os.path.join(_data_dir, "docs_db")
        self.parsed_content_dir = os.path.join(_data_dir, "parsed_docs")
        self.url = os.getenv("QDRANT_URL", "https://171fd73f-b471-4181-9333-c05c52737545.eu-central-1-0.aws.cloud.qdrant.io")
        self.api_key = os.getenv("QDRANT_API_KEY", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2Nlc3MiOiJtIiwic3ViamVjdCI6ImFwaS1rZXk6MjA1NmU4NzUtOGIzOC00NzAyLWJkNTgtMWVhYzI1MDMwMTEyIn0.6OEmnvUmH3aC8HS2YatsQff5mhK9kCz6_r7U4DBVnrs")
        self.collection_name = "medical_assistance_rag"
        self.chunk_size = 512
        self.chunk_overlap = 50
        self.llm = llm(temperature=0.3)
        self.summarizer_model = llm(temperature=0.5)
        self.chunker_model = llm(temperature=0.0)
        self.response_generator_model = llm(temperature=0.3)
        self.top_k = 5
        self.vector_search_type = 'similarity'
        self.huggingface_token = os.getenv("HUGGINGFACE_TOKEN")
        self.enable_reranker = os.getenv("ENABLE_RERANKER", "false").lower() == "true"
        self.reranker_model = "cross-encoder/ms-marco-TinyBERT-L-6"
        self.reranker_top_k = 3
        self.max_context_length = 8192
        self.include_sources = True
        self.min_retrieval_confidence = 0.40
        self.context_limit = 20


def _vision_llm():
    from langchain_google_genai import ChatGoogleGenerativeAI
    return ChatGoogleGenerativeAI(
        model=os.getenv("GEMINI_VISION_MODEL", "gemini-3.6-flash"),
        temperature=0.1,
        transport="rest",
    ).with_retry(retry_if_exception_type=(Exception,), stop_after_attempt=2)

class MedicalImageConfig:
    def __init__(self):
        self.ocr_llm = llm(temperature=0.1)
        # Vision needs a genuinely vision-capable model: prefer Gemini when a
        # Google key is configured (Groq's text-only models cannot read images).
        # Runtime fallback order comes from VISION_FALLBACK_PROVIDERS.
        vision_order = [
            p.strip().lower()
            for p in (os.getenv("VISION_FALLBACK_PROVIDERS") or "gemini,openrouter,cloudflare,groq").split(",")
            if p.strip()
        ]
        vision_chain = _build_provider_chain(vision_order, temperature=0.1)
        if vision_chain:
            self.vision_llm = FallbackChatModel(
                models=[f(temperature=0.1) for _, f in vision_chain],
                provider_names=[n for n, _ in vision_chain],
            )
            print(f"[vision] provider chain: {' -> '.join(n for n, _ in vision_chain)}")
        else:
            self.vision_llm = _vision_llm()
        self.llm = self.ocr_llm


class SpeechConfig:
    def __init__(self):
        self.eleven_labs_api_key = os.getenv("ELEVEN_LABS_API_KEY")
        self.eleven_labs_voice_id = "21m00Tcm4TlvDq8ikWAM"


class ValidationConfig:
    def __init__(self):
        self.require_validation = {
            "CONVERSATION_AGENT": False,
            "RAG_AGENT": False,
            "WEB_SEARCH_AGENT": False,
            "MEDICAL_IMAGE_AGENT": True
        }
        self.validation_timeout = 300
        self.default_action = "reject"


class APIConfig:
    def __init__(self):
        self.host = os.getenv("HOST", "0.0.0.0")
        self.port = int(os.getenv("PORT", "8000"))
        self.debug = True
        self.rate_limit = 10
        self.max_image_upload_size = 5
        self.max_pdf_upload_size = 10  # MB
        self.max_pdf_pages = 50


class HealthCheckupConfig:
    def __init__(self):
        self.packages = {
            "full_body": "Full Body Checkup",
        }


class UIConfig:
    def __init__(self):
        self.theme = "light"
        self.enable_speech = True
        self.enable_image_upload = True


class Config:
    def __init__(self):
        self.agent_decision = AgentDecisoinConfig()
        self.conversation = ConversationConfig()
        self.rag = RAGConfig()
        self.medical_cv = MedicalImageConfig()
        self.web_search = WebSearchConfig()
        self.api = APIConfig()
        self.speech = SpeechConfig()
        self.validation = ValidationConfig()
        self.health_checkup = HealthCheckupConfig()
        self.ui = UIConfig()
        self.eleven_labs_api_key = os.getenv("ELEVEN_LABS_API_KEY")
        self.tavily_api_key = os.getenv("TAVILY_API_KEY")
        self.max_conversation_history = 20