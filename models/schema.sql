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
