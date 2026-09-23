# Supabase migration — triage_sessions + RLS policies
# Run in Supabase Dashboard: SQL Editor → New Query → paste → Run
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
    consent BOOLEAN DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','scheduled','completed')),
    src TEXT DEFAULT 'local',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE doctor_instructions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_checkups ENABLE ROW LEVEL SECURITY;
ALTER TABLE triage_sessions ENABLE ROW LEVEL SECURITY;
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
    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'triage_sessions'::regclass AND polname = 'triage_sessions_select')
    THEN CREATE POLICY "triage_sessions_select" ON triage_sessions FOR SELECT USING (true); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'triage_sessions'::regclass AND polname = 'triage_sessions_insert')
    THEN CREATE POLICY "triage_sessions_insert" ON triage_sessions FOR INSERT WITH CHECK (true); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'triage_sessions'::regclass AND polname = 'triage_sessions_update')
    THEN CREATE POLICY "triage_sessions_update" ON triage_sessions FOR UPDATE USING (true); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'triage_sessions'::regclass AND polname = 'triage_sessions_delete')
    THEN CREATE POLICY "triage_sessions_delete" ON triage_sessions FOR DELETE USING (true); END IF;
END $$;

-- Book Call tables
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

-- Book Call RLS policies
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'doctor_availability'::regclass AND polname = 'doctor_availability_select')
    THEN CREATE POLICY "doctor_availability_select" ON doctor_availability FOR SELECT USING (true); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'doctor_availability'::regclass AND polname = 'doctor_availability_insert')
    THEN CREATE POLICY "doctor_availability_insert" ON doctor_availability FOR INSERT WITH CHECK (true); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'doctor_availability'::regclass AND polname = 'doctor_availability_update')
    THEN CREATE POLICY "doctor_availability_update" ON doctor_availability FOR UPDATE USING (true); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'doctor_availability'::regclass AND polname = 'doctor_availability_delete')
    THEN CREATE POLICY "doctor_availability_delete" ON doctor_availability FOR DELETE USING (true); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'call_bookings'::regclass AND polname = 'call_bookings_select')
    THEN CREATE POLICY "call_bookings_select" ON call_bookings FOR SELECT USING (true); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'call_bookings'::regclass AND polname = 'call_bookings_insert')
    THEN CREATE POLICY "call_bookings_insert" ON call_bookings FOR INSERT WITH CHECK (true); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'call_bookings'::regclass AND polname = 'call_bookings_update')
    THEN CREATE POLICY "call_bookings_update" ON call_bookings FOR UPDATE USING (true); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'call_bookings'::regclass AND polname = 'call_bookings_delete')
    THEN CREATE POLICY "call_bookings_delete" ON call_bookings FOR DELETE USING (true); END IF;
END $$;
