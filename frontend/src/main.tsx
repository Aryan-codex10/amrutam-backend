import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type Doctor = { id: string; display_name: string; specialty: string };
type Slot = { id: string; starts_at: string; ends_at: string };
type Visit = {
  id: string;
  doctor_id: string;
  patient_id?: string;
  slot_id?: string;
  status: string;
  created_at: string;
};
type Prescription = { id: string; body: string; created_at: string };
type ApiResponse = Record<string, any>;
type Role = "patient" | "doctor" | "admin";
const API = "/api/v1";

function decodeRole(token: string): Role {
  try {
    const encodedPayload = token.split(".")[1];
    if (!encodedPayload) return "patient";
    const payload = JSON.parse(atob(encodedPayload.replace(/-/g, "+").replace(/_/g, "/")));
    return payload.role === "doctor" || payload.role === "admin" ? payload.role : "patient";
  } catch {
    return "patient";
  }
}

function formatDate(value: string) {
  return new Date(value).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function App() {
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("patient01.demo@example.com");
  const [password, setPassword] = useState("Demo-Patient-2026!");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [registerMode, setRegisterMode] = useState(false);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [selectedDoctor, setSelectedDoctor] = useState("");
  const [reason, setReason] = useState("Routine consultation");
  const [query, setQuery] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [prescriptions, setPrescriptions] = useState<Record<string, Prescription[]>>({});
  const [prescriptionBody, setPrescriptionBody] = useState("");
  const [analytics, setAnalytics] = useState<ApiResponse | null>(null);
  const [mfaSetup, setMfaSetup] = useState<ApiResponse | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [newDoctor, setNewDoctor] = useState({ email: "", password: "", display_name: "", specialty: "" });
  const role = useMemo(() => decodeRole(token), [token]);

  async function call(path: string, options: RequestInit = {}): Promise<ApiResponse> {
    const response = await fetch(API + path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(body.detail || `Request failed (${response.status})`);
    return body;
  }

  async function loadDoctors() {
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      if (specialty) params.set("specialty", specialty);
      const result = await call(`/doctors?${params}`);
      setDoctors(result.items || []);
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  useEffect(() => {
    void loadDoctors();
  }, []);

  async function submitAuth(event: React.FormEvent) {
    event.preventDefault();
    try {
      if (registerMode) {
        await call("/auth/register", { method: "POST", body: JSON.stringify({ email, password }) });
        setRegisterMode(false);
        setMessage("Your patient account is ready. Sign in to continue.");
        return;
      }
      const result = await call("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password, ...(code ? { totp_code: code } : {}) }),
      });
      setToken(result.access_token);
      setCode("");
      setMessage("Signed in securely.");
      setTimeout(() => void loadVisits(result.access_token), 0);
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  async function loadVisits(nextToken = token) {
    try {
      const result = await callWithToken("/consultations", nextToken);
      setVisits(result.items || []);
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  async function callWithToken(path: string, nextToken: string, options: RequestInit = {}) {
    const response = await fetch(API + path, {
      ...options,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${nextToken}`, ...options.headers },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(body.detail || `Request failed (${response.status})`);
    return body;
  }

  async function showAvailability(doctorId: string) {
    setSelectedDoctor(doctorId);
    try {
      const from = new Date().toISOString();
      const to = new Date(Date.now() + 30 * 86400000).toISOString();
      const result = await call(`/doctors/${doctorId}/availability?from_at=${encodeURIComponent(from)}&to_at=${encodeURIComponent(to)}`);
      setSlots(result.items || []);
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  async function book(slotId: string) {
    try {
      const result = await call("/consultations", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ slot_id: slotId, reason }),
      });
      setMessage(`Appointment booked · ${result.id.slice(0, 8)}`);
      await loadVisits();
      await showAvailability(selectedDoctor);
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  async function updateVisit(visit: Visit, status: string) {
    try {
      await call(`/consultations/${visit.id}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
      setMessage(`Consultation moved to ${status.replace("_", " ")}.`);
      await loadVisits();
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  async function loadPrescription(visit: Visit) {
    try {
      const result = await call(`/consultations/${visit.id}/prescriptions`);
      setPrescriptions((current) => ({ ...current, [visit.id]: result.items || [] }));
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  async function createPrescription(visit: Visit) {
    try {
      await call(`/consultations/${visit.id}/prescriptions`, {
        method: "POST",
        body: JSON.stringify({ body: prescriptionBody }),
      });
      setPrescriptionBody("");
      setMessage("Prescription created securely.");
      await loadPrescription(visit);
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  async function loadAnalytics() {
    try {
      setAnalytics(await call("/admin/analytics"));
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  async function createDoctor(event: React.FormEvent) {
    event.preventDefault();
    try {
      await call("/admin/doctors", { method: "POST", body: JSON.stringify(newDoctor) });
      setNewDoctor({ email: "", password: "", display_name: "", specialty: "" });
      setMessage("Doctor account created.");
      await loadDoctors();
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  async function setupMfa() {
    try {
      setMfaSetup(await call("/auth/mfa/setup"));
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  async function verifyMfa(event: React.FormEvent) {
    event.preventDefault();
    try {
      await call("/auth/mfa/verify", { method: "POST", body: JSON.stringify({ totp_code: mfaCode }) });
      setMfaSetup(null);
      setMfaCode("");
      setMessage("MFA enabled. Use a fresh authenticator code next time you sign in.");
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  function signOut() {
    setToken("");
    setVisits([]);
    setAnalytics(null);
    setPrescriptions({});
    setMessage("Signed out.");
  }

  return (
    <main>
      <nav>
        <a className="brand" href="#">amrutam<span>care</span></a>
        <span className="secure">● Secure care portal</span>
        {token ? <button className="outline" onClick={signOut}>Sign out</button> : <a className="navlink" href="#signin">Patient portal ↗</a>}
      </nav>

      <section className="hero">
        <div>
          <p className="eyebrow">CARE THAT MEETS YOU HERE</p>
          <h1>Your wellbeing,<br /><em>in good hands.</em></h1>
          <p className="lead">Find trusted specialists, choose a time that works, and keep your care in one calm place.</p>
          <a className="button" href="#find">Explore doctors <span>↘</span></a>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="sun" /><div className="medallion">✿</div>
          <div className="art-card"><span>YOUR NEXT STEP</span><strong>Care, made<br />a little easier.</strong><small>Wellness begins with a conversation.</small></div>
          <div className="plant">✳</div>
        </div>
      </section>

      <section className="trust">
        <div><b>01</b><span>Thoughtful<br />specialists</span></div>
        <div><b>02</b><span>Simple appointment<br />booking</span></div>
        <div><b>03</b><span>Private by<br />design</span></div>
        <div><b>04</b><span>Care that<br />continues</span></div>
      </section>

      <section className="content" id="find">
        <header>
          <div><p className="eyebrow">THE CARE YOU NEED</p><h2>Meet your specialists</h2></div>
          <div className="search-controls">
            <input aria-label="Search doctors" placeholder="Search doctors" value={query} onChange={(event) => setQuery(event.target.value)} />
            <input aria-label="Filter by specialty" placeholder="Specialty" value={specialty} onChange={(event) => setSpecialty(event.target.value)} />
            <button className="outline" onClick={() => void loadDoctors()}>Search</button>
          </div>
        </header>
        <div className="doctor-grid">
          {doctors.map((doctor, index) => (
            <article className="doctor" key={doctor.id}>
              <div className={`avatar a${index % 5}`}>{doctor.display_name.split(" ").map((part) => part[0]).join("")}</div>
              <span className="tag">{doctor.specialty}</span><h3>{doctor.display_name}</h3>
              <p>Experienced care, personal to you.</p>
              <button onClick={() => void showAvailability(doctor.id)} className="textbtn">View availability <b>↗</b></button>
            </article>
          ))}
        </div>
        {selectedDoctor && (
          <section className="slots">
            <h3>Available appointments</h3>
            <label>What would you like help with?<input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} /></label>
            <div className="slot-list">
              {slots.length ? slots.map((slot) => (
                <button key={slot.id} onClick={() => token && role === "patient" ? void book(slot.id) : setMessage("Sign in as a patient to book an appointment.")}>
                  {formatDate(slot.starts_at)} · Book
                </button>
              )) : <p>No upcoming times listed for this specialist.</p>}
            </div>
          </section>
        )}
      </section>

      <section className="portal" id="signin">
        <div className="portal-copy">
          <p className="eyebrow">YOUR CARE, IN ONE PLACE</p><h2>A little more connected.</h2>
          <p>Sign in to book a visit, manage consultations, or review care analytics based on your role.</p>
          {token && <button className="outline" onClick={() => void loadVisits()}>Refresh my consultations</button>}
        </div>
        <form onSubmit={submitAuth} className="signin">
          <h3>{token ? `Signed in as ${role}` : registerMode ? "Create your account" : "Welcome back"}</h3>
          <p>Patient demo credentials are prefilled; privileged demo accounts require MFA.</p>
          <label>Email<input value={email} onChange={(event) => setEmail(event.target.value)} type="email" required /></label>
          <label>Password<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" minLength={12} required /></label>
          {!registerMode && (email.includes("doctor") || email.includes("admin")) && <label>Authenticator code<input value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" maxLength={6} /></label>}
          <button className="button">{registerMode ? "Create patient account" : "Sign in"} <span>→</span></button>
          {!token && <button type="button" className="textbtn account-switch" onClick={() => setRegisterMode(!registerMode)}>{registerMode ? "Already registered? Sign in" : "New here? Create a patient account"}</button>}
          {message && <div className="message" role="status">{message}</div>}
        </form>
      </section>

      {token && (
        <section className="content workspace">
          <div className="workspace-heading"><div><p className="eyebrow">{role.toUpperCase()} WORKSPACE</p><h2>{role === "patient" ? "Your appointments" : role === "doctor" ? "Assigned consultations" : "Operations overview"}</h2></div>
            {role === "admin" && <button className="outline" onClick={() => void loadAnalytics()}>Load analytics</button>}
            {role !== "patient" && <button className="outline" onClick={() => void setupMfa()}>Set up MFA</button>}
          </div>
          {visits.length === 0 && role !== "admin" && <p className="empty">No consultations to show yet.</p>}
          {visits.map((visit) => (
            <article className="visit-card" key={visit.id}>
              <div><span className="muted">Consultation · {formatDate(visit.created_at)}</span><h3>{visit.status.replace("_", " ")}</h3><small>ID {visit.id.slice(0, 8)}…</small></div>
              <div className="visit-actions">
                {role === "doctor" && visit.status === "booked" && <button className="outline" onClick={() => void updateVisit(visit, "in_progress")}>Start consultation</button>}
                {role === "doctor" && visit.status === "in_progress" && <button className="outline" onClick={() => void updateVisit(visit, "completed")}>Complete</button>}
                {role === "patient" && ["booked", "in_progress"].includes(visit.status) && <button className="outline" onClick={() => void updateVisit(visit, "cancelled")}>Cancel</button>}
                {(role === "patient" || role === "doctor" || role === "admin") && <button className="textbtn" onClick={() => void loadPrescription(visit)}>View prescription</button>}
              </div>
              {role === "doctor" && ["in_progress", "completed"].includes(visit.status) && <div className="prescription-form"><textarea aria-label="Prescription" placeholder="Write a prescription" value={prescriptionBody} onChange={(event) => setPrescriptionBody(event.target.value)} /><button className="button" onClick={() => void createPrescription(visit)}>Create prescription</button></div>}
              {prescriptions[visit.id]?.map((prescription) => <div className="prescription" key={prescription.id}><b>Prescription</b><p>{prescription.body}</p><small>{formatDate(prescription.created_at)}</small></div>)}
            </article>
          ))}
          {role === "admin" && analytics && <div className="analytics"><h3>Consultations by status</h3>{Object.entries(analytics.consultations_by_status || {}).map(([status, count]) => <div className="metric" key={status}><span>{status.replace("_", " ")}</span><b>{String(count)}</b></div>)}</div>}
          {role === "admin" && <form className="admin-form" onSubmit={createDoctor}><h3>Add a doctor</h3><div className="form-grid"><input aria-label="Doctor name" placeholder="Display name" value={newDoctor.display_name} onChange={(event) => setNewDoctor({ ...newDoctor, display_name: event.target.value })} required /><input aria-label="Doctor specialty" placeholder="Specialty" value={newDoctor.specialty} onChange={(event) => setNewDoctor({ ...newDoctor, specialty: event.target.value })} required /><input aria-label="Doctor email" type="email" placeholder="Email" value={newDoctor.email} onChange={(event) => setNewDoctor({ ...newDoctor, email: event.target.value })} required /><input aria-label="Doctor password" type="password" minLength={12} placeholder="Temporary password" value={newDoctor.password} onChange={(event) => setNewDoctor({ ...newDoctor, password: event.target.value })} required /></div><button className="button">Create doctor</button></form>}
          {mfaSetup && <form className="mfa-card" onSubmit={verifyMfa}><h3>MFA enrollment</h3><p>{mfaSetup.instruction}</p><label>Current authenticator code<input value={mfaCode} onChange={(event) => setMfaCode(event.target.value)} inputMode="numeric" maxLength={6} required /></label><button className="button">Verify and enable MFA</button></form>}
        </section>
      )}

      <footer><a className="brand" href="#">amrutam<span>care</span></a><p>A thoughtful reference experience for the Amrutam telemedicine platform.</p><a href="/docs" target="_blank" rel="noreferrer">Developer API ↗</a></footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
