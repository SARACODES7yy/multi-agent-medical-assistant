import os
import sqlite3
import uuid
import logging
from datetime import datetime, timezone
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

USE_SUPABASE = os.getenv("USE_SUPABASE", "false").lower() == "true"


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
        """)
        conn.commit()
        conn.close()
        logger.info("SQLite schema initialized")

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


class SupabaseDB(Database):
    """Supabase backend (requires SUPABASE_URL + keys in .env)."""

    def __init__(self):
        from supabase import create_client
        self.url = os.getenv("SUPABASE_URL")
        self.anon_key = os.getenv("SUPABASE_ANON_KEY")
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


def get_db() -> Database:
    if USE_SUPABASE:
        return SupabaseDB()
    return SQLiteDB()


def init_db():
    db = get_db()
    logger.info(f"DB initialized: {'Supabase' if USE_SUPABASE else 'SQLite'}")
    return db
