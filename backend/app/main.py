from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from .models.schemas import AuditResponse, GoogleSheetsConfig
from .services.audit_service import AuditService
from .services.duplicate_service import DuplicateService
from .services.forensic_service import ForensicService
from .services.google_sheets_service import GoogleSheetsService
from .services.history_service import HistoryService
from .services.ml_service import MLService
from .services.ocr_service import OCRService
from .services.statutory_service import StatutoryService
from .services.vendor_history_service import VendorHistoryService

MAX_FILE_SIZE = 20 * 1024 * 1024  # 20 MB

app = FastAPI(title="AuditLens AI", version="1.0.0")

allowed_origins = os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Service initialization ───────────────────────────────────────────
data_dir = Path(os.getenv("DATA_DIR", "backend/data"))
forensic_service = ForensicService()
statutory_service = StatutoryService()
ocr_service = OCRService()
duplicate_service = DuplicateService()
ml_service = MLService()
vendor_history_service = VendorHistoryService(data_dir / "vendors")
history_service = HistoryService(data_dir / "audit_history.json")
google_sheets_service = GoogleSheetsService()

audit_service = AuditService(
    forensic_service=forensic_service,
    statutory_service=statutory_service,
    ocr_service=ocr_service,
    duplicate_service=duplicate_service,
    ml_service=ml_service,
    vendor_history_service=vendor_history_service,
)


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
    # Normalize empty strings to None
    gstin = gstin.strip() or None if gstin else None
    hsn_or_sac = hsn_or_sac.strip() or None if hsn_or_sac else None

    try:
        file_bytes = await file.read()
        if not file_bytes:
            raise HTTPException(status_code=400, detail="Uploaded file is empty.")
        if len(file_bytes) > MAX_FILE_SIZE:
            raise HTTPException(
                status_code=400,
                detail=f"File too large ({len(file_bytes)} bytes). Maximum: {MAX_FILE_SIZE} bytes.",
            )
    except HTTPException:
        raise
    except Exception as exc:
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

    response = AuditResponse(**payload)
    history_service.append(response.model_dump())

    # Auto-export to Google Sheets if configured
    if google_sheets_service.is_configured:
        google_sheets_service.export_audit_result(response.model_dump())

    return response


@app.get("/history")
def get_history() -> list[dict]:
    return history_service.read_all()


@app.get("/insights")
def get_insights() -> dict:
    return history_service.get_insights()


@app.post("/sheets/configure")
def configure_google_sheets(config: GoogleSheetsConfig) -> dict:
    return google_sheets_service.configure(
        spreadsheet_id=config.spreadsheet_id,
        credentials_json=config.credentials_json,
        sheet_name=config.sheet_name,
    )


@app.get("/sheets/status")
def sheets_status() -> dict:
    return {"configured": google_sheets_service.is_configured}


@app.post("/sheets/export-history")
def export_history_to_sheets() -> dict:
    if not google_sheets_service.is_configured:
        raise HTTPException(status_code=400, detail="Google Sheets not configured.")
    records = history_service.read_all()
    result = google_sheets_service.export_batch(records)
    if not result.get("success"):
        raise HTTPException(status_code=500, detail=result.get("error", "Export failed."))
    return result


@app.post("/sheets/export-insights")
def export_insights_to_sheets() -> dict:
    if not google_sheets_service.is_configured:
        raise HTTPException(status_code=400, detail="Google Sheets not configured.")
    insights = history_service.get_insights()
    return google_sheets_service.export_insights(insights)
