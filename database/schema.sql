-- PostgreSQL 16 target. It matches the TypeScript backend data model.
-- PII/PHI bytes are Fernet tokens written by EncryptedText. Keep keys in KMS/secret manager.
CREATE TABLE users (
    id varchar(36) PRIMARY KEY,
    email bytea NOT NULL,
    email_lookup_hash varchar(64) NOT NULL,
    password_hash varchar(100) NOT NULL,
    role varchar(20) NOT NULL CHECK (role IN ('patient','doctor','admin')),
    is_active boolean NOT NULL DEFAULT true,
    mfa_secret bytea,
    mfa_enabled boolean NOT NULL DEFAULT false,
    mfa_last_counter bigint,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ix_users_email_lookup_hash ON users(email_lookup_hash);

CREATE TABLE profiles (
    user_id varchar(36) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    full_name varchar(160),
    phone_ciphertext bytea,
    date_of_birth_ciphertext bytea
);

CREATE TABLE doctors (
    id varchar(36) PRIMARY KEY,
    user_id varchar(36) NOT NULL UNIQUE REFERENCES users(id),
    display_name varchar(160) NOT NULL,
    specialty varchar(120) NOT NULL,
    active boolean NOT NULL DEFAULT true
);
CREATE INDEX doctors_specialty_idx ON doctors(specialty);
CREATE INDEX doctors_search_idx ON doctors USING gin (to_tsvector('simple', display_name || ' ' || specialty));

CREATE TABLE availability_slots (
    id varchar(36) PRIMARY KEY,
    doctor_id varchar(36) NOT NULL REFERENCES doctors(id),
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    status varchar(20) NOT NULL CHECK (status IN ('available','booked','blocked')),
    CHECK (ends_at > starts_at),
    CONSTRAINT uq_doctor_slot_start UNIQUE(doctor_id, starts_at)
);
CREATE INDEX availability_slots_doctor_id_idx ON availability_slots(doctor_id);
CREATE INDEX availability_slots_starts_at_idx ON availability_slots(starts_at);
CREATE INDEX availability_slots_status_idx ON availability_slots(status);
CREATE INDEX available_slots_idx ON availability_slots(doctor_id, starts_at) WHERE status='available';

CREATE TABLE consultations (
    id varchar(36) PRIMARY KEY,
    patient_id varchar(36) NOT NULL REFERENCES users(id),
    doctor_id varchar(36) NOT NULL REFERENCES doctors(id),
    slot_id varchar(36) NOT NULL UNIQUE REFERENCES availability_slots(id),
    status varchar(24) NOT NULL CHECK (status IN ('booked','in_progress','completed','cancelled')),
    idempotency_key varchar(128) NOT NULL,
    reason bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_booking_idempotency UNIQUE(patient_id, idempotency_key)
);
CREATE INDEX consultations_patient_id_idx ON consultations(patient_id);
CREATE INDEX consultations_doctor_id_idx ON consultations(doctor_id);
CREATE INDEX consultations_status_idx ON consultations(status);
CREATE INDEX consultations_created_at_idx ON consultations(created_at);
CREATE INDEX consultations_patient_time_idx ON consultations(patient_id,created_at DESC);
CREATE INDEX consultations_doctor_time_idx ON consultations(doctor_id,created_at DESC);

CREATE TABLE prescriptions (
    id varchar(36) PRIMARY KEY,
    consultation_id varchar(36) NOT NULL REFERENCES consultations(id),
    doctor_id varchar(36) NOT NULL REFERENCES doctors(id),
    body bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prescriptions_consultation_id_idx ON prescriptions(consultation_id);

CREATE TABLE payments (
    id varchar(36) PRIMARY KEY,
    consultation_id varchar(36) NOT NULL UNIQUE REFERENCES consultations(id),
    provider_ref varchar(160) UNIQUE,
    amount_minor bigint NOT NULL CHECK(amount_minor >= 0),
    currency varchar(3) NOT NULL,
    status varchar(20) NOT NULL CHECK(status IN ('pending','authorized','captured','refunded','failed')),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
    id serial PRIMARY KEY,
    actor_id varchar(36),
    action varchar(100) NOT NULL,
    resource_type varchar(60) NOT NULL,
    resource_id varchar(36),
    occurred_at timestamptz NOT NULL DEFAULT now(),
    request_id varchar(64) NOT NULL,
    outcome varchar(20) NOT NULL
);
CREATE INDEX audit_logs_actor_id_idx ON audit_logs(actor_id);
CREATE INDEX audit_logs_action_idx ON audit_logs(action);
CREATE INDEX audit_logs_resource_type_idx ON audit_logs(resource_type);
CREATE INDEX audit_logs_occurred_at_idx ON audit_logs(occurred_at);

-- Partition consultations/audit_logs by time only after validating retention and idempotency semantics.
