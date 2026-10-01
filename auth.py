import os
import hmac
import hashlib
import json
import time
import uuid
import logging
from datetime import datetime, timezone
from werkzeug.security import generate_password_hash, check_password_hash
from dotenv import load_dotenv
from models.db import get_db

load_dotenv()
logger = logging.getLogger(__name__)

SESSION_SECRET = os.getenv("SESSION_SECRET", os.getenv("SUPABASE_SERVICE_ROLE_KEY", "fallback-secret-change-me"))
USE_SUPABASE = os.getenv("USE_SUPABASE", "false").lower() == "true"


def create_session_cookie(user_id, role, name, qualification=None):
    payload = {"user_id": user_id, "role": role, "name": name, "qualification": qualification, "exp": time.time() + 86400 * 30}
    body = json.dumps(payload, separators=(",", ":"))
    sig = hmac.new(SESSION_SECRET.encode(), body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{sig}"


def verify_session_cookie(cookie):
    try:
        if not cookie:
            return None
        body, sig = cookie.rsplit(".", 1)
        expected = hmac.new(SESSION_SECRET.encode(), body.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            return None
        payload = json.loads(body)
        if payload.get("exp", 0) < time.time():
            return None
        return payload
    except Exception:
        return None


class AuthManager:
    def __init__(self):
        self.db = get_db()
        if USE_SUPABASE:
            from supabase import create_client
            self.supabase = create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_ANON_KEY"))

    def signup(self, email, password, role, profile):
        """Sign up a user. Returns (user, session_cookie) or raises on error."""
        user_id = str(uuid.uuid4())
        password_hash = generate_password_hash(password)
        user = self.db.create_user(user_id, email, password_hash, role)
        if not user:
            raise ValueError("User creation failed")
        prof = {"user_id": user_id, "name": profile.get("name", ""), **{k: profile.get(k) for k in ("qualification","dob","id_type","id_number","medical_history","allergies","conditions","treatments","gender","blood_group","height","weight","blood_pressure","medications","family_history","surgeries","vaccination","smoking","alcohol","exercise","diet","emergency_name","emergency_phone")}}
        self.db.upsert_profile(prof)
        role_label = profile.get("role_label", role)
        cookie = create_session_cookie(user_id, role, profile.get("name", ""))
        return user, cookie

    def login(self, email, password):
        """Login. Returns (user, session_cookie) or None."""
        user = self.db.get_user_by_email(email)
        if not user or not check_password_hash(user["password_hash"], password):
            return None
        profile = self.db.get_profile(user["id"])
        name = profile["name"] if profile else ""
        qualification = profile.get("qualification") if profile else None
        cookie = create_session_cookie(user["id"], user["role"], name, qualification)
        return user, cookie

    def logout(self, cookie):
        if USE_SUPABASE and hasattr(self, "supabase"):
            try:
                self.supabase.auth.sign_out()
            except Exception:
                pass
        return None

    def get_current_user(self, cookie):
        payload = verify_session_cookie(cookie)
        if not payload:
            return None
        return self.db.get_user(payload["user_id"])

    def get_session_payload(self, cookie):
        return verify_session_cookie(cookie)
