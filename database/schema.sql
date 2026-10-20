-- PostgreSQL 16 schema. Apply via versioned migrations in deployed environments.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE, password_hash text NOT NULL, role text NOT NULL CHECK (role IN ('patient','doctor','admin')), is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE profiles (user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, full_name text, phone_ciphertext bytea, date_of_birth_ciphertext bytea);
CREATE TABLE doctors (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE REFERENCES users(id), display_name text NOT NULL, specialty text NOT NULL, active boolean NOT NULL DEFAULT true);
CREATE INDEX doctors_search_idx ON doctors USING gin (to_tsvector('simple', display_name || ' ' || specialty));
CREATE TABLE availability_slots (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), doctor_id uuid NOT NULL REFERENCES doctors(id), starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, status text NOT NULL CHECK (status IN ('available','booked','blocked')), CHECK (ends_at > starts_at), UNIQUE(doctor_id, starts_at));
CREATE INDEX available_slots_idx ON availability_slots(doctor_id, starts_at) WHERE status='available';
CREATE TABLE consultations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), patient_id uuid NOT NULL REFERENCES users(id), doctor_id uuid NOT NULL REFERENCES doctors(id), slot_id uuid NOT NULL UNIQUE REFERENCES availability_slots(id), status text NOT NULL CHECK (status IN ('booked','in_progress','completed','cancelled')), idempotency_key varchar(128) NOT NULL, reason_ciphertext bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(patient_id,idempotency_key));
CREATE INDEX consultations_patient_time_idx ON consultations(patient_id,created_at DESC);
CREATE INDEX consultations_doctor_time_idx ON consultations(doctor_id,created_at DESC);
CREATE TABLE prescriptions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), consultation_id uuid NOT NULL REFERENCES consultations(id), doctor_id uuid NOT NULL REFERENCES doctors(id), body_ciphertext bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), consultation_id uuid NOT NULL UNIQUE REFERENCES consultations(id), provider_ref text UNIQUE, amount_minor bigint NOT NULL CHECK(amount_minor>=0), currency char(3) NOT NULL, status text NOT NULL CHECK(status IN ('pending','authorized','captured','refunded','failed')), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE audit_logs (id bigserial PRIMARY KEY, actor_id uuid, action text NOT NULL, resource_type text NOT NULL, resource_id uuid, occurred_at timestamptz NOT NULL DEFAULT now(), request_id text NOT NULL, outcome text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}');
CREATE INDEX audit_logs_time_idx ON audit_logs(occurred_at);
-- At high history volume, range-partition consultations/audit_logs by time after validating retention and uniqueness semantics.
