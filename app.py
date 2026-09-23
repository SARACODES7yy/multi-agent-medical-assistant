import os
import sys
import uuid
import asyncio
import tempfile
import logging
from datetime import datetime, timezone

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
from typing import Dict, Union, Optional, List
import glob
import threading
import time
import hashlib

# ---- Server-side AI-response cache (quota-friendly: reuse near-identical submissions) ----
# ---- short-answer AI dedupe cache (quota-friendly; keyed by exact narrative) ----
_ai_response_cache: Dict[str, tuple] = {}
_AI_CACHE: Dict[str, tuple] = {}
_ai_response_cache: Dict[str, tuple] = {}
_AI_CACHE_TTL = 300

def _ai_cache_lookup(key):
    v = _AI_CACHE.get(key)
    if v and time.time() - v[0] < _AI_CACHE_TTL:
        return v
    return None

def _ai_cache_store(key, data):
    _AI_CACHE[key] = (time.time(), data)
    if len(_AI_CACHE) > 128:
        for _k in list(_AI_CACHE.keys()):
            if time.time() - _AI_CACHE[_k][0] > _AI_CACHE_TTL:
                del _AI_CACHE[_k]
from io import BytesIO

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Depends, Request, Response, Cookie
from fastapi.responses import JSONResponse, FileResponse, HTMLResponse
from starlette.concurrency import run_in_threadpool
from langchain_core.messages import HumanMessage
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

import uvicorn
import requests
from werkzeug.utils import secure_filename
try:
    from pydub import AudioSegment
    PYDUB_AVAILABLE = True
except ImportError:
    PYDUB_AVAILABLE = False
from elevenlabs.client import ElevenLabs

from config import Config
from agents.agent_decision import process_query, get_graph
from auth import AuthManager, create_session_cookie, verify_session_cookie
from models.db import get_db, Database
from models.patient_rag import PatientRAG
from utils.pdf_extract import extract_pdf_text

# Load configuration
logger = logging.getLogger(__name__)
config = Config()

# Auth + per-patient RAG
auth_manager = AuthManager()
patient_rag = PatientRAG()
db = get_db()
# NOTE: RapidOCR/docling are intentionally NOT pre-warmed here. Their
# onnxruntime inference runs in an isolated child process per upload
# (see utils/isolated_worker.py) so a crash/OOM can never kill this server,
# and skipping the preload keeps boot memory low on small instances.

# Initialize FastAPI app
app = FastAPI(title="Multi-Agent Medical Chatbot", version="2.0")

# Set up directories
UPLOAD_FOLDER = "uploads/backend"
FRONTEND_UPLOAD_FOLDER = "uploads/frontend"
SKIN_LESION_OUTPUT = "uploads/skin_lesion_output"
SPEECH_DIR = "uploads/speech"

# Create directories if they don't exist
for directory in [UPLOAD_FOLDER, FRONTEND_UPLOAD_FOLDER, SKIN_LESION_OUTPUT, SPEECH_DIR]:
    os.makedirs(directory, exist_ok=True)

# Mount static files directory
app.mount("/static", StaticFiles(directory="static"), name="static")
app.mount("/data", StaticFiles(directory="data"), name="data")
app.mount("/uploads", StaticFiles(directory="uploads"), name="uploads")

# Set up templates
templates = Jinja2Templates(directory="templates")

# Initialize ElevenLabs client
client = ElevenLabs(
    api_key=config.speech.eleven_labs_api_key,
)

# Define allowed file extensions
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'pdf'}
ALLOWED_IMAGE_EXTENSIONS = {'png', 'jpg', 'jpeg'}
ALLOWED_DOC_EXTENSIONS = {'pdf'}

def allowed_file(filename):
    """Check if file has an allowed extension"""
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def is_pdf(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() == 'pdf'

def is_image(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_IMAGE_EXTENSIONS

def downscale_image_file(path, max_dim=1600):
    """Shrink very large photos to bound OCR/LLM time and RAM (free-tier 502 guard). Never raises."""
    try:
        from PIL import Image
        with Image.open(path) as im:
            if max(im.size) > max_dim:
                im.thumbnail((max_dim, max_dim), Image.LANCZOS)
                im.save(path)
    except Exception as e:
        logger.warning(f"Image downscale skipped: {e}")


async def describe_scanned_pdf(file_path, extra_context=""):
    """Read a scanned (image-only) PDF via rasterize + Gemini vision.

    Returns ``(text, page_count)``. Raises ``ValueError`` when vision is not
    configured (GOOGLE_API_KEY missing) or nothing readable comes back.
    """
    if not (os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")):
        raise ValueError(
            "This PDF looks scanned (no readable text) and image analysis needs "
            "a Gemini key (GOOGLE_API_KEY is not configured on the server)."
        )
    from utils.pdf_extract import rasterize_pdf_pages
    from agents.agent_decision import AgentConfig
    pages = await run_in_threadpool(rasterize_pdf_pages, file_path)
    classifier = AgentConfig.image_analyzer.image_classifier
    text = await run_in_threadpool(classifier.describe_page_images, pages, extra_context)
    if not text or not text.strip():
        raise ValueError("No readable content found in the scanned PDF, even with image analysis.")
    return text.strip(), len(pages)

def cleanup_old_audio():
    """Deletes all .mp3 files in the uploads/speech folder every 5 minutes."""
    while True:
        try:
            files = glob.glob(f"{SPEECH_DIR}/*.mp3")
            for file in files:
                os.remove(file)
            print("Cleaned up old speech files.")
        except Exception as e:
            print(f"Error during cleanup: {e}")
        time.sleep(300)  # Runs every 5 minutes

# Start background cleanup thread
cleanup_thread = threading.Thread(target=cleanup_old_audio, daemon=True)
cleanup_thread.start()

class QueryRequest(BaseModel):
    query: str
    conversation_history: List = []

class SpeechRequest(BaseModel):
    text: str
    voice_id: str = "EXAMPLE_VOICE_ID"  # Default voice ID

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    """Serve the main HTML page"""
    return templates.TemplateResponse(request, "index.html", {"request": request})

@app.get("/health")
def health_check():
    """Health check endpoint for Docker health checks"""
    return {"status": "healthy"}

@app.post("/chat")
async def chat(
    request: Request,
    response: Response,
    session_id: Optional[str] = Cookie(None)
):
    """Process text query or medical image/PDF upload (AI-based) via /chat."""
    payload = verify_session_cookie(session_id)
    user_id = payload["user_id"] if payload else None
    content_type = request.headers.get("content-type", "") or ""
    has_file = False
    file_path = None
    query_text = ""
    filename_str = ""
    is_img_file = False
    is_pdf_file = False

    # --- Parse input: multipart (image) vs JSON (text) ---
    if "multipart/form-data" in content_type:
        form = await request.form()
        _q = form.get("query")
        query_text = str(_q).strip() if (_q is not None and not isinstance(_q, UploadFile)) else ""
        uploaded = form.get("file") or form.get("image")
        if uploaded is not None:
            try:
                filename_str = getattr(uploaded, "filename", "") or "upload"
            except Exception:
                filename_str = "upload"
            # Detect type even for empty filename (fallback to image)
            is_img_file = is_image(filename_str)
            is_pdf_file = is_pdf(filename_str)
            # Content-based fallback: treat as image if unknown but file present
            if not is_img_file and not is_pdf_file:
                is_img_file = True
            has_file = True
            try:
                save_name = secure_filename(f"{uuid.uuid4()}_{filename_str or 'upload.png'}")
                file_path = os.path.join(UPLOAD_FOLDER, save_name)
                content = await uploaded.read()
                # uploaded.read() may return "" if already consumed; guard
                if content:
                    with open(file_path, "wb") as f:
                        f.write(content)
                else:
                    file_path = None
                    has_file = False
            except Exception as e:
                logger.warning(f"Failed to save uploaded file for /chat: {e}")
                file_path = None
                has_file = False
    else:
        try:
            body = await request.json()
            query_text = (body.get("query") or body.get("text") or "").strip() if isinstance(body, dict) else ""
        except Exception:
            query_text = ""

    # --- Non-file (pure text) path: preserve original behavior ---
    if not has_file or not file_path:
        # No file -> standard text chat (existing logic)
        augmented = augment_query(query_text, session_id)
        history = []
        if user_id:
            history = db.get_chat_history(user_id, limit=config.max_conversation_history)
            if query_text:
                db.add_message(user_id, "user", query_text)
        if not session_id:
            session_id = str(uuid.uuid4())
        _dedupe_key = hashlib.sha256((augmented + "|" + (user_id or "")).encode("utf-8")).hexdigest()
        _dedupe = _ai_response_cache.get(_dedupe_key)
        if _dedupe and (time.time() - _dedupe[0]) < 300:
            # De-duplicate: same narrative re-submitted within 5 min -> return cached AI note (saves a Groq call)
            if user_id:
                db.add_message(user_id, "user", query_text)
            response.set_cookie(key="session_id", value=_dedupe[3])
            return {"status": "success", "response": _dedupe[1], "agent": _dedupe[2], "session_id": _dedupe[3],
                    "summary": _dedupe[4].get("summary", ""), "chief_complaints": _dedupe[4].get("chief_complaints", [])}
        try:
            response_data = process_query(augmented, conversation_history=history, user_id=user_id)
            if response_data.get("status") == "validation_required":
                if user_id:
                    db.add_message(user_id, "assistant", response_data["message"], agent="HUMAN_VALIDATION")
                response.set_cookie(key="session_id", value=session_id)
                return {"status": "validation_required", "message": response_data["message"], "thread_id": response_data["thread_id"]}
            # Normal success - handle both message list and validation shapes
            msgs = response_data.get("messages")
            if msgs and isinstance(msgs, list) and len(msgs) > 0:
                last = msgs[-1]
                response_text = last.content if hasattr(last, "content") else (last.get("content", "") if isinstance(last, dict) else str(last))
                if isinstance(response_text, list):
                    response_text = " ".join(str(c) for c in response_text)
            else:
                response_text = str(response_data.get("output", "") or response_data.get("response", ""))
            agent_name = response_data.get("agent_name", "")
            if user_id:
                db.add_message(user_id, "assistant", response_text, agent=agent_name)
                try:
                    patient_rag.add_patient_data(user_id, f"Q: {query_text}\nA: {response_text}", source=f"chat/{agent_name}")
                except Exception as se:
                    logger.warning(f"Failed to index chat to RAG: {se}")
            response.set_cookie(key="session_id", value=session_id)
            # Store into dedupe cache so an identical re-submission within TTL returns without another Groq call
            _ai_response_cache[_dedupe_key] = (time.time(), response_text, agent_name, session_id,
                                               {"summary": response_text, "chief_complaints": []})
            return {"status": "success", "response": response_text, "agent": agent_name}
        except Exception as e:
            s = str(e)
            if 'GenerateRequestsPerDay' in s or 'rate' in s.lower() or 'quota' in s.lower():
                import re
                m = re.search(r'retry_delay[{\s]+seconds[{\s]+(\d+(?:\.\d+)?)', s)
                delay = float(m.group(1)) if m else 60
                raise HTTPException(status_code=429, detail=f"API rate limit reached. Please retry in {int(delay)} seconds.")
            raise HTTPException(status_code=500, detail=str(e))

    # --- File path: AI-based image/PDF analysis via existing agents ---
    if not session_id:
        session_id = str(uuid.uuid4())
    history = db.get_chat_history(user_id, limit=config.max_conversation_history) if user_id else []
    # Build augmented text like /upload does (include patient context)
    if is_pdf_file:
        # PDF branch: extract text and synthesize via conversation agent.
        # Both extraction and the LLM call are blocking: run them in a worker
        # thread so this single-worker server keeps answering /health (502 guard).
        try:
            pdf_text, page_count = await run_in_threadpool(extract_pdf_text, file_path, config.api.max_pdf_pages)
        except ValueError as ve:
            if "No readable text" in str(ve):
                # Image-only scan: rasterize pages and read them with vision.
                try:
                    pdf_text, page_count = await describe_scanned_pdf(file_path, query_text)
                except ValueError as ve2:
                    try: os.remove(file_path)
                    except Exception: pass
                    return JSONResponse(status_code=400, content={"status": "error", "agent": "System", "response": str(ve2)})
            else:
                try: os.remove(file_path)
                except Exception: pass
                return JSONResponse(status_code=400, content={"status": "error", "agent": "System", "response": str(ve)})
        except Exception as ve:
            try: os.remove(file_path)
            except Exception: pass
            return JSONResponse(status_code=400, content={"status": "error", "agent": "System", "response": f"Could not read PDF: {ve}"})
        max_chars = 32000
        truncated = pdf_text[:max_chars]
        if len(pdf_text) > max_chars:
            truncated += f"\n\n[... truncated — {len(pdf_text) - max_chars} characters omitted ...]"
        query_text_pdf = f"[PDF CONTENT - {page_count} page(s)]\n{truncated}\n\n[USER QUESTION]\n{query_text or 'Summarize this document'}"
        augmented_text = augment_query(query_text_pdf, session_id)
        try:
            response_data = await run_in_threadpool(process_query, augmented_text, history, user_id)
        finally:
            try: os.remove(file_path)
            except Exception: pass
        if response_data.get("status") == "validation_required":
            response.set_cookie(key="session_id", value=session_id)
            return {"status": "validation_required", "message": response_data["message"], "thread_id": response_data["thread_id"]}
        msgs = response_data.get("messages")
        if msgs and isinstance(msgs, list) and len(msgs) > 0:
            last = msgs[-1]
            response_text = last.content if hasattr(last, "content") else (last.get("content", "") if isinstance(last, dict) else str(last))
            if isinstance(response_text, list):
                response_text = " ".join(str(c) for c in response_text)
        else:
            response_text = str(response_data.get("output", "") or "")
        agent_name = response_data.get("agent_name", "")
        response.set_cookie(key="session_id", value=session_id)
        if user_id:
            db.add_message(user_id, "user", query_text or f"Uploaded PDF: {filename_str} ({page_count} pages)")
            db.add_message(user_id, "assistant", response_text, agent=agent_name)
            try:
                patient_rag.add_patient_data(user_id, f"[Uploaded PDF: {filename_str}]\n{pdf_text[:4000]}", source=f"pdf/{filename_str}")
            except Exception as se:
                logger.warning(f"Failed to index PDF to patient RAG: {se}")
        return {"status": "success", "response": response_text, "agent": agent_name}
    else:
        # Image branch: AI vision via MEDICAL_IMAGE_AGENT (same as /upload)
        downscale_image_file(file_path)
        augmented_text = augment_query(query_text or "Analyze this medical image", session_id)
        try:
            query = {"text": augmented_text, "image": file_path}
            try:
                response_data = await run_in_threadpool(process_query, query, history, user_id)
            except Exception:
                # Fall back to text-only analysis when the image analysis agent fails
                response_data = await run_in_threadpool(process_query, {"text": augmented_text}, history, user_id)
            if response_data.get("status") == "validation_required":
                response.set_cookie(key="session_id", value=session_id)
                return {"status": "validation_required", "message": response_data["message"], "thread_id": response_data["thread_id"]}
            msgs = response_data.get("messages")
            if msgs and isinstance(msgs, list) and len(msgs) > 0:
                last = msgs[-1]
                cnt = last.content if hasattr(last, "content") else (last.get("content", "") if isinstance(last, dict) else str(last))
                if isinstance(cnt, list):
                    cnt = " ".join(str(c) for c in cnt)
                response_text = str(cnt) if cnt else str(response_data.get("output", ""))
            else:
                # validation path already handled; fallback
                _msg = response_data.get('messages', [{'content': response_data.get('output', '')}])[-1]
                _cnt = _msg.get('content', '') if isinstance(_msg, dict) else (getattr(_msg, 'content', '') or str(_msg))
                if isinstance(_cnt, list): _cnt = " ".join(str(c) for c in _cnt)
                response_text = str(_cnt) if _cnt else str(response_data.get('output', ''))
            agent_name = response_data.get("agent_name", "")
            response.set_cookie(key="session_id", value=session_id)
            if user_id:
                db.add_message(user_id, "user", query_text or "Uploaded a medical image")
                db.add_message(user_id, "assistant", response_text, agent=agent_name)
            result = {"status": "success", "response": response_text, "agent": agent_name}
            # Attach the structured JSON block (if the agent returned one) so the
            # frontend can render OCR findings graphically without re-parsing text.
            try:
                _json_block = None
                import json as _json
                _t = response_text
                _b = _t.find("{")
                if _b >= 0:
                    _depth = 0; _end = -1; _in_str = False; _esc = False
                    for _i in range(_b, len(_t)):
                        _ch = _t[_i]
                        if _in_str:
                            if _esc: _esc = False
                            elif _ch == "\\": _esc = True
                            elif _ch == '"': _in_str = False
                        else:
                            if _ch == '"': _in_str = True
                            elif _ch == "{": _depth += 1
                            elif _ch == "}":
                                _depth -= 1
                                if _depth == 0: _end = _i; break
                    if _end > _b:
                        _json_block = _json.loads(_t[_b:_end + 1])
                result["response_json"] = _json_block
            except Exception as _pe:
                print(f"[chat] no structured JSON in image response: {_pe}")
        finally:
            try: os.remove(file_path)
            except Exception: pass
        return result

@app.post("/upload")
async def upload_file(
    response: Response,
    image: UploadFile = File(None),
    file: UploadFile = File(None),
    text: str = Form(""),
    session_id: Optional[str] = Cookie(None)
):
    """Process medical image or PDF uploads with optional text input."""
    # Accept either 'image' or 'file' form field (frontend uses 'file')
    uploaded = file or image
    if not uploaded or not uploaded.filename:
        return JSONResponse(
            status_code=400,
            content={
                "status": "error",
                "agent": "System",
                "response": "No file provided"
            }
        )

    filename = uploaded.filename
    is_pdf_file = is_pdf(filename)
    is_img_file = is_image(filename)

    # Validate file type
    if not is_pdf_file and not is_img_file:
        return JSONResponse(
            status_code=400,
            content={
                "status": "error",
                "agent": "System",
                "response": "Unsupported file type. Allowed formats: PNG, JPG, JPEG, PDF"
            }
        )

    # Check file size before saving
    file_content = await uploaded.read()
    max_size = config.api.max_pdf_upload_size if is_pdf_file else config.api.max_image_upload_size
    if len(file_content) > max_size * 1024 * 1024:  # Convert MB to bytes
        return JSONResponse(
            status_code=413,
            content={
                "status": "error",
                "agent": "System",
                "response": f"File too large. Maximum size allowed: {max_size}MB"
            }
        )

    # Generate session ID for cookie if it doesn't exist
    if not session_id:
        session_id = str(uuid.uuid4())

    # Save file securely
    save_name = secure_filename(f"{uuid.uuid4()}_{filename}")
    file_path = os.path.join(UPLOAD_FOLDER, save_name)
    with open(file_path, "wb") as f:
        f.write(file_content)

    # Bound OCR/LLM time and RAM: downscale very large photos before analysis.
    # (Full-res phone photos spike memory on small Render instances -> 502.)
    if is_img_file:
        downscale_image_file(file_path)

    try:
        payload = verify_session_cookie(session_id)
        user_id = payload["user_id"] if payload else None

        history = db.get_chat_history(user_id, limit=config.max_conversation_history) if user_id else []
        augmented_text = augment_query(text or ("Analyze this medical image" if is_img_file else "Summarize this medical document"), session_id)

        if is_pdf_file:
            # --- PDF path: extract text, answer inline, index into RAG ---
            # Extraction + LLM call are blocking: threadpool keeps /health alive (502 guard).
            try:
                pdf_text, page_count = await run_in_threadpool(extract_pdf_text, file_path, config.api.max_pdf_pages)
            except ValueError as ve:
                if "No readable text" in str(ve):
                    # Image-only scan: rasterize pages and read them with vision.
                    try:
                        pdf_text, page_count = await describe_scanned_pdf(file_path, text)
                    except ValueError as ve2:
                        return JSONResponse(
                            status_code=400,
                            content={
                                "status": "error",
                                "agent": "System",
                                "response": str(ve2)
                            }
                        )
                else:
                    return JSONResponse(
                        status_code=400,
                        content={
                            "status": "error",
                            "agent": "System",
                            "response": str(ve)
                        }
                    )
            except Exception as ve:
                return JSONResponse(
                    status_code=400,
                    content={
                        "status": "error",
                        "agent": "System",
                        "response": f"Could not read PDF: {ve}"
                    }
                )

            # Truncate to fit LLM context (rough: ~4 chars per token, 8192 tokens ≈ 32k chars)
            max_chars = 32000
            truncated = pdf_text[:max_chars]
            if len(pdf_text) > max_chars:
                truncated += f"\n\n[... truncated — {len(pdf_text) - max_chars} characters omitted ...]"

            query_text = f"[PDF CONTENT - {page_count} page(s)]\n{truncated}\n\n[USER QUESTION]\n{text or 'Summarize this document'}"
            augmented_text = augment_query(query_text, session_id)

            query = augmented_text
            response_data = await run_in_threadpool(process_query, query, history, user_id)
            if response_data.get("status") == "validation_required":
                response.set_cookie(key="session_id", value=session_id)
                return {"status": "validation_required", "message": response_data["message"], "thread_id": response_data["thread_id"]}
            response_text = response_data.get('messages', [response_data.get('output', '')])[-1].content if isinstance(response_data.get('messages'), list) else str(response_data.get('output', ''))
            agent_name = response_data.get("agent_name", "")

            # Set session cookie
            response.set_cookie(key="session_id", value=session_id)

            # Persist the exchange
            if user_id:
                user_msg = text or f"Uploaded PDF: {filename} ({page_count} pages)"
                db.add_message(user_id, "user", user_msg)
                db.add_message(user_id, "assistant", response_text, agent=agent_name)

                # Index the PDF content into patient RAG for future retrieval
                try:
                    patient_rag.add_patient_data(
                        user_id,
                        f"[Uploaded PDF: {filename}]\n{pdf_text[:4000]}",
                        source=f"pdf/{filename}",
                    )
                except Exception as se:
                    logger.warning(f"Failed to index PDF to patient RAG: {se}")

            result = {
                "status": "success",
                "response": response_text,
                "agent": agent_name
            }
        else:
            # --- Image path: existing image analysis workflow ---
            augmented_text = augment_query(text or "Analyze this medical image", session_id)
            query = {"text": augmented_text, "image": file_path}
            # process_query is fully synchronous (local OCR + several LLM calls).
            # Run it in a worker thread so this single-worker server keeps answering
            # /health and other requests instead of hanging until the proxy gives up (502).
            try:
                response_data = await run_in_threadpool(process_query, query, history, user_id)
            except Exception:
                # Fall back to text-only analysis when the image analysis agent fails
                response_data = await run_in_threadpool(process_query, {"text": augmented_text}, history, user_id)
            if response_data.get("status") == "validation_required":
                response.set_cookie(key="session_id", value=session_id)
                return {"status": "validation_required", "message": response_data["message"], "thread_id": response_data["thread_id"]}
            _msg = response_data.get('messages', [{'content': response_data.get('output', '')}])[-1]
            _cnt = _msg.get('content', '') if isinstance(_msg, dict) else str(_msg)
            if isinstance(_cnt, list):
                _cnt = ' '.join(str(c) for c in _cnt)
            response_text = str(_cnt) if _cnt else str(response_data.get('output', ''))
            agent_name = response_data.get("agent_name", "")

            # Set session cookie
            response.set_cookie(key="session_id", value=session_id)

            # Persist the exchange
            if user_id:
                db.add_message(user_id, "user", text or "Uploaded a medical image")
                db.add_message(user_id, "assistant", response_text, agent=agent_name)

            result = {
                "status": "success",
                "response": response_text,
                "agent": agent_name
            }

        # Remove temporary file after sending
        try:
            os.remove(file_path)
        except Exception as e:
            print(f"Failed to remove temporary file: {str(e)}")

        return result
    except Exception as e:
        # Cleanup on error too
        try:
            os.remove(file_path)
        except Exception:
            pass
        raise HTTPException(status_code=500, detail=str(e))

def get_patient_context(session_id: Optional[str] = Cookie(None)) -> str:
    """Return profile fields + retrieved RAG chunks for a logged-in patient."""
    payload = verify_session_cookie(session_id)
    if not payload or payload.get("role") != "patient":
        return ""
    user = db.get_user(payload["user_id"])
    profile = db.get_profile(payload["user_id"])
    if not profile:
        return ""
    parts = []
    for key in ("medical_history", "allergies", "conditions", "treatments", "gender", "blood_group", "height",
                "weight", "blood_pressure", "medications", "family_history", "surgeries", "vaccination",
                "smoking", "alcohol", "exercise", "diet"):
        val = profile.get(key)
        if val:
            parts.append(f"{key}: {val}")
    context = "\n".join(parts)
    try:
        chunks = patient_rag.retrieve(payload["user_id"], context if context else "medical history", k=3)
        for c in chunks:
            if c.get("content"):
                context += ("\n" if context else "") + c["content"]
    except Exception as e:
        logger.warning(f"Patient RAG retrieve failed: {e}")
    return context

def augment_query(query: str, session_id: Optional[str] = Cookie(None)) -> str:
    ctx = get_patient_context(session_id)
    if ctx:
        return f"[PATIENT CONTEXT]\n{ctx}\n\n[USER QUESTION]\n{query}"
    return query

@app.post("/patient/instruction")
def patient_instruction(
    request: Request,
    instruction_text: str = Form(...),
    patient_id: str = Form(...),
    session_id: Optional[str] = Cookie(None)
):
    """Doctor/nurse gives an instruction to a patient; saved to DB + patient RAG."""
    payload = verify_session_cookie(session_id)
    if not payload or payload["role"] not in ("doctor", "nurse"):
        raise HTTPException(status_code=403, detail="Only doctors/nurses can give instructions")
    target = db.get_user(patient_id)
    if not target or target.get("role") != "patient":
        raise HTTPException(status_code=404, detail="Patient not found")
    instruction = {
        "id": str(uuid.uuid4()),
        "doctor_id": payload["user_id"],
        "patient_id": patient_id,
        "instruction_text": instruction_text,
        "created_at": datetime.now(timezone.utc).isoformat()
    }
    db.add_instruction(instruction)
    try:
        patient_rag.add_instruction(instruction_text, patient_id, source=f"{payload['name']} ({payload['role']})")
    except Exception as e:
        logger.warning(f"Failed to add instruction to RAG: {e}")
    return {"status": "success", "instruction_id": instruction["id"]}

# Auth endpoints
@app.post("/signup")
async def signup(request: Request, response: Response):
    body = await request.json()
    email = body.get("email", "").strip().lower()
    password = body.get("password", "")
    role = body.get("role", "patient")
    if not email or not password:
        raise HTTPException(status_code=400, detail="email and password required")
    try:
        profile = {
            "name": body.get("name", ""),
            "qualification": body.get("qualification"),
            "dob": body.get("dob"),
            "id_type": body.get("id_type"),
            "id_number": body.get("id_number"),
            "medical_history": body.get("medical_history"),
            "allergies": body.get("allergies"),
            "conditions": body.get("conditions"),
            "treatments": body.get("treatments"),
        }
        user, cookie = auth_manager.signup(email, password, role, profile)
        response.set_cookie(key="session_id", value=cookie, max_age=86400*30)
        # Index patient profile into RAG so it is semantically searchable
        if role == "patient":
            try:
                profile_doc = {"user_id": user["id"], **profile}
                patient_rag.add_profile_as_document(profile_doc)
            except Exception as se:
                logger.warning(f"Failed to index profile to RAG: {se}")
        return {"status": "success", "user": {"id": user["id"], "email": user["email"], "role": user["role"]}}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/login")
async def login(request: Request, response: Response):
    body = await request.json()
    email = body.get("email", "").strip().lower()
    password = body.get("password", "")
    result = auth_manager.login(email, password)
    if not result:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    user, cookie = result
    response.set_cookie(key="session_id", value=cookie, max_age=86400*30)
    return {"status": "success", "user": {"id": user["id"], "email": user["email"], "role": user["role"]}}

@app.post("/logout")
def logout(response: Response, session_id: Optional[str] = Cookie(None)):
    auth_manager.logout(session_id)
    response.delete_cookie(key="session_id")
    return {"status": "success"}

@app.get("/me")
def me(session_id: Optional[str] = Cookie(None)):
    payload = verify_session_cookie(session_id)
    if not payload:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = db.get_user(payload["user_id"])
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    profile = db.get_profile(user["id"]) or {}
    return {"status": "ok", "user": {"id": user["id"], "email": user["email"], "role": user["role"], "name": profile.get("name",""), "qualification": profile.get("qualification"), **{k: profile.get(k) for k in ("dob","id_type","id_number","medical_history","allergies","conditions","treatments","gender","blood_group","height","weight","blood_pressure","medications","family_history","surgeries","vaccination","smoking","alcohol","exercise","diet","emergency_name","emergency_phone")}}}

@app.get("/api/doctor/patients")
def doctor_patients(session_id: Optional[str] = Cookie(None)):
    payload = verify_session_cookie(session_id)
    if not payload or payload["role"] not in ("doctor","nurse"):
        raise HTTPException(status_code=403, detail="Forbidden")
    instructions = db.get_doctor_instructions(payload["user_id"])
    return {"status": "ok", "patients": instructions}

@app.get("/api/chat/history")
def chat_history(session_id: Optional[str] = Cookie(None)):
    """Return the last N chat messages for the logged-in user."""
    payload = verify_session_cookie(session_id)
    if not payload:
        raise HTTPException(status_code=401, detail="Not authenticated")
    history = db.get_chat_history(payload["user_id"], limit=50)
    return {"status": "ok", "messages": history}

@app.get("/api/patient/instructions")
def patient_instructions(session_id: Optional[str] = Cookie(None)):
    """Return doctor/nurse instructions for the logged-in patient."""
    payload = verify_session_cookie(session_id)
    if not payload:
        raise HTTPException(status_code=401, detail="Not authenticated")
    instructions = db.get_patient_instructions(payload["user_id"])
    return {"status": "ok", "instructions": instructions}

@app.get("/api/checkup/status")
def checkup_status(session_id: Optional[str] = Cookie(None)):
    """Patient's checkup status: whether they've ever completed a full body checkup."""
    payload = verify_session_cookie(session_id)
    if not payload or payload["role"] != "patient":
        raise HTTPException(status_code=403, detail="Forbidden")
    latest = db.get_latest_checkup(payload["user_id"])
    has_completed = bool(latest and latest.get("status") == "completed")
    if has_completed:
        pending = None
    elif latest:
        pending = {
            "id": latest["id"],
            "package": latest.get("package"),
            "status": latest.get("status"),
            "preferred_date": latest.get("preferred_date"),
            "requested_at": latest.get("created_at"),
        }
    else:
        pending = None
    return {"status": "ok", "has_completed": has_completed, "pending": pending, "latest": latest, "packages": config.health_checkup.packages}

@app.post("/api/checkup/request")
async def checkup_request(request: Request, session_id: Optional[str] = Cookie(None)):
    """Patient opts in for a full body checkup."""
    payload = verify_session_cookie(session_id)
    if not payload or payload["role"] != "patient":
        raise HTTPException(status_code=403, detail="Forbidden")
    body = await request.json()
    package = body.get("package", "full_body")
    if package not in config.health_checkup.packages:
        raise HTTPException(status_code=400, detail="Unknown checkup package")
    preferred_date = body.get("preferred_date") or None
    notes = (body.get("notes") or "")[:500]
    checkup = db.add_checkup_request(payload["user_id"], package, preferred_date, notes)
    return {"status": "success", "checkup": checkup}

@app.get("/api/doctor/checkups")
def doctor_checkups(session_id: Optional[str] = Cookie(None)):
    """Doctor/nurse view of checkup requests, newest first."""
    payload = verify_session_cookie(session_id)
    if not payload or payload["role"] not in ("doctor", "nurse"):
        raise HTTPException(status_code=403, detail="Forbidden")
    checkups = db.get_checkups()
    result = []
    for c in checkups:
        p = db.get_user(c["patient_id"])
        prof = db.get_profile(c["patient_id"]) or {}
        result.append({
            **c,
            "type": "checkup",
            "patient_name": prof.get("name", "") or (p.get("email", "") if p else c["patient_id"]),
        })
    try:
        for s in db.get_triage_sessions(limit=200):
            owner = db.get_user(s["user_id"]) if s.get("user_id") else None
            prof = db.get_profile(s["user_id"]) if s.get("user_id") else None
            result.append({
                **s,
                "type": "triage",
                "patient_name": (prof or {}).get("name", "") or (owner.get("email", "") if owner else ""),
            })
    except Exception as e:
        logger.warning(f"Failed to load triage sessions for queue: {e}")
    result.sort(key=lambda r: r.get("created_at") or "", reverse=True)
    return {"status": "ok", "checkups": result}

class TriageSessionUpsert(BaseModel):
    id: Optional[str] = None
    anonym_code: str = ""
    facility: str = ""
    scenario: str = ""
    facility_name: str = ""
    age_band: str = ""
    sex: str = ""
    lang: str = ""
    narrative: str = ""
    risk: str = "standard"
    score: int = 0
    summary: str = ""
    timeline: str = ""
    chief_complaints: List[str] = []
    red_flags: List[str] = []
    missing_info: List[str] = []
    followup_questions: List[str] = []
    tests: List[dict] = []
    follow_up_date: Optional[str] = None
    consent: bool = False
    status: str = "requested"
    src: str = "local"
    created_at: Optional[str] = None

@app.post("/api/triage/sessions")
async def upsert_triage_session(req: TriageSessionUpsert, session_id: Optional[str] = Cookie(None)):
    """Create or update a triage session (persisted from the intake flow)."""
    payload = verify_session_cookie(session_id)
    if not payload:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if req.risk not in ("emergency", "urgent", "standard", "routine"):
        req.risk = "standard"
    if req.status not in ("requested", "scheduled", "completed"):
        req.status = "requested"
    session = req.model_dump()
    session["id"] = session.get("id") or str(uuid.uuid4())
    session["user_id"] = payload["user_id"]
    saved = db.upsert_triage_session(session)
    if not saved:
        raise HTTPException(status_code=500, detail="Failed to save triage session")
    return {"status": "ok", "session": saved}

@app.patch("/api/triage/session/{ts_id}")
async def update_triage_session(ts_id: str, request: Request, session_id: Optional[str] = Cookie(None)):
    """Doctor/nurse advances a triage session's queue status."""
    payload = verify_session_cookie(session_id)
    if not payload:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if payload["role"] not in ("doctor", "nurse"):
        raise HTTPException(status_code=403, detail="Forbidden")
    body = await request.json()
    status = body.get("status")
    if status not in ("requested", "scheduled", "completed"):
        raise HTTPException(status_code=400, detail="Invalid status")
    ok = db.update_triage_session_status(ts_id, status, body.get("follow_up_date"))
    if not ok:
        raise HTTPException(status_code=404, detail="Triage session not found")
    return {"status": "success"}

@app.patch("/api/checkup/{checkup_id}")
async def update_checkup(checkup_id: str, request: Request, session_id: Optional[str] = Cookie(None)):
    """Doctor/nurse marks a checkup request scheduled or completed."""
    payload = verify_session_cookie(session_id)
    if not payload or payload["role"] not in ("doctor", "nurse"):
        raise HTTPException(status_code=403, detail="Forbidden")
    body = await request.json()
    status = body.get("status")
    if status not in ("requested", "scheduled", "completed"):
        raise HTTPException(status_code=400, detail="Invalid status")
    ok = db.update_checkup_status(checkup_id, status)
    if not ok:
        raise HTTPException(status_code=404, detail="Checkup not found")
    return {"status": "success"}

@app.get("/api/doctor/doctors")
def get_doctors(session_id: Optional[str] = Cookie(None)):
    """List doctors (role=doctor) with profile name."""
    payload = verify_session_cookie(session_id)
    if not payload:
        raise HTTPException(status_code=401, detail="Not authenticated")
    doctors = db.get_doctors()
    return {"status": "ok", "doctors": doctors}

@app.get("/api/doctor/availability")
def get_availability(doctor_id: str, session_id: Optional[str] = Cookie(None)):
    """List availability slots for a doctor."""
    payload = verify_session_cookie(session_id)
    if not payload:
        raise HTTPException(status_code=401, detail="Not authenticated")
    slots = db.get_availability(doctor_id)
    return {"status": "ok", "availability": slots}

@app.post("/api/doctor/availability")
async def add_availability(request: Request, session_id: Optional[str] = Cookie(None)):
    """Doctor/nurse adds an available time slot."""
    payload = verify_session_cookie(session_id)
    if not payload or payload["role"] not in ("doctor", "nurse"):
        raise HTTPException(status_code=403, detail="Forbidden")
    body = await request.json()
    doctor_id = payload["user_id"]
    date = body.get("date")
    start_time = body.get("start_time")
    end_time = body.get("end_time")
    max_slots = body.get("max_slots", 1)
    if not date or not start_time or not end_time:
        raise HTTPException(status_code=400, detail="date, start_time, end_time required")
    slot = db.add_availability(doctor_id, date, start_time, end_time, max_slots)
    if not slot:
        raise HTTPException(status_code=500, detail="Failed to add availability")
    return {"status": "ok", "availability": slot}

@app.post("/api/call/book")
async def book_call(request: Request, session_id: Optional[str] = Cookie(None)):
    """Patient books a call against an availability slot."""
    payload = verify_session_cookie(session_id)
    if not payload or payload["role"] != "patient":
        raise HTTPException(status_code=403, detail="Forbidden")
    body = await request.json()
    doctor_id = body.get("doctor_id")
    availability_id = body.get("availability_id")
    notes = body.get("notes", "")
    if not availability_id:
        raise HTTPException(status_code=400, detail="availability_id required")
    slot = next((s for s in db.get_availability(doctor_id) if s.get("id") == availability_id), None)
    if not slot:
        raise HTTPException(status_code=404, detail="Availability slot not found")
    scheduled_at = f"{slot.get('date')}T{slot.get('start_time')}"
    booking = db.book_call(payload["user_id"], doctor_id, availability_id, scheduled_at, notes)
    if not booking:
        raise HTTPException(status_code=500, detail="Failed to book call")
    return {"status": "ok", "booking": booking}

@app.get("/api/call/bookings")
def get_bookings(session_id: Optional[str] = Cookie(None)):
    """List bookings for the logged-in user (patient: theirs; doctor: theirs)."""
    payload = verify_session_cookie(session_id)
    if not payload:
        raise HTTPException(status_code=401, detail="Not authenticated")
    bookings = db.get_bookings(payload["user_id"], payload["role"])
    return {"status": "ok", "bookings": bookings}

@app.patch("/api/call/booking/{booking_id}")
async def update_booking(booking_id: str, request: Request, session_id: Optional[str] = Cookie(None)):
    """Doctor/nurse confirms a booking; patient cancels their own."""
    payload = verify_session_cookie(session_id)
    if not payload:
        raise HTTPException(status_code=401, detail="Not authenticated")
    body = await request.json()
    status = body.get("status")
    if status not in ("confirmed", "completed", "cancelled"):
        raise HTTPException(status_code=400, detail="Invalid status")
    ok = db.update_booking_status(booking_id, status)
    if not ok:
        raise HTTPException(status_code=404, detail="Booking not found")
    return {"status": "success"}

@app.put("/api/profile")
async def update_profile(request: Request, session_id: Optional[str] = Cookie(None)):
    """Patient updates their own medical profile; re-indexes RAG."""
    payload = verify_session_cookie(session_id)
    if not payload:
        raise HTTPException(status_code=401, detail="Not authenticated")
    body = await request.json()
    user = db.get_user(payload["user_id"])
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    current = db.get_profile(user["id"]) or {}
    editable_keys = ("name", "dob", "medical_history", "allergies", "conditions", "treatments", "id_type", "id_number", "qualification",
                     "gender", "blood_group", "height", "weight", "blood_pressure", "medications", "family_history",
                     "surgeries", "vaccination", "smoking", "alcohol", "exercise", "diet",
                     "emergency_name", "emergency_phone")
    merged = dict(current)
    for k in editable_keys:
        if k in body:
            merged[k] = body.get(k)
    merged["user_id"] = user["id"]
    merged.setdefault("created_at", current.get("created_at"))
    db.upsert_profile(merged)
    # Re-index the enriched profile into Qdrant
    try:
        patient_rag.delete_patient_data(user["id"])
        patient_rag.add_profile_as_document(merged)
    except Exception as e:
        logger.warning(f"Failed to re-index profile to RAG: {e}")
    return {"status": "success", "user": merged}

@app.get("/profile", response_class=HTMLResponse)
def profile_page(request: Request, session_id: Optional[str] = Cookie(None)):
    payload = verify_session_cookie(session_id)
    if not payload:
        return templates.TemplateResponse(request, "login.html", {"request": request, "error": "Please log in"})
    user = db.get_user(payload["user_id"])
    if not user or user["role"] != "patient":
        return templates.TemplateResponse(request, "dashboard.html", {"request": request, "role": user["role"], "name": (db.get_profile(user["id"]) or {}).get("name",""), "error": "Health profile is for patients"})
    profile = db.get_profile(user["id"]) or {}
    return templates.TemplateResponse(request, "profile.html", {"request": request, "role": user["role"], "name": profile.get("name",""), "profile": profile})

@app.get("/dashboard", response_class=HTMLResponse)
def dashboard(request: Request, session_id: Optional[str] = Cookie(None)):
    payload = verify_session_cookie(session_id)
    if not payload:
        return templates.TemplateResponse(request, "login.html", {"request": request, "error": "Please log in"})
    user = db.get_user(payload["user_id"])
    profile = db.get_profile(user["id"]) or {}
    role = user["role"]
    if role == "patient":
        return templates.TemplateResponse(request, "dashboard.html", {"request": request, "role": role, "name": profile.get("name",""), "profile": profile})
    # doctor/nurse: list their patients
    patients = db.get_doctor_instructions(user["id"])
    return templates.TemplateResponse(request, "dashboard.html", {"request": request, "role": role, "name": profile.get("name",""), "patients": patients})

@app.get("/home", response_class=HTMLResponse)
def home_page(request: Request, session_id: Optional[str] = Cookie(None)):
    """Port of the reference Triage frontend onto the existing backend.

    A single tabbed triage page wired to the existing endpoints:
    intake/summary -> POST /chat, report OCR -> POST /upload,
    reviewer queue -> GET /api/doctor/checkups + PATCH /api/checkup/{id},
    referral -> POST /patient/instruction, timeline/audit -> /api/chat/history
    and /api/patient/instructions. No new backend routes or tables.
    """
    payload = verify_session_cookie(session_id)
    if not payload:
        return templates.TemplateResponse(request, "login.html", {"request": request, "error": "Please log in"})
    user = db.get_user(payload["user_id"])
    if not user:
        return templates.TemplateResponse(request, "login.html", {"request": request, "error": "Please log in"})
    profile = db.get_profile(user["id"]) or {}
    return templates.TemplateResponse(request, "home.html", {
        "request": request,
        "role": user["role"],
        "name": profile.get("name", ""),
        "email": user["email"],
    })

@app.get("/login", response_class=HTMLResponse)
def login_page(request: Request):
    return templates.TemplateResponse(request, "login.html", {"request": request})

@app.get("/signup", response_class=HTMLResponse)
def signup_page(request: Request):
    return templates.TemplateResponse(request, "signup.html", {"request": request})

@app.post("/validate")
async def validate_medical_output(request: Request, response: Response, session_id: Optional[str] = Cookie(None)):
    """Resume the interrupted graph with human validation feedback."""
    body = await request.json()
    thread_id = body.get("thread_id")
    decision = body.get("decision")
    comments = body.get("comments", "")
    if not thread_id:
        raise HTTPException(status_code=400, detail="thread_id is required")

    thread_cfg = {"configurable": {"thread_id": thread_id}}
    graph = get_graph()
    state_snapshot = graph.get_state(thread_cfg)
    messages = state_snapshot.values.get('messages', [])

    feedback = f"Validation Result: {decision}"
    if comments:
        feedback += f"\nComments: {comments}"
    new_messages = messages + [HumanMessage(content=feedback)]
    updated_state = state_snapshot.values.copy()
    updated_state['messages'] = new_messages

    result = graph.invoke(updated_state, thread_cfg)

    payload = verify_session_cookie(session_id)
    uid = payload["user_id"] if payload else None
    if uid:
        final_text = result['messages'][-1].content
        agent_name = result.get("agent_name")
        db.add_message(uid, "assistant", final_text, agent=agent_name)
        try:
            patient_rag.add_patient_data(uid, f"Q: [validated]\nA: {final_text}", source=f"chat/{agent_name}")
        except Exception as se:
            logger.warning(f"Failed to index validated chat to RAG: {se}")

    return {"status": "success", "response": result['messages'][-1].content, "agent": result.get("agent_name")}

@app.get("/api/speech-config")
async def get_speech_config():
    """Report server-side voice availability to the client (no secrets)."""
    has_key = bool(config.speech.eleven_labs_api_key)
    return {
        "available": has_key and PYDUB_AVAILABLE,
        "elevenlabs_key": has_key,
        "pydub": PYDUB_AVAILABLE,
        "engine": "elevenlabs-scribe" if (has_key and PYDUB_AVAILABLE) else None,
    }

@app.post("/transcribe")
async def transcribe_audio(audio: UploadFile = File(...)):
    """Endpoint to transcribe speech using ElevenLabs API"""
    if not config.speech.eleven_labs_api_key:
        return JSONResponse(
            status_code=503,
            content={"error": "Server-side voice transcription is not configured (ELEVEN_LABS_API_KEY missing)."}
        )
    if not audio.filename:
        return JSONResponse(
            status_code=400,
            content={"error": "No audio file selected"}
        )
    
    try:
        # Save the audio file temporarily
        os.makedirs(SPEECH_DIR, exist_ok=True)
        temp_audio = f"./{SPEECH_DIR}/speech_{uuid.uuid4()}.webm"
        
        # Read and save the file
        audio_content = await audio.read()
        with open(temp_audio, "wb") as f:
            f.write(audio_content)
        
        # Debug: Print file size to check if it's empty
        file_size = os.path.getsize(temp_audio)
        print(f"Received audio file size: {file_size} bytes")
        
        if file_size == 0:
            return JSONResponse(
                status_code=400,
                content={"error": "Received empty audio file"}
            )
        
# Convert to MP3
        mp3_path = f"./{SPEECH_DIR}/speech_{uuid.uuid4()}.mp3"

        if not PYDUB_AVAILABLE:
            return JSONResponse(status_code=503, content={"error": "Audio processing unavailable (pydub not supported on this Python version)"})
        try:
            audio = AudioSegment.from_file(temp_audio)
            audio.export(mp3_path, format="mp3")
            
            # Debug: Print MP3 file size
            mp3_size = os.path.getsize(mp3_path)
            print(f"Converted MP3 file size: {mp3_size} bytes")

            with open(mp3_path, "rb") as mp3_file:
                audio_data = mp3_file.read()
            print(f"Converted audio file into byte array successfully!")

            transcription = client.speech_to_text.convert(
                file=audio_data,
                model_id="scribe_v1",
                tag_audio_events=True,
                language_code="eng",
                diarize=True,
            )
            
            # Clean up temp files
            try:
                os.remove(temp_audio)
                os.remove(mp3_path)
                print(f"Deleted temp files: {temp_audio}, {mp3_path}")
            except Exception as e:
                print(f"Could not delete file: {e}")
            
            if transcription.text:
                return {"transcript": transcription.text}
            else:
                return JSONResponse(
                    status_code=500,
                    content={"error": f"API error: {transcription}", "details": transcription.text}
                )

        except Exception as e:
            print(f"Error processing audio: {str(e)}")
            return JSONResponse(
                status_code=500,
                content={"error": f"Error processing audio: {str(e)}"}
            )
                
    except Exception as e:
        print(f"Transcription error: {str(e)}")
        return JSONResponse(
            status_code=500,
            content={"error": str(e)}
        )

@app.post("/generate-speech")
async def generate_speech(request: SpeechRequest):
    """Endpoint to generate speech using ElevenLabs API"""
    try:
        text = request.text
        selected_voice_id = request.voice_id
        
        if not text:
            return JSONResponse(
                status_code=400,
                content={"error": "Text is required"}
            )
        
        # Define API request to ElevenLabs
        elevenlabs_url = f"https://api.elevenlabs.io/v1/text-to-speech/{selected_voice_id}/stream"
        headers = {
            "Accept": "audio/mpeg",
            "Content-Type": "application/json",
            "xi-api-key": config.speech.eleven_labs_api_key
        }
        payload = {
            "text": text,
            "model_id": "eleven_monolingual_v1",
            "voice_settings": {
                "stability": 0.5,
                "similarity_boost": 0.5
            }
        }

        # Send request to ElevenLabs API
        response = requests.post(elevenlabs_url, headers=headers, json=payload)

        if response.status_code != 200:
            return JSONResponse(
                status_code=500,
                content={"error": f"Failed to generate speech, status: {response.status_code}", "details": response.text}
            )
        
        # Save the audio file temporarily
        os.makedirs(SPEECH_DIR, exist_ok=True)
        temp_audio_path = f"./{SPEECH_DIR}/{uuid.uuid4()}.mp3"
        with open(temp_audio_path, "wb") as f:
            f.write(response.content)

        # Return the generated audio file
        return FileResponse(
            path=temp_audio_path,
            media_type="audio/mpeg",
            filename="generated_speech.mp3"
        )

    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"error": str(e)}
        )

# Add exception handler for request entity too large
@app.exception_handler(413)
async def request_entity_too_large(request, exc):
    return JSONResponse(
        status_code=413,
        content={
            "status": "error",
            "agent": "System",
            "response": f"File too large. Maximum size allowed: {config.api.max_image_upload_size}MB"
        }
    )

if __name__ == "__main__":
    cert_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "certs")
    certfile = os.getenv("SSL_CERTFILE", os.path.join(cert_dir, "cert.pem"))
    keyfile = os.getenv("SSL_KEYFILE", os.path.join(cert_dir, "key.pem"))
    ssl_kwargs = {}
    if os.path.exists(certfile) and os.path.exists(keyfile):
        ssl_kwargs = {"ssl_certfile": certfile, "ssl_keyfile": keyfile}
    uvicorn.run(app, host=config.api.host, port=config.api.port, **ssl_kwargs)