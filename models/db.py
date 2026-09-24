import os
import json
import sqlite3
import uuid
import logging
from datetime import datetime, timezone
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

USE_SUPABASE = os.getenv("USE_SUPABASE", "true").lower() == "true"

_TRIAGE_LIST_FIELDS = ("chief_complaints", "red_flags", "missing_info", "followup_questions", "tests")
_RX_LIST_FIELDS = ("items", "warnings")

_SOAP_COLS = ("id", "triage_session_id", "patient_id", "doctor_id", "subjective",
              "objective", "assessment", "plan", "full_text", "status", "source",
              "signed_at", "created_at", "updated_at")
_RX_COLS = ("id", "patient_id", "doctor_id", "triage_session_id", "items", "warnings",
            "advice", "status", "signed_at", "created_at", "updated_at")
_LAB_COLS = ("id", "user_id", "triage_session_id", "filename", "flags", "created_at")


def _json_list(v):
    if isinstance(v, (list, tuple)):
        return json.dumps(list(v), ensure_ascii=False)
    return None


def _as_list(v):
    if isinstance(v, str):
        try:
            out = json.loads(v)
            return out if isinstance(out, list) else []
        except Exception:
            return []
    return v if isinstance(v, list) else []


def _decode_rx_row(d):
    out = dict(d)
    for k in _RX_LIST_FIELDS:
        out[k] = _as_list(out.get(k))
    return out


def _encode_triage_row(row):
    out = dict(row)
    for k in _TRIAGE_LIST_FIELDS:
        v = out.get(k)
        if isinstance(v, (list, tuple)):
            out[k] = json.dumps(list(v), ensure_ascii=False)
        elif v is None:
            out[k] = "[]"
    out["consent"] = bool(out.get("consent"))
    return out


def _decode_triage_row(d):
    out = dict(d)
    for k in _TRIAGE_LIST_FIELDS:
        v = out.get(k)
        if isinstance(v, str):
            try:
                out[k] = json.loads(v)
            except Exception:
                out[k] = []
        elif not isinstance(v, list):
            out[k] = []
    out["consent"] = bool(out.get("consent"))
    return out


class Database:
    """Abstract database interface."""

    def get_user(self, user_id):
        raise NotImplementedError

    def get_user_by_email(self, email):
        raise NotImplementedError

    def create_user(self, user_id, email, password_hash, role):
        raise NotImplementedError

    def update_user_status(self, user_id, status):
        raise NotImplementedError

    def get_profile(self, user_id):
        raise NotImplementedError

    def upsert_profile(self, profile):
        raise NotImplementedError

    def get_doctor_instructions(self, doctor_id, patient_id=None):
        raise NotImplementedError

    def add_instruction(self, instruction):
        raise NotImplementedError

    def add_message(self, user_id, role, content, agent=None):
        raise NotImplementedError

    def get_chat_history(self, user_id, limit=20):
        raise NotImplementedError

    def get_patient_instructions(self, patient_id):
        raise NotImplementedError

    def add_checkup_request(self, patient_id, package, preferred_date, notes):
        raise NotImplementedError

    def get_latest_checkup(self, patient_id):
        raise NotImplementedError

    def get_checkups(self, patient_id=None):
        raise NotImplementedError

    def update_checkup_status(self, checkup_id, status):
        raise NotImplementedError

    def upsert_triage_session(self, session):
        raise NotImplementedError

    def get_triage_sessions(self, limit=200):
        raise NotImplementedError

    def update_triage_session_status(self, session_id, status, follow_up_date=None):
        raise NotImplementedError

    def get_doctors(self):
        raise NotImplementedError

    def get_availability(self, doctor_id):
        raise NotImplementedError

    def add_availability(self, doctor_id, date, start_time, end_time, max_slots=1):
        raise NotImplementedError

    def book_call(self, patient_id, doctor_id, availability_id, scheduled_at, notes=""):
        raise NotImplementedError

    def get_bookings(self, user_id, role):
        raise NotImplementedError

    def update_booking_status(self, booking_id, status):
        raise NotImplementedError

    def get_triage_session(self, session_id):
        raise NotImplementedError

    def save_soap_note(self, note):
        raise NotImplementedError

    def get_soap_note(self, note_id):
        raise NotImplementedError

    def get_soap_note_by_session(self, triage_session_id):
        raise NotImplementedError

    def update_soap_note(self, note_id, updates):
        raise NotImplementedError

    def save_prescription(self, rx):
        raise NotImplementedError

    def get_prescription(self, rx_id):
        raise NotImplementedError

    def update_prescription(self, rx_id, updates):
        raise NotImplementedError

    def list_prescriptions(self, patient_id=None, limit=50):
        raise NotImplementedError

    def insert_lab_result(self, user_id, flags, triage_session_id=None, filename=""):
        raise NotImplementedError

    def get_recent_lab_results(self, user_id=None, limit=100):
        raise NotImplementedError


class SQLiteDB(Database):
    """SQLite backend (default, zero external dependencies)."""

    def __init__(self, db_path=None):
        if db_path is None:
            _data_dir = os.getenv("DATA_DIR", "./data").rstrip("/\\")
            db_path = os.path.join(_data_dir, "medical.db")
        self.db_path = db_path
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        self._init_schema()

    def _connect(self):
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = 30000")
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def _init_schema(self):
        conn = self._connect()
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('patient','doctor','nurse')),
            status TEXT NOT NULL DEFAULT 'active',
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS profiles (
            user_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            qualification TEXT,
            dob TEXT,
            id_type TEXT,
            id_number TEXT,
            medical_history TEXT,
            allergies TEXT,
            conditions TEXT,
            treatments TEXT,
            gender TEXT,
            blood_group TEXT,
            height TEXT,
            weight TEXT,
            blood_pressure TEXT,
            medications TEXT,
            family_history TEXT,
            surgeries TEXT,
            vaccination TEXT,
            smoking TEXT,
            alcohol TEXT,
            exercise TEXT,
            diet TEXT,
            emergency_name TEXT,
            emergency_phone TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS doctor_instructions (
            id TEXT PRIMARY KEY,
            doctor_id TEXT NOT NULL,
            patient_id TEXT NOT NULL,
            instruction_text TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (doctor_id) REFERENCES users(id),
            FOREIGN KEY (patient_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS chat_messages (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('user','assistant')),
            content TEXT NOT NULL,
            agent TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS health_checkups (
            id TEXT PRIMARY KEY,
            patient_id TEXT NOT NULL,
            package TEXT NOT NULL DEFAULT 'full_body',
            preferred_date TEXT,
            notes TEXT DEFAULT '',
            status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','scheduled','completed')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (patient_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS triage_sessions (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            anonym_code TEXT NOT NULL DEFAULT '',
            facility TEXT DEFAULT '',
            scenario TEXT DEFAULT '',
            facility_name TEXT DEFAULT '',
            age_band TEXT DEFAULT '',
            sex TEXT DEFAULT '',
            lang TEXT DEFAULT '',
            narrative TEXT DEFAULT '',
            risk TEXT DEFAULT 'standard',
            score INTEGER DEFAULT 0,
            summary TEXT DEFAULT '',
            timeline TEXT DEFAULT '',
            chief_complaints TEXT DEFAULT '[]',
            red_flags TEXT DEFAULT '[]',
            missing_info TEXT DEFAULT '[]',
            followup_questions TEXT DEFAULT '[]',
            tests TEXT DEFAULT '[]',
            follow_up_date TEXT,
            consent INTEGER DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','scheduled','completed')),
            src TEXT DEFAULT 'local',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS doctor_availability (
            id TEXT PRIMARY KEY,
            doctor_id TEXT NOT NULL,
            date DATE NOT NULL,
            start_time TIME NOT NULL,
            end_time TIME NOT NULL,
            max_slots INTEGER DEFAULT 1,
            created_at TEXT NOT NULL,
            FOREIGN KEY (doctor_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS call_bookings (
            id TEXT PRIMARY KEY,
            patient_id TEXT NOT NULL,
            doctor_id TEXT NOT NULL,
            availability_id TEXT,
            scheduled_at TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','confirmed','completed','cancelled')),
            notes TEXT DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (patient_id) REFERENCES users(id),
            FOREIGN KEY (doctor_id) REFERENCES users(id),
            FOREIGN KEY (availability_id) REFERENCES doctor_availability(id)
        );
        CREATE TABLE IF NOT EXISTS soap_notes (
            id TEXT PRIMARY KEY,
            triage_session_id TEXT NOT NULL,
            patient_id TEXT,
            doctor_id TEXT,
            subjective TEXT DEFAULT '',
            objective TEXT DEFAULT '',
            assessment TEXT DEFAULT '',
            plan TEXT DEFAULT '',
            full_text TEXT DEFAULT '',
            status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','signed')),
            source TEXT DEFAULT 'triage',
            signed_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS prescriptions (
            id TEXT PRIMARY KEY,
            patient_id TEXT NOT NULL,
            doctor_id TEXT,
            triage_session_id TEXT,
            items TEXT DEFAULT '[]',
            warnings TEXT DEFAULT '[]',
            advice TEXT DEFAULT '',
            status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','signed')),
            signed_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS lab_results (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            triage_session_id TEXT,
            filename TEXT DEFAULT '',
            flags TEXT DEFAULT '[]',
            created_at TEXT NOT NULL
        );
        """)
        conn.commit()
        self._migrate_columns(conn)
        conn.close()
        logger.info("SQLite schema initialized")

    # Columns added to profiles after the first release; existing DB files get them via ALTER TABLE.
    _PROFILE_MIGRATION_COLS = (
        ("gender", "TEXT"), ("blood_group", "TEXT"), ("height", "TEXT"), ("weight", "TEXT"),
        ("blood_pressure", "TEXT"), ("medications", "TEXT"), ("family_history", "TEXT"),
        ("surgeries", "TEXT"), ("vaccination", "TEXT"), ("smoking", "TEXT"), ("alcohol", "TEXT"),
        ("exercise", "TEXT"), ("diet", "TEXT"), ("emergency_name", "TEXT"), ("emergency_phone", "TEXT"),
    )

    def _migrate_columns(self, conn):
        existing = {r[1] for r in conn.execute("PRAGMA table_info(profiles)").fetchall()}
        for col, col_type in self._PROFILE_MIGRATION_COLS:
            if col not in existing:
                try:
                    conn.execute(f"ALTER TABLE profiles ADD COLUMN {col} {col_type}")
                except Exception as e:
                    logger.warning(f"profiles migration skipped column {col}: {e}")
        conn.commit()

    def _now(self):
        return datetime.now(timezone.utc).isoformat()

    def get_user(self, user_id):
        conn = self._connect(); row = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone(); conn.close()
        return dict(row) if row else None

    def get_user_by_email(self, email):
        conn = self._connect(); row = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone(); conn.close()
        return dict(row) if row else None

    def create_user(self, user_id, email, password_hash, role):
        conn = self._connect()
        conn.execute("INSERT INTO users (id,email,password_hash,role,status,created_at) VALUES (?,?,?,?,?,?)",
                     (user_id, email, password_hash, role, "active", self._now()))
        conn.commit(); conn.close()
        return self.get_user(user_id)

    def update_user_status(self, user_id, status):
        conn = self._connect(); conn.execute("UPDATE users SET status=? WHERE id=?", (status, user_id)); conn.commit(); conn.close()

    def get_profile(self, user_id):
        conn = self._connect(); row = conn.execute("SELECT * FROM profiles WHERE user_id=?", (user_id,)).fetchone(); conn.close()
        return dict(row) if row else None

    def upsert_profile(self, profile):
        conn = self._connect()
        conn.execute("""INSERT INTO profiles (user_id,name,qualification,dob,id_type,id_number,medical_history,allergies,conditions,treatments,
                        gender,blood_group,height,weight,blood_pressure,medications,family_history,surgeries,vaccination,
                        smoking,alcohol,exercise,diet,emergency_name,emergency_phone,created_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                        ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,qualification=excluded.qualification,dob=excluded.dob,
                        id_type=excluded.id_type,id_number=excluded.id_number,medical_history=excluded.medical_history,
                        allergies=excluded.allergies,conditions=excluded.conditions,treatments=excluded.treatments,
                        gender=excluded.gender,blood_group=excluded.blood_group,height=excluded.height,weight=excluded.weight,
                        blood_pressure=excluded.blood_pressure,medications=excluded.medications,family_history=excluded.family_history,
                        surgeries=excluded.surgeries,vaccination=excluded.vaccination,smoking=excluded.smoking,alcohol=excluded.alcohol,
                        exercise=excluded.exercise,diet=excluded.diet,emergency_name=excluded.emergency_name,emergency_phone=excluded.emergency_phone""",
                     (profile['user_id'], profile['name'], profile.get('qualification'), profile.get('dob'),
                      profile.get('id_type'), profile.get('id_number'), profile.get('medical_history'),
                      profile.get('allergies'), profile.get('conditions'), profile.get('treatments'),
                      profile.get('gender'), profile.get('blood_group'), profile.get('height'), profile.get('weight'),
                      profile.get('blood_pressure'), profile.get('medications'), profile.get('family_history'),
                      profile.get('surgeries'), profile.get('vaccination'), profile.get('smoking'), profile.get('alcohol'),
                      profile.get('exercise'), profile.get('diet'), profile.get('emergency_name'), profile.get('emergency_phone'),
                      self._now()))
        conn.commit(); conn.close()

    def get_doctor_instructions(self, doctor_id, patient_id=None):
        conn = self._connect()
        if patient_id:
            rows = conn.execute("SELECT * FROM doctor_instructions WHERE doctor_id=? AND patient_id=?", (doctor_id, patient_id)).fetchall()
        else:
            rows = conn.execute("SELECT * FROM doctor_instructions WHERE doctor_id=?", (doctor_id,)).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    def add_instruction(self, instruction):
        conn = self._connect()
        conn.execute("INSERT INTO doctor_instructions (id,doctor_id,patient_id,instruction_text,created_at) VALUES (?,?,?,?,?)",
                     (instruction['id'], instruction['doctor_id'], instruction['patient_id'], instruction['instruction_text'], self._now()))
        conn.commit(); conn.close()
        return instruction

    def add_message(self, user_id, role, content, agent=None):
        msg_id = str(uuid.uuid4())
        conn = self._connect()
        conn.execute("INSERT INTO chat_messages (id,user_id,role,content,agent,created_at) VALUES (?,?,?,?,?,?)",
                     (msg_id, user_id, role, content, agent, self._now()))
        conn.commit(); conn.close()
        return {"id": msg_id, "user_id": user_id, "role": role, "content": content, "agent": agent}

    def get_chat_history(self, user_id, limit=20):
        conn = self._connect()
        rows = conn.execute(
            "SELECT * FROM chat_messages WHERE user_id=? ORDER BY created_at DESC LIMIT ?",
            (user_id, limit)
        ).fetchall()
        conn.close()
        return [dict(r) for r in reversed(rows)]

    def get_patient_instructions(self, patient_id):
        conn = self._connect()
        rows = conn.execute(
            "SELECT * FROM doctor_instructions WHERE patient_id=? ORDER BY created_at DESC",
            (patient_id,)
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    def add_checkup_request(self, patient_id, package="full_body", preferred_date=None, notes=""):
        checkup_id = str(uuid.uuid4())
        now = self._now()
        conn = self._connect()
        conn.execute(
            "INSERT INTO health_checkups (id,patient_id,package,preferred_date,notes,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
            (checkup_id, patient_id, package, preferred_date, notes, "requested", now, now)
        )
        conn.commit(); conn.close()
        return {"id": checkup_id, "patient_id": patient_id, "package": package,
                "preferred_date": preferred_date, "notes": notes, "status": "requested",
                "created_at": now, "updated_at": now}

    def get_latest_checkup(self, patient_id):
        conn = self._connect()
        row = conn.execute(
            "SELECT * FROM health_checkups WHERE patient_id=? ORDER BY created_at DESC LIMIT 1",
            (patient_id,)
        ).fetchone()
        conn.close()
        return dict(row) if row else None

    def get_checkups(self, patient_id=None):
        conn = self._connect()
        if patient_id:
            rows = conn.execute(
                "SELECT * FROM health_checkups WHERE patient_id=? ORDER BY created_at DESC",
                (patient_id,)
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM health_checkups ORDER BY created_at DESC").fetchall()
        conn.close()
        return [dict(r) for r in rows]

    def update_checkup_status(self, checkup_id, status):
        conn = self._connect()
        cur = conn.execute(
            "UPDATE health_checkups SET status=?, updated_at=? WHERE id=?",
            (status, self._now(), checkup_id)
        )
        conn.commit(); conn.close()
        return cur.rowcount > 0

    _TRIAGE_COLS = ("id", "user_id", "anonym_code", "facility", "scenario", "facility_name",
                    "age_band", "sex", "lang", "narrative", "risk", "score", "summary", "timeline",
                    "chief_complaints", "red_flags", "missing_info", "followup_questions", "tests",
                    "follow_up_date", "consent", "status", "src", "created_at", "updated_at")

    def upsert_triage_session(self, session):
        row = _encode_triage_row({k: session.get(k) for k in self._TRIAGE_COLS})
        row["id"] = str(row.get("id") or uuid.uuid4())
        row["created_at"] = row.get("created_at") or self._now()
        row["updated_at"] = session.get("updated_at") or self._now()
        row["consent"] = 1 if row.get("consent") else 0
        cols = ",".join(self._TRIAGE_COLS)
        placeholders = ",".join("?" for _ in self._TRIAGE_COLS)
        update_set = ",".join(f"{c}=excluded.{c}" for c in self._TRIAGE_COLS if c not in ("id", "created_at"))
        conn = self._connect()
        conn.execute(
            f"INSERT INTO triage_sessions ({cols}) VALUES ({placeholders}) "
            f"ON CONFLICT(id) DO UPDATE SET {update_set}",
            tuple(row.get(c) for c in self._TRIAGE_COLS)
        )
        conn.commit()
        r = conn.execute("SELECT * FROM triage_sessions WHERE id=?", (row["id"],)).fetchone()
        conn.close()
        return _decode_triage_row(dict(r)) if r else None

    def get_triage_sessions(self, limit=200):
        conn = self._connect()
        rows = conn.execute(
            "SELECT * FROM triage_sessions ORDER BY created_at DESC LIMIT ?",
            (limit,)
        ).fetchall()
        conn.close()
        return [_decode_triage_row(dict(r)) for r in rows]

    def update_triage_session_status(self, session_id, status, follow_up_date=None):
        conn = self._connect()
        if follow_up_date is None:
            cur = conn.execute(
                "UPDATE triage_sessions SET status=?, updated_at=? WHERE id=?",
                (status, self._now(), session_id)
            )
        else:
            cur = conn.execute(
                "UPDATE triage_sessions SET status=?, follow_up_date=?, updated_at=? WHERE id=?",
                (status, follow_up_date, self._now(), session_id)
            )
        conn.commit(); conn.close()
        return cur.rowcount > 0

    def get_doctors(self):
        conn = self._connect()
        rows = conn.execute("SELECT u.id, u.email, u.role, u.status, u.created_at, p.name, p.qualification FROM users u LEFT JOIN profiles p ON p.user_id=u.id WHERE u.role='doctor' ORDER BY u.created_at DESC").fetchall()
        conn.close()
        return [dict(r) for r in rows]

    def get_availability(self, doctor_id):
        conn = self._connect()
        rows = conn.execute("SELECT * FROM doctor_availability WHERE doctor_id=? ORDER BY date, start_time", (doctor_id,)).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    def add_availability(self, doctor_id, date, start_time, end_time, max_slots=1):
        avail_id = str(uuid.uuid4())
        now = self._now()
        conn = self._connect()
        conn.execute("INSERT INTO doctor_availability (id,doctor_id,date,start_time,end_time,max_slots,created_at) VALUES (?,?,?,?,?,?,?)",
                     (avail_id, doctor_id, date, start_time, end_time, max_slots, now))
        conn.commit(); conn.close()
        return {"id": avail_id, "doctor_id": doctor_id, "date": date, "start_time": start_time, "end_time": end_time, "max_slots": max_slots, "created_at": now}

    def book_call(self, patient_id, doctor_id, availability_id, scheduled_at, notes=""):
        booking_id = str(uuid.uuid4())
        now = self._now()
        conn = self._connect()
        conn.execute("INSERT INTO call_bookings (id,patient_id,doctor_id,availability_id,scheduled_at,status,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
                     (booking_id, patient_id, doctor_id, availability_id, scheduled_at, "requested", notes, now, now))
        conn.commit(); conn.close()
        return {"id": booking_id, "patient_id": patient_id, "doctor_id": doctor_id, "availability_id": availability_id, "scheduled_at": scheduled_at, "status": "requested", "notes": notes, "created_at": now, "updated_at": now}

    def get_bookings(self, user_id, role):
        conn = self._connect()
        if role == 'doctor':
            rows = conn.execute("SELECT cb.*, u.name as patient_name, u.email as patient_email FROM call_bookings cb LEFT JOIN users u ON u.id=cb.patient_id WHERE cb.doctor_id=? ORDER BY cb.scheduled_at DESC", (user_id,)).fetchall()
        else:
            rows = conn.execute("SELECT cb.*, u.name as doctor_name, u.email as doctor_email FROM call_bookings cb LEFT JOIN users u ON u.id=cb.doctor_id WHERE cb.patient_id=? ORDER BY cb.scheduled_at DESC", (user_id,)).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    def update_booking_status(self, booking_id, status):
        conn = self._connect()
        cur = conn.execute("UPDATE call_bookings SET status=?, updated_at=? WHERE id=?", (status, self._now(), booking_id))
        conn.commit(); conn.close()
        return cur.rowcount > 0

    def get_triage_session(self, session_id):
        conn = self._connect()
        row = conn.execute("SELECT * FROM triage_sessions WHERE id=?", (session_id,)).fetchone()
        conn.close()
        return _decode_triage_row(dict(row)) if row else None

    def save_soap_note(self, note):
        row = {k: note.get(k) for k in _SOAP_COLS}
        row["id"] = str(row.get("id") or uuid.uuid4())
        row["created_at"] = row.get("created_at") or self._now()
        row["updated_at"] = self._now()
        row["status"] = row.get("status") or "draft"
        cols = ",".join(_SOAP_COLS)
        placeholders = ",".join("?" for _ in _SOAP_COLS)
        update_set = ",".join(f"{c}=excluded.{c}" for c in _SOAP_COLS if c not in ("id", "created_at"))
        conn = self._connect()
        conn.execute(
            f"INSERT INTO soap_notes ({cols}) VALUES ({placeholders}) ON CONFLICT(id) DO UPDATE SET {update_set}",
            tuple(row.get(c) for c in _SOAP_COLS)
        )
        conn.commit()
        r = conn.execute("SELECT * FROM soap_notes WHERE id=?", (row["id"],)).fetchone()
        conn.close()
        return dict(r) if r else None

    def get_soap_note(self, note_id):
        conn = self._connect()
        row = conn.execute("SELECT * FROM soap_notes WHERE id=?", (note_id,)).fetchone()
        conn.close()
        return dict(row) if row else None

    def get_soap_note_by_session(self, triage_session_id):
        conn = self._connect()
        row = conn.execute(
            "SELECT * FROM soap_notes WHERE triage_session_id=? ORDER BY updated_at DESC LIMIT 1",
            (triage_session_id,)
        ).fetchone()
        conn.close()
        return dict(row) if row else None

    def update_soap_note(self, note_id, updates):
        allowed = {k: v for k, v in (updates or {}).items()
                   if k in _SOAP_COLS and k not in ("id", "created_at")}
        conn = self._connect()
        if allowed:
            allowed["updated_at"] = self._now()
            set_sql = ",".join(f"{k}=?" for k in allowed)
            conn.execute(f"UPDATE soap_notes SET {set_sql} WHERE id=?", (*allowed.values(), note_id))
            conn.commit()
        row = conn.execute("SELECT * FROM soap_notes WHERE id=?", (note_id,)).fetchone()
        conn.close()
        return dict(row) if row else None

    def save_prescription(self, rx):
        row = {k: rx.get(k) for k in _RX_COLS}
        row["id"] = str(row.get("id") or uuid.uuid4())
        row["created_at"] = row.get("created_at") or self._now()
        row["updated_at"] = self._now()
        row["status"] = row.get("status") or "draft"
        for k in _RX_LIST_FIELDS:
            row[k] = _json_list(row.get(k)) or "[]"
        cols = ",".join(_RX_COLS)
        placeholders = ",".join("?" for _ in _RX_COLS)
        update_set = ",".join(f"{c}=excluded.{c}" for c in _RX_COLS if c not in ("id", "created_at"))
        conn = self._connect()
        conn.execute(
            f"INSERT INTO prescriptions ({cols}) VALUES ({placeholders}) ON CONFLICT(id) DO UPDATE SET {update_set}",
            tuple(row.get(c) for c in _RX_COLS)
        )
        conn.commit()
        r = conn.execute("SELECT * FROM prescriptions WHERE id=?", (row["id"],)).fetchone()
        conn.close()
        return _decode_rx_row(dict(r)) if r else None

    def get_prescription(self, rx_id):
        conn = self._connect()
        row = conn.execute("SELECT * FROM prescriptions WHERE id=?", (rx_id,)).fetchone()
        conn.close()
        return _decode_rx_row(dict(row)) if row else None

    def update_prescription(self, rx_id, updates):
        allowed = {k: v for k, v in (updates or {}).items()
                   if k in _RX_COLS and k not in ("id", "created_at")}
        for k in _RX_LIST_FIELDS:
            if k in allowed:
                allowed[k] = _json_list(allowed.get(k)) or "[]"
        conn = self._connect()
        if allowed:
            allowed["updated_at"] = self._now()
            set_sql = ",".join(f"{k}=?" for k in allowed)
            conn.execute(f"UPDATE prescriptions SET {set_sql} WHERE id=?", (*allowed.values(), rx_id))
            conn.commit()
        row = conn.execute("SELECT * FROM prescriptions WHERE id=?", (rx_id,)).fetchone()
        conn.close()
        return _decode_rx_row(dict(row)) if row else None

    def list_prescriptions(self, patient_id=None, limit=50):
        conn = self._connect()
        if patient_id:
            rows = conn.execute(
                "SELECT * FROM prescriptions WHERE patient_id=? ORDER BY created_at DESC LIMIT ?",
                (patient_id, limit)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM prescriptions ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
        conn.close()
        return [_decode_rx_row(dict(r)) for r in rows]

    def insert_lab_result(self, user_id, flags, triage_session_id=None, filename=""):
        lab_id = str(uuid.uuid4())
        row = {"id": lab_id, "user_id": user_id, "triage_session_id": triage_session_id,
               "filename": filename or "", "flags": _json_list(flags) or "[]",
               "created_at": self._now()}
        conn = self._connect()
        conn.execute(
            "INSERT INTO lab_results (id,user_id,triage_session_id,filename,flags,created_at) VALUES (?,?,?,?,?,?)",
            (row["id"], row["user_id"], row["triage_session_id"], row["filename"], row["flags"], row["created_at"])
        )
        conn.commit(); conn.close()
        row["flags"] = _as_list(row["flags"])
        return row

    def get_recent_lab_results(self, user_id=None, limit=100):
        conn = self._connect()
        if user_id:
            rows = conn.execute(
                "SELECT * FROM lab_results WHERE user_id=? ORDER BY created_at DESC LIMIT ?",
                (user_id, limit)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM lab_results ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
        conn.close()
        out = []
        for r in rows:
            d = dict(r)
            d["flags"] = _as_list(d.get("flags"))
            out.append(d)
        return out


class SupabaseDB(Database):
    """Supabase backend (requires SUPABASE_URL + keys in .env)."""

    def __init__(self):
        from supabase import create_client
        self.url = os.getenv("SUPABASE_URL", "https://uzabcdtnqkcwavyjtujw.supabase.co")
        self.anon_key = os.getenv("SUPABASE_ANON_KEY", "sb_publishable_6p4qWC6HA30yFgBL3aC5RA_n-kfqrfl")
        self.service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        self.postgres_uri = os.getenv("SUPABASE_POSTGRES_URI")
        self.client = create_client(self.url, self.anon_key)
        self._ensure_schema()
        logger.info("Supabase DB initialized")

    def _ensure_schema(self):
        if not self.postgres_uri:
            logger.warning("SUPABASE_POSTGRES_URI not set; tables must be created via Supabase SQL Editor")
            return
        import psycopg2
        try:
            conn = psycopg2.connect(self.postgres_uri, connect_timeout=5)
            cur = conn.cursor()
            cur.execute(open(os.path.join(os.path.dirname(__file__), "schema.sql")).read())
            cur.execute(self._rls_sql())
            conn.commit(); cur.close(); conn.close()
            logger.info("Supabase schema + RLS policies created/verified")
        except Exception as e:
            logger.error(f"Supabase schema creation failed: {e}")

    @staticmethod
    def _rls_sql():
        return """
        ALTER TABLE users ENABLE ROW LEVEL SECURITY;
        ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
        ALTER TABLE doctor_instructions ENABLE ROW LEVEL SECURITY;
        ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
        ALTER TABLE health_checkups ENABLE ROW LEVEL SECURITY;
        DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'users'::regclass AND polname = 'users_select')
            THEN CREATE POLICY "users_select" ON users FOR SELECT USING (true); END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'users'::regclass AND polname = 'users_insert')
            THEN CREATE POLICY "users_insert" ON users FOR INSERT WITH CHECK (true); END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'users'::regclass AND polname = 'users_update')
            THEN CREATE POLICY "users_update" ON users FOR UPDATE USING (true); END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'users'::regclass AND polname = 'users_delete')
            THEN CREATE POLICY "users_delete" ON users FOR DELETE USING (true); END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'profiles'::regclass AND polname = 'profiles_select')
            THEN CREATE POLICY "profiles_select" ON profiles FOR SELECT USING (true); END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'profiles'::regclass AND polname = 'profiles_insert')
            THEN CREATE POLICY "profiles_insert" ON profiles FOR INSERT WITH CHECK (true); END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'profiles'::regclass AND polname = 'profiles_update')
            THEN CREATE POLICY "profiles_update" ON profiles FOR UPDATE USING (true); END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'doctor_instructions'::regclass AND polname = 'doctor_instructions_select')
            THEN CREATE POLICY "doctor_instructions_select" ON doctor_instructions FOR SELECT USING (true); END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'doctor_instructions'::regclass AND polname = 'doctor_instructions_insert')
            THEN CREATE POLICY "doctor_instructions_insert" ON doctor_instructions FOR INSERT WITH CHECK (true); END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'doctor_instructions'::regclass AND polname = 'doctor_instructions_update')
            THEN CREATE POLICY "doctor_instructions_update" ON doctor_instructions FOR UPDATE USING (true); END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'chat_messages'::regclass AND polname = 'chat_messages_select')
            THEN CREATE POLICY "chat_messages_select" ON chat_messages FOR SELECT USING (true); END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'chat_messages'::regclass AND polname = 'chat_messages_insert')
            THEN CREATE POLICY "chat_messages_insert" ON chat_messages FOR INSERT WITH CHECK (true); END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'chat_messages'::regclass AND polname = 'chat_messages_delete')
            THEN CREATE POLICY "chat_messages_delete" ON chat_messages FOR DELETE USING (true); END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'health_checkups'::regclass AND polname = 'health_checkups_select')
            THEN CREATE POLICY "health_checkups_select" ON health_checkups FOR SELECT USING (true); END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'health_checkups'::regclass AND polname = 'health_checkups_insert')
            THEN CREATE POLICY "health_checkups_insert" ON health_checkups FOR INSERT WITH CHECK (true); END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'health_checkups'::regclass AND polname = 'health_checkups_update')
            THEN CREATE POLICY "health_checkups_update" ON health_checkups FOR UPDATE USING (true); END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'health_checkups'::regclass AND polname = 'health_checkups_delete')
            THEN CREATE POLICY "health_checkups_delete" ON health_checkups FOR DELETE USING (true); END IF;
            ALTER TABLE triage_sessions ENABLE ROW LEVEL SECURITY;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'triage_sessions'::regclass AND polname = 'triage_sessions_select')
            THEN CREATE POLICY "triage_sessions_select" ON triage_sessions FOR SELECT USING (true); END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'triage_sessions'::regclass AND polname = 'triage_sessions_insert')
            THEN CREATE POLICY "triage_sessions_insert" ON triage_sessions FOR INSERT WITH CHECK (true); END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'triage_sessions'::regclass AND polname = 'triage_sessions_update')
            THEN CREATE POLICY "triage_sessions_update" ON triage_sessions FOR UPDATE USING (true); END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'triage_sessions'::regclass AND polname = 'triage_sessions_delete')
            THEN CREATE POLICY "triage_sessions_delete" ON triage_sessions FOR DELETE USING (true); END IF;
            ALTER TABLE doctor_availability ENABLE ROW LEVEL SECURITY;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'doctor_availability'::regclass AND polname = 'doctor_availability_select')
            THEN CREATE POLICY "doctor_availability_select" ON doctor_availability FOR SELECT USING (true); END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'doctor_availability'::regclass AND polname = 'doctor_availability_insert')
            THEN CREATE POLICY "doctor_availability_insert" ON doctor_availability FOR INSERT WITH CHECK (true); END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'doctor_availability'::regclass AND polname = 'doctor_availability_update')
            THEN CREATE POLICY "doctor_availability_update" ON doctor_availability FOR UPDATE USING (true); END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'doctor_availability'::regclass AND polname = 'doctor_availability_delete')
            THEN CREATE POLICY "doctor_availability_delete" ON doctor_availability FOR DELETE USING (true); END IF;
            ALTER TABLE call_bookings ENABLE ROW LEVEL SECURITY;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'call_bookings'::regclass AND polname = 'call_bookings_select')
            THEN CREATE POLICY "call_bookings_select" ON call_bookings FOR SELECT USING (true); END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'call_bookings'::regclass AND polname = 'call_bookings_insert')
            THEN CREATE POLICY "call_bookings_insert" ON call_bookings FOR INSERT WITH CHECK (true); END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'call_bookings'::regclass AND polname = 'call_bookings_update')
            THEN CREATE POLICY "call_bookings_update" ON call_bookings FOR UPDATE USING (true); END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'call_bookings'::regclass AND polname = 'call_bookings_delete')
            THEN CREATE POLICY "call_bookings_delete" ON call_bookings FOR DELETE USING (true); END IF;
            ALTER TABLE soap_notes ENABLE ROW LEVEL SECURITY;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'soap_notes'::regclass AND polname = 'soap_notes_select')
            THEN CREATE POLICY "soap_notes_select" ON soap_notes FOR SELECT USING (true); END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'soap_notes'::regclass AND polname = 'soap_notes_insert')
            THEN CREATE POLICY "soap_notes_insert" ON soap_notes FOR INSERT WITH CHECK (true); END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'soap_notes'::regclass AND polname = 'soap_notes_update')
            THEN CREATE POLICY "soap_notes_update" ON soap_notes FOR UPDATE USING (true); END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'soap_notes'::regclass AND polname = 'soap_notes_delete')
            THEN CREATE POLICY "soap_notes_delete" ON soap_notes FOR DELETE USING (true); END IF;
            ALTER TABLE prescriptions ENABLE ROW LEVEL SECURITY;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'prescriptions'::regclass AND polname = 'prescriptions_select')
            THEN CREATE POLICY "prescriptions_select" ON prescriptions FOR SELECT USING (true); END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'prescriptions'::regclass AND polname = 'prescriptions_insert')
            THEN CREATE POLICY "prescriptions_insert" ON prescriptions FOR INSERT WITH CHECK (true); END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'prescriptions'::regclass AND polname = 'prescriptions_update')
            THEN CREATE POLICY "prescriptions_update" ON prescriptions FOR UPDATE USING (true); END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'prescriptions'::regclass AND polname = 'prescriptions_delete')
            THEN CREATE POLICY "prescriptions_delete" ON prescriptions FOR DELETE USING (true); END IF;
            ALTER TABLE lab_results ENABLE ROW LEVEL SECURITY;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'lab_results'::regclass AND polname = 'lab_results_select')
            THEN CREATE POLICY "lab_results_select" ON lab_results FOR SELECT USING (true); END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'lab_results'::regclass AND polname = 'lab_results_insert')
            THEN CREATE POLICY "lab_results_insert" ON lab_results FOR INSERT WITH CHECK (true); END IF;
        END $$;
        """

    def _now(self):
        return datetime.now(timezone.utc).isoformat()

    def get_user(self, user_id):
        r = self.client.table("users").select("*").eq("id", user_id).execute()
        return r.data[0] if r.data else None

    def get_user_by_email(self, email):
        r = self.client.table("users").select("*").eq("email", email).execute()
        return r.data[0] if r.data else None

    def create_user(self, user_id, email, password_hash, role):
        try:
            r = self.client.table("users").insert({"id": user_id, "email": email, "password_hash": password_hash, "role": role, "status": "active", "created_at": self._now()}).execute()
            if r and r.data and len(r.data) > 0:
                return r.data[0]
            return None
        except Exception as e:
            logger.error(f"Supabase create_user failed: {e}")
            return None

    def update_user_status(self, user_id, status):
        try:
            self.client.table("users").update({"status": status}).eq("id", user_id).execute()
        except Exception as e:
            logger.error(f"Supabase update_user_status failed: {e}")

    def get_profile(self, user_id):
        try:
            r = self.client.table("profiles").select("*").eq("user_id", user_id).execute()
            if r and r.data and len(r.data) > 0:
                return r.data[0]
            return None
        except Exception as e:
            logger.error(f"Supabase get_profile failed: {e}")
            return None

    def upsert_profile(self, profile):
        try:
            prof = dict(profile)
            prof.setdefault("created_at", self._now())
            self.client.table("profiles").upsert(prof).execute()
        except Exception as e:
            logger.error(f"Supabase upsert_profile failed: {e}")

    def get_doctor_instructions(self, doctor_id, patient_id=None):
        try:
            if patient_id:
                r = self.client.table("doctor_instructions").select("*").eq("doctor_id", doctor_id).eq("patient_id", patient_id).execute()
            else:
                r = self.client.table("doctor_instructions").select("*").eq("doctor_id", doctor_id).execute()
            return r.data if r and r.data else []
        except Exception as e:
            logger.error(f"Supabase get_doctor_instructions failed: {e}")
            return []

    def add_instruction(self, instruction):
        try:
            r = self.client.table("doctor_instructions").insert(instruction).execute()
            return r.data[0] if r and r.data and len(r.data) > 0 else None
        except Exception as e:
            logger.error(f"Supabase add_instruction failed: {e}")
            return None

    def add_message(self, user_id, role, content, agent=None):
        msg_id = str(uuid.uuid4())
        try:
            r = self.client.table("chat_messages").insert({
                "id": msg_id, "user_id": user_id, "role": role,
                "content": content, "agent": agent, "created_at": self._now()
            }).execute()
            return {"id": msg_id, "user_id": user_id, "role": role, "content": content, "agent": agent}
        except Exception as e:
            logger.error(f"Supabase add_message failed: {e}")
            return None

    def get_chat_history(self, user_id, limit=20):
        try:
            r = self.client.table("chat_messages").select("*").eq("user_id", user_id) \
                .order("created_at", desc=True).limit(limit).execute()
            if r and r.data:
                return list(reversed(r.data))
            return []
        except Exception as e:
            logger.error(f"Supabase get_chat_history failed: {e}")
            return []

    def get_patient_instructions(self, patient_id):
        try:
            r = self.client.table("doctor_instructions").select("*") \
                .eq("patient_id", patient_id).order("created_at", desc=True).execute()
            return r.data if r and r.data else []
        except Exception as e:
            logger.error(f"Supabase get_patient_instructions failed: {e}")
            return []

    def add_checkup_request(self, patient_id, package="full_body", preferred_date=None, notes=""):
        checkup_id = str(uuid.uuid4())
        now = self._now()
        try:
            r = self.client.table("health_checkups").insert({
                "id": checkup_id, "patient_id": patient_id, "package": package,
                "preferred_date": preferred_date, "notes": notes, "status": "requested",
                "created_at": now, "updated_at": now,
            }).execute()
            return r.data[0] if r and r.data and len(r.data) > 0 else None
        except Exception as e:
            logger.error(f"Supabase add_checkup_request failed: {e}")
            return None

    def get_latest_checkup(self, patient_id):
        try:
            r = self.client.table("health_checkups").select("*").eq("patient_id", patient_id) \
                .order("created_at", desc=True).limit(1).execute()
            return r.data[0] if r and r.data else None
        except Exception as e:
            logger.error(f"Supabase get_latest_checkup failed: {e}")
            return None

    def get_checkups(self, patient_id=None):
        try:
            q = self.client.table("health_checkups").select("*").order("created_at", desc=True)
            if patient_id:
                q = q.eq("patient_id", patient_id)
            r = q.execute()
            return r.data if r and r.data else []
        except Exception as e:
            logger.error(f"Supabase get_checkups failed: {e}")
            return []

    def update_checkup_status(self, checkup_id, status):
        try:
            r = self.client.table("health_checkups") \
                .update({"status": status, "updated_at": self._now()}) \
                .eq("id", checkup_id).execute()
            return bool(r and r.data)
        except Exception as e:
            logger.error(f"Supabase update_checkup_status failed: {e}")
            return False

    def upsert_triage_session(self, session):
        row = _encode_triage_row(session)
        row["id"] = str(row.get("id") or uuid.uuid4())
        row["created_at"] = row.get("created_at") or self._now()
        row["updated_at"] = self._now()
        try:
            r = self.client.table("triage_sessions").upsert(row).execute()
            if r and r.data and len(r.data) > 0:
                return _decode_triage_row(r.data[0])
            return None
        except Exception as e:
            logger.error(f"Supabase upsert_triage_session failed: {e}")
            raise

    def get_triage_sessions(self, limit=200):
        try:
            r = self.client.table("triage_sessions").select("*") \
                .order("created_at", desc=True).limit(limit).execute()
            return [_decode_triage_row(d) for d in (r.data if r and r.data else [])]
        except Exception as e:
            logger.error(f"Supabase get_triage_sessions failed: {e}")
            return []

    def update_triage_session_status(self, session_id, status, follow_up_date=None):
        update = {"status": status, "updated_at": self._now()}
        if follow_up_date is not None:
            update["follow_up_date"] = follow_up_date
        try:
            r = self.client.table("triage_sessions").update(update).eq("id", session_id).execute()
            return bool(r and r.data)
        except Exception as e:
            logger.error(f"Supabase update_triage_session_status failed: {e}")
            return False

    def get_doctors(self):
        try:
            r = self.client.table("users").select("*, profiles(name)").eq("role","doctor").execute()
            doctors = []
            for d in (r.data if r and r.data else []):
                d["name"] = (d.get("profiles") or {}).get("name", "")
                d.pop("profiles", None)
                doctors.append(d)
            return doctors
        except Exception as e:
            logger.error(f"Supabase get_doctors failed: {e}")
            return []

    def get_availability(self, doctor_id):
        try:
            r = self.client.table("doctor_availability").select("*").eq("doctor_id", doctor_id).order("date").execute()
            return r.data if r and r.data else []
        except Exception as e:
            logger.error(f"Supabase get_availability failed: {e}")
            return []

    def add_availability(self, doctor_id, date, start_time, end_time, max_slots=1):
        try:
            avail_id = str(uuid.uuid4())
            now = self._now()
            r = self.client.table("doctor_availability").insert({"id": avail_id, "doctor_id": doctor_id, "date": date, "start_time": start_time, "end_time": end_time, "max_slots": max_slots, "created_at": now}).execute()
            return r.data[0] if r and r.data and len(r.data) > 0 else None
        except Exception as e:
            logger.error(f"Supabase add_availability failed: {e}")
            return None

    def book_call(self, patient_id, doctor_id, availability_id, scheduled_at, notes=""):
        try:
            booking_id = str(uuid.uuid4())
            now = self._now()
            r = self.client.table("call_bookings").insert({"id": booking_id, "patient_id": patient_id, "doctor_id": doctor_id, "availability_id": availability_id, "scheduled_at": scheduled_at, "status": "requested", "notes": notes, "created_at": now, "updated_at": now}).execute()
            return r.data[0] if r and r.data and len(r.data) > 0 else None
        except Exception as e:
            logger.error(f"Supabase book_call failed: {e}")
            return None

    def get_bookings(self, user_id, role):
        try:
            if role == 'doctor':
                r = self.client.table("call_bookings").select("*").eq("doctor_id", user_id).order("scheduled_at", desc=True).execute()
            else:
                r = self.client.table("call_bookings").select("*").eq("patient_id", user_id).order("scheduled_at", desc=True).execute()
            return r.data if r and r.data else []
        except Exception as e:
            logger.error(f"Supabase get_bookings failed: {e}")
            return []

    def update_booking_status(self, booking_id, status):
        try:
            r = self.client.table("call_bookings").update({"status": status, "updated_at": self._now()}).eq("id", booking_id).execute()
            return bool(r and r.data)
        except Exception as e:
            logger.error(f"Supabase update_booking_status failed: {e}")
            return False

    def get_triage_session(self, session_id):
        try:
            r = self.client.table("triage_sessions").select("*").eq("id", session_id).execute()
            return _decode_triage_row(r.data[0]) if r and r.data else None
        except Exception as e:
            logger.error(f"Supabase get_triage_session failed: {e}")
            return None

    def save_soap_note(self, note):
        row = {k: note.get(k) for k in _SOAP_COLS}
        row["id"] = str(row.get("id") or uuid.uuid4())
        row["created_at"] = row.get("created_at") or self._now()
        row["updated_at"] = self._now()
        row["status"] = row.get("status") or "draft"
        try:
            r = self.client.table("soap_notes").upsert(row).execute()
            return r.data[0] if r and r.data else None
        except Exception as e:
            logger.error(f"Supabase save_soap_note failed: {e}")
            return None

    def get_soap_note(self, note_id):
        try:
            r = self.client.table("soap_notes").select("*").eq("id", note_id).execute()
            return r.data[0] if r and r.data else None
        except Exception as e:
            logger.error(f"Supabase get_soap_note failed: {e}")
            return None

    def get_soap_note_by_session(self, triage_session_id):
        try:
            r = self.client.table("soap_notes").select("*") \
                .eq("triage_session_id", triage_session_id) \
                .order("updated_at", desc=True).limit(1).execute()
            return r.data[0] if r and r.data else None
        except Exception as e:
            logger.error(f"Supabase get_soap_note_by_session failed: {e}")
            return None

    def update_soap_note(self, note_id, updates):
        allowed = {k: v for k, v in (updates or {}).items()
                   if k in _SOAP_COLS and k not in ("id", "created_at")}
        if not allowed:
            return self.get_soap_note(note_id)
        allowed["updated_at"] = self._now()
        try:
            r = self.client.table("soap_notes").update(allowed).eq("id", note_id).execute()
            return r.data[0] if r and r.data else None
        except Exception as e:
            logger.error(f"Supabase update_soap_note failed: {e}")
            return None

    def save_prescription(self, rx):
        row = {k: rx.get(k) for k in _RX_COLS}
        row["id"] = str(row.get("id") or uuid.uuid4())
        row["created_at"] = row.get("created_at") or self._now()
        row["updated_at"] = self._now()
        row["status"] = row.get("status") or "draft"
        for k in _RX_LIST_FIELDS:
            row[k] = _json_list(row.get(k)) or "[]"
        try:
            r = self.client.table("prescriptions").upsert(row).execute()
            return _decode_rx_row(r.data[0]) if r and r.data else None
        except Exception as e:
            logger.error(f"Supabase save_prescription failed: {e}")
            return None

    def get_prescription(self, rx_id):
        try:
            r = self.client.table("prescriptions").select("*").eq("id", rx_id).execute()
            return _decode_rx_row(r.data[0]) if r and r.data else None
        except Exception as e:
            logger.error(f"Supabase get_prescription failed: {e}")
            return None

    def update_prescription(self, rx_id, updates):
        allowed = {k: v for k, v in (updates or {}).items()
                   if k in _RX_COLS and k not in ("id", "created_at")}
        for k in _RX_LIST_FIELDS:
            if k in allowed:
                allowed[k] = _json_list(allowed.get(k)) or "[]"
        if not allowed:
            return self.get_prescription(rx_id)
        allowed["updated_at"] = self._now()
        try:
            r = self.client.table("prescriptions").update(allowed).eq("id", rx_id).execute()
            return _decode_rx_row(r.data[0]) if r and r.data else None
        except Exception as e:
            logger.error(f"Supabase update_prescription failed: {e}")
            return None

    def list_prescriptions(self, patient_id=None, limit=50):
        try:
            q = self.client.table("prescriptions").select("*")
            if patient_id:
                q = q.eq("patient_id", patient_id)
            r = q.order("created_at", desc=True).limit(limit).execute()
            return [_decode_rx_row(d) for d in (r.data if r and r.data else [])]
        except Exception as e:
            logger.error(f"Supabase list_prescriptions failed: {e}")
            return []

    def insert_lab_result(self, user_id, flags, triage_session_id=None, filename=""):
        try:
            row = {"id": str(uuid.uuid4()), "user_id": user_id, "triage_session_id": triage_session_id,
                   "filename": filename or "", "flags": _json_list(flags) or "[]", "created_at": self._now()}
            r = self.client.table("lab_results").insert(row).execute()
            if r and r.data:
                d = dict(r.data[0])
                d["flags"] = _as_list(d.get("flags"))
                return d
            return None
        except Exception as e:
            logger.error(f"Supabase insert_lab_result failed: {e}")
            return None

    def get_recent_lab_results(self, user_id=None, limit=100):
        try:
            q = self.client.table("lab_results").select("*")
            if user_id:
                q = q.eq("user_id", user_id)
            r = q.order("created_at", desc=True).limit(limit).execute()
            out = []
            for d in (r.data if r and r.data else []):
                d["flags"] = _as_list(d.get("flags"))
                out.append(d)
            return out
        except Exception as e:
            logger.error(f"Supabase get_recent_lab_results failed: {e}")
            return []


def get_db() -> Database:
    if USE_SUPABASE:
        try:
            db = SupabaseDB()
        except Exception as e:
            logger.error("Supabase initialization failed: %s. Falling back to SQLiteDB.", e)
            db = SQLiteDB()
    else:
        db = SQLiteDB()
    _seed_demo_user(db)
    return db


def init_db():
    return get_db()


def _seed_demo_user(db):
    """Idempotently create the demo doctor account if missing (e.g. ephemeral disk on free hosts)."""
    email = os.getenv("DEMO_USER_EMAIL", "doctor@test.com")
    password = os.getenv("DEMO_USER_PASSWORD", "doctor123")
    try:
        if db.get_user_by_email(email):
            return
        try:
            from werkzeug.security import generate_password_hash
            password_hash = generate_password_hash(password)
        except Exception:
            import hashlib
            password_hash = f"plain:{hashlib.sha256(password.encode()).hexdigest()}"
        user = db.create_user(str(uuid.uuid4()), email, password_hash, "doctor")
        if user:
            db.upsert_profile({
                "user_id": user["id"], "name": "Dr. Demo",
                "qualification": "MBBS", "gender": None, "blood_group": None,
                "height": None, "weight": None, "blood_pressure": None,
            })
            logger.info("Seeded demo doctor account: %s", email)
    except Exception as e:
        logger.warning("Demo user seed skipped: %s", e)
