"""Amrutam API demo. PostgreSQL is the deployment target; SQLite eases local exploration."""
import base64
import hashlib
import hmac
import json
import logging
import os
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import bcrypt
from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, EmailStr, Field
from redis import Redis
from sqlalchemy import (Boolean, DateTime, ForeignKey, Integer, String, Text,
                        UniqueConstraint, create_engine, func, select)
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./local.db")
engine = create_engine(DATABASE_URL, pool_pre_ping=True, **({} if DATABASE_URL.startswith("sqlite") else {"pool_size": 10, "max_overflow": 20}))
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)
JWT_SECRET = os.getenv("JWT_SECRET", "local-only-change-me-32-bytes-minimum!!")
JWT_ISSUER = os.getenv("JWT_ISSUER", "amrutam-api")
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(message)s")
log = logging.getLogger("amrutam")
request_counts = {}
request_durations = {}
local_rate_hits = {}
redis_client = Redis.from_url(os.environ["REDIS_URL"], socket_connect_timeout=0.2, socket_timeout=0.2) if os.getenv("REDIS_URL") else None

class Base(DeclarativeBase): pass

class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(100))
    role: Mapped[str] = mapped_column(String(20), default="patient")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

class Doctor(Base):
    __tablename__ = "doctors"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), unique=True)
    display_name: Mapped[str] = mapped_column(String(160))
    specialty: Mapped[str] = mapped_column(String(120), index=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)

class Slot(Base):
    __tablename__ = "availability_slots"
    __table_args__ = (UniqueConstraint("doctor_id", "starts_at", name="uq_doctor_slot_start"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    doctor_id: Mapped[str] = mapped_column(ForeignKey("doctors.id"), index=True)
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(20), default="available", index=True)

class Consultation(Base):
    __tablename__ = "consultations"
    __table_args__ = (UniqueConstraint("patient_id", "idempotency_key", name="uq_booking_idempotency"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    patient_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    doctor_id: Mapped[str] = mapped_column(ForeignKey("doctors.id"), index=True)
    slot_id: Mapped[str] = mapped_column(ForeignKey("availability_slots.id"), unique=True)
    status: Mapped[str] = mapped_column(String(24), default="booked", index=True)
    idempotency_key: Mapped[str] = mapped_column(String(128))
    reason: Mapped[str] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True)

class Prescription(Base):
    __tablename__ = "prescriptions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    consultation_id: Mapped[str] = mapped_column(ForeignKey("consultations.id"), index=True)
    doctor_id: Mapped[str] = mapped_column(ForeignKey("doctors.id"))
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

class AuditLog(Base):
    __tablename__ = "audit_logs"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    actor_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True, index=True)
    action: Mapped[str] = mapped_column(String(100), index=True)
    resource_type: Mapped[str] = mapped_column(String(60))
    resource_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True)
    request_id: Mapped[str] = mapped_column(String(64))
    outcome: Mapped[str] = mapped_column(String(20), default="success")

class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=12, max_length=72)
    role: str = "patient"
class LoginIn(BaseModel): email: EmailStr; password: str = Field(min_length=1, max_length=72)
class DoctorIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=12, max_length=128)
    display_name: str = Field(min_length=2, max_length=160)
    specialty: str = Field(min_length=2, max_length=120)
class SlotIn(BaseModel): starts_at: datetime; ends_at: datetime
class BookingIn(BaseModel): slot_id: str; reason: str = Field(min_length=3, max_length=500)
class StatusIn(BaseModel): status: str
class PrescriptionIn(BaseModel): body: str = Field(min_length=2, max_length=10000)

app = FastAPI(title="Amrutam Telemedicine API", version="1.0.0", description="Secure telemedicine workflow reference API")
app.add_middleware(CORSMiddleware, allow_origins=[x for x in os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",") if x], allow_credentials=False, allow_methods=["GET", "POST", "PATCH"], allow_headers=["Authorization", "Content-Type", "Idempotency-Key", "X-Request-ID"])
security = HTTPBearer(auto_error=False)

def db():
    session = SessionLocal()
    try: yield session
    finally: session.close()

def audit(session, actor, action, kind, resource_id, request_id):
    session.add(AuditLog(actor_id=actor, action=action, resource_type=kind, resource_id=resource_id, request_id=request_id))

def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

def issue_token(user):
    now = datetime.now(timezone.utc)
    header = _b64(json.dumps({"alg":"HS256","typ":"JWT"}, separators=(",", ":")).encode())
    payload = _b64(json.dumps({"sub":user.id,"role":user.role,"iss":JWT_ISSUER,"iat":int(now.timestamp()),"exp":int((now+timedelta(minutes=int(os.getenv("ACCESS_TOKEN_MINUTES","15")))).timestamp())}, separators=(",", ":")).encode())
    signing_input = f"{header}.{payload}".encode()
    signature = _b64(hmac.new(JWT_SECRET.encode(), signing_input, hashlib.sha256).digest())
    return f"{header}.{payload}.{signature}"

def decode_token(token: str):
    try:
        header, payload, signature = token.split(".")
        signing_input = f"{header}.{payload}".encode()
        expected = _b64(hmac.new(JWT_SECRET.encode(), signing_input, hashlib.sha256).digest())
        if not hmac.compare_digest(signature, expected): raise ValueError("bad signature")
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        if claims.get("iss") != JWT_ISSUER or int(claims.get("exp", 0)) <= int(datetime.now(timezone.utc).timestamp()): raise ValueError("expired or wrong issuer")
        return claims
    except Exception as exc:
        raise ValueError("invalid token") from exc

def current_user(credentials: HTTPAuthorizationCredentials = Depends(security), session: Session = Depends(db)):
    if not credentials: raise HTTPException(401, "Authentication required")
    try: payload = decode_token(credentials.credentials)
    except ValueError: raise HTTPException(401, "Invalid or expired token")
    user = session.get(User, payload.get("sub"))
    if not user or not user.is_active: raise HTTPException(401, "Account unavailable")
    return user

def roles(*allowed):
    def check(user: User = Depends(current_user)):
        if user.role not in allowed: raise HTTPException(403, "Insufficient role")
        return user
    return check

@app.middleware("http")
async def telemetry(request: Request, call_next):
    request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    request.state.request_id = request_id
    started = time.perf_counter()
    if request.url.path in ("/api/v1/auth/login", "/api/v1/auth/register"):
        client_ip = request.client.host if request.client else "unknown"
        bucket = int(time.time() // 60)
        key = f"auth-rate:{client_ip}:{request.url.path}:{bucket}"
        if len(local_rate_hits) > 5000:
            local_rate_hits.clear()
        try:
            if redis_client:
                count = redis_client.incr(key)
                if count == 1: redis_client.expire(key, 120)
            else:
                count = local_rate_hits.get(key, 0) + 1
                local_rate_hits[key] = count
        except Exception:
            # Keep the API available if Redis is down; the gateway remains the distributed control.
            count = local_rate_hits.get(key, 0) + 1
            local_rate_hits[key] = count
        if count > 20:
            return Response('{"detail":"Too many authentication attempts"}', status_code=429, media_type="application/json", headers={"X-Request-ID":request_id,"Retry-After":"60"})
    response = await call_next(request)
    route = request.url.path if request.url.path.startswith("/health") else "/api/*"
    labels = (request.method, route, str(response.status_code))
    request_counts[labels] = request_counts.get(labels, 0) + 1
    duration_labels = (request.method, route)
    samples = request_durations.setdefault(duration_labels, [0, 0.0])
    samples[0] += 1
    samples[1] += time.perf_counter() - started
    response.headers["X-Request-ID"] = request_id
    log.info(json.dumps({"event":"http_request", "request_id":request_id, "method":request.method, "path":request.url.path, "status":response.status_code, "duration_ms":round((time.perf_counter()-started)*1000,2)}))
    return response

@app.on_event("startup")
def startup():
    if os.getenv("APP_ENV", "development") != "development" and (len(JWT_SECRET) < 32 or JWT_SECRET == "local-only-change-me-32-bytes-minimum!!"):
        raise RuntimeError("Production requires a managed JWT_SECRET of at least 32 characters")
    if os.getenv("APP_ENV", "development") == "development": Base.metadata.create_all(engine)

@app.get("/health/live")
def live(): return {"status":"alive"}
@app.get("/health/ready")
def ready(session: Session = Depends(db)):
    try: session.execute(select(1)); return {"status":"ready"}
    except Exception: raise HTTPException(503, "Database unavailable")
@app.get("/metrics")
def metrics():
    lines = ["# HELP http_requests_total HTTP requests", "# TYPE http_requests_total counter"]
    for (method, route, code), count in request_counts.items():
        lines.append(f'http_requests_total{{method="{method}",path="{route}",status="{code}"}} {count}')
    lines.extend(["# HELP http_request_duration_seconds_sum Cumulative request duration", "# TYPE http_request_duration_seconds_sum counter"])
    for (method, route), (count, total) in request_durations.items():
        lines.append(f'http_request_duration_seconds_sum{{method="{method}",path="{route}"}} {total}')
        lines.append(f'http_request_duration_seconds_count{{method="{method}",path="{route}"}} {count}')
    return Response("\n".join(lines) + "\n", media_type="text/plain; version=0.0.4; charset=utf-8")

@app.post("/api/v1/auth/register", status_code=201)
def register(body: RegisterIn, request: Request, session: Session = Depends(db)):
    if body.role != "patient": raise HTTPException(403, "Self-registration is patient-only")
    if session.scalar(select(User).where(User.email == body.email)): raise HTTPException(409, "Account already exists")
    user = User(email=body.email, password_hash=bcrypt.hashpw(body.password.encode(), bcrypt.gensalt()).decode(), role="patient")
    session.add(user); session.flush(); audit(session,user.id,"user.register","user",user.id,request.state.request_id); session.commit()
    return {"id":user.id,"email":user.email,"role":user.role}

@app.post("/api/v1/auth/login")
def login(body: LoginIn, session: Session = Depends(db)):
    user = session.scalar(select(User).where(User.email == body.email))
    if not user or not bcrypt.checkpw(body.password.encode(), user.password_hash.encode()): raise HTTPException(401, "Invalid credentials")
    return {"access_token":issue_token(user),"token_type":"bearer","expires_in":int(os.getenv("ACCESS_TOKEN_MINUTES","15"))*60}

@app.post("/api/v1/admin/doctors", status_code=201)
def create_doctor(body: DoctorIn, request: Request, session: Session = Depends(db), admin: User = Depends(roles("admin"))):
    if session.scalar(select(User).where(User.email == body.email)): raise HTTPException(409,"Account already exists")
    account = User(email=body.email,password_hash=bcrypt.hashpw(body.password.encode(),bcrypt.gensalt()).decode(),role="doctor"); session.add(account); session.flush()
    doctor = Doctor(user_id=account.id,display_name=body.display_name,specialty=body.specialty); session.add(doctor); session.flush()
    audit(session,admin.id,"doctor.create","doctor",doctor.id,request.state.request_id); session.commit()
    return {"id":doctor.id,"user_id":account.id,"display_name":doctor.display_name,"specialty":doctor.specialty}

@app.post("/api/v1/doctors/{doctor_id}/availability", status_code=201)
def add_slot(doctor_id: str, body: SlotIn, request: Request, session: Session = Depends(db), actor: User = Depends(roles("doctor","admin"))):
    doctor=session.scalar(select(Doctor).where(Doctor.id==doctor_id))
    if not doctor or (actor.role=="doctor" and doctor.user_id!=actor.id): raise HTTPException(404,"Doctor not found")
    if body.starts_at.tzinfo is None or body.ends_at.tzinfo is None or body.starts_at<=datetime.now(timezone.utc) or body.ends_at<=body.starts_at: raise HTTPException(422,"Provide a future, timezone-aware interval")
    slot=Slot(doctor_id=doctor_id,starts_at=body.starts_at,ends_at=body.ends_at,status="available"); session.add(slot)
    try:
        session.flush(); audit(session,actor.id,"availability.create","slot",slot.id,request.state.request_id); session.commit()
    except Exception:
        session.rollback(); raise HTTPException(409,"Slot conflicts with an existing start time")
    return {"id":slot.id,"doctor_id":doctor_id,"starts_at":slot.starts_at,"ends_at":slot.ends_at,"status":slot.status}

@app.get("/api/v1/doctors")
def search_doctors(q: Optional[str]=None, specialty: Optional[str]=None, limit: int=Query(default=20,ge=1,le=100), offset: int=Query(default=0,ge=0), session: Session=Depends(db)):
    stmt=select(Doctor).where(Doctor.active.is_(True))
    if specialty: stmt=stmt.where(Doctor.specialty.ilike(f"%{specialty}%"))
    if q: stmt=stmt.where(Doctor.display_name.ilike(f"%{q}%"))
    rows=session.scalars(stmt.order_by(Doctor.display_name).limit(limit).offset(offset)).all()
    return {"items":[{"id":d.id,"display_name":d.display_name,"specialty":d.specialty} for d in rows],"limit":limit,"offset":offset}

@app.get("/api/v1/doctors/{doctor_id}/availability")
def available(doctor_id: str, from_at: datetime, to_at: datetime, session: Session=Depends(db)):
    rows=session.scalars(select(Slot).where(Slot.doctor_id==doctor_id,Slot.status=="available",Slot.starts_at>=from_at,Slot.starts_at<to_at).order_by(Slot.starts_at)).all()
    return {"items":[{"id":x.id,"starts_at":x.starts_at,"ends_at":x.ends_at} for x in rows]}

@app.post("/api/v1/consultations", status_code=201)
def book(body: BookingIn, request: Request, session: Session=Depends(db), patient: User=Depends(roles("patient"))):
    key=request.headers.get("Idempotency-Key")
    if not key or len(key)>128: raise HTTPException(400,"Idempotency-Key header is required (max 128 chars)")
    previous=session.scalar(select(Consultation).where(Consultation.patient_id==patient.id,Consultation.idempotency_key==key))
    if previous: return {"id":previous.id,"status":previous.status,"replayed":True}
    try:
        slot=session.scalar(select(Slot).where(Slot.id==body.slot_id).with_for_update())
        if not slot or slot.status!="available": raise HTTPException(409,"Slot is unavailable")
        item=Consultation(patient_id=patient.id,doctor_id=slot.doctor_id,slot_id=slot.id,status="booked",idempotency_key=key,reason=body.reason)
        session.add(item); slot.status="booked"; session.flush(); audit(session,patient.id,"consultation.book","consultation",item.id,request.state.request_id); session.commit()
        return {"id":item.id,"status":item.status,"replayed":False}
    except HTTPException: session.rollback(); raise
    except Exception: session.rollback(); raise HTTPException(409,"Booking conflict; retry with the same idempotency key")

@app.get("/api/v1/consultations")
def my_consultations(session: Session=Depends(db), user: User=Depends(current_user)):
    stmt=select(Consultation)
    if user.role=="patient": stmt=stmt.where(Consultation.patient_id==user.id)
    elif user.role=="doctor":
        doctor=session.scalar(select(Doctor).where(Doctor.user_id==user.id)); stmt=stmt.where(Consultation.doctor_id==doctor.id if doctor else Consultation.id=="")
    rows=session.scalars(stmt.order_by(Consultation.created_at.desc()).limit(100)).all()
    return {"items":[{"id":x.id,"patient_id":x.patient_id,"doctor_id":x.doctor_id,"slot_id":x.slot_id,"status":x.status,"created_at":x.created_at} for x in rows]}

@app.patch("/api/v1/consultations/{consultation_id}/status")
def set_status(consultation_id: str, body: StatusIn, request: Request, session: Session=Depends(db), actor: User=Depends(current_user)):
    transitions={"booked":{"in_progress","cancelled"},"in_progress":{"completed","cancelled"},"completed":set(),"cancelled":set()}
    consultation=session.scalar(select(Consultation).where(Consultation.id==consultation_id).with_for_update())
    if not consultation: raise HTTPException(404,"Consultation not found")
    doctor=session.scalar(select(Doctor).where(Doctor.user_id==actor.id)) if actor.role=="doctor" else None
    if actor.role!="admin" and actor.id!=consultation.patient_id and (not doctor or doctor.id!=consultation.doctor_id): raise HTTPException(403,"Not permitted")
    if body.status not in transitions.get(consultation.status,set()): raise HTTPException(409,"Invalid lifecycle transition")
    if actor.role=="patient" and body.status!="cancelled": raise HTTPException(403,"Patients can only cancel")
    consultation.status=body.status; audit(session,actor.id,"consultation.status_change","consultation",consultation_id,request.state.request_id); session.commit()
    return {"id":consultation.id,"status":consultation.status}

@app.post("/api/v1/consultations/{consultation_id}/prescriptions", status_code=201)
def prescribe(consultation_id: str, body: PrescriptionIn, request: Request, session: Session=Depends(db), actor: User=Depends(roles("doctor","admin"))):
    consultation=session.get(Consultation,consultation_id); doctor=session.scalar(select(Doctor).where(Doctor.user_id==actor.id)) if actor.role=="doctor" else None
    if not consultation or (actor.role=="doctor" and (not doctor or doctor.id!=consultation.doctor_id)): raise HTTPException(404,"Consultation not found")
    if consultation.status not in ("in_progress","completed"): raise HTTPException(409,"Consultation must be in progress or completed")
    prescription=Prescription(consultation_id=consultation_id,doctor_id=consultation.doctor_id,body=body.body); session.add(prescription); session.flush()
    audit(session,actor.id,"prescription.create","prescription",prescription.id,request.state.request_id); session.commit()
    return {"id":prescription.id,"consultation_id":consultation_id,"created_at":prescription.created_at}

@app.get("/api/v1/consultations/{consultation_id}/prescriptions")
def read_prescriptions(consultation_id: str, session: Session=Depends(db), actor: User=Depends(current_user)):
    consultation=session.get(Consultation,consultation_id); doctor=session.scalar(select(Doctor).where(Doctor.user_id==actor.id)) if actor.role=="doctor" else None
    if not consultation or (actor.role=="patient" and consultation.patient_id!=actor.id) or (actor.role=="doctor" and (not doctor or doctor.id!=consultation.doctor_id)): raise HTTPException(404,"Consultation not found")
    rows=session.scalars(select(Prescription).where(Prescription.consultation_id==consultation_id)).all()
    return {"items":[{"id":p.id,"body":p.body,"created_at":p.created_at} for p in rows]}

@app.get("/api/v1/admin/analytics")
def analytics(session: Session=Depends(db), admin: User=Depends(roles("admin"))):
    by_status=session.execute(select(Consultation.status,func.count()).group_by(Consultation.status)).all()
    return {"consultations_by_status":{name:count for name,count in by_status},"total_users":session.scalar(select(func.count()).select_from(User)),"active_doctors":session.scalar(select(func.count()).select_from(Doctor).where(Doctor.active.is_(True)))}
