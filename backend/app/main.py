from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from .models.schemas import AuditResponse
from .services.audit_service import AuditService
from .services.forensic_service import ForensicService
from .services.history_service import HistoryService
from .services.statutory_service import StatutoryService

app = FastAPI(title="AuditLens AI", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

forensic_service = ForensicService()
statutory_service = StatutoryService()
audit_service = AuditService(forensic_service, statutory_service)
history_service = HistoryService(Path("backend/data/audit_history.json"))


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/audit", response_model=AuditResponse)
async def audit_invoice(
    file: UploadFile = File(...),
    gstin: str | None = Form(default=None),
    hsn_or_sac: str | None = Form(default=None),
    claimed_tax_rate: float | None = Form(default=None),
) -> AuditResponse:
    try:
        file_bytes = await file.read()
        if not file_bytes:
            raise HTTPException(status_code=400, detail="Uploaded file is empty.")
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=400, detail=f"Failed to read file: {exc}") from exc

    checks, artifacts = audit_service.run_checks(
        filename=file.filename or "",
        file_bytes=file_bytes,
        gstin=gstin,
        hsn_or_sac=hsn_or_sac,
        claimed_tax_rate=claimed_tax_rate,
    )

    risk_score = audit_service.compute_risk_score(checks)
    alerts = audit_service.collect_alerts(checks)
    if not alerts:
        alerts = ["No major anomalies detected."]

    payload = {
        "composite_risk_score": risk_score,
        "alerts": alerts,
        "checks": checks,
        "metadata": {
            "file_name": file.filename,
            **artifacts,
        },
    }

    history_service.append(AuditResponse(**payload).model_dump())
    return AuditResponse(**payload)
