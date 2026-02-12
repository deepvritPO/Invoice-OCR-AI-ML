from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


CheckStatus = Literal["pass", "fail", "warning", "data_missing", "not_applicable"]


class CheckResult(BaseModel):
    check_id: str
    category: str
    check_name: str
    status: CheckStatus
    alert: str | None = None
    risk_indicator: str
    details: dict[str, Any] = Field(default_factory=dict)


class AuditResponse(BaseModel):
    composite_risk_score: int = Field(ge=0, le=100)
    alerts: list[str]
    checks: list[CheckResult]
    metadata: dict[str, Any]


class GSTINValidationResult(BaseModel):
    is_valid: bool
    pan: str | None = None
    entity_type: str | None = None
    state_code: str | None = None
    registration_status: str | None = None
    alerts: list[str] = Field(default_factory=list)


class PANValidationResult(BaseModel):
    is_valid: bool
    pan: str | None = None
    entity_type: str | None = None
    entity_code: str | None = None
    alerts: list[str] = Field(default_factory=list)


class HSNValidationResult(BaseModel):
    is_valid: bool
    code: str | None = None
    code_type: str | None = None
    expected_tax_rate: float | None = None
    claimed_tax_rate: float | None = None
    rate_match: bool = False
    alert: str | None = None


class OCRResult(BaseModel):
    raw_text: str = ""
    invoice_number: str | None = None
    invoice_date: str | None = None
    vendor_name: str | None = None
    gstin: str | None = None
    pan: str | None = None
    total_amount: float | None = None
    taxable_amount: float | None = None
    cgst: float | None = None
    sgst: float | None = None
    igst: float | None = None
    line_items: list[dict[str, Any]] = Field(default_factory=list)
    hsn_codes: list[str] = Field(default_factory=list)
    confidence: float = 0.0


class DuplicateCheckResult(BaseModel):
    is_duplicate: bool = False
    duplicate_type: str | None = None
    similarity_score: float = 0.0
    matching_invoice: str | None = None
    details: dict[str, Any] = Field(default_factory=dict)


class VendorProfile(BaseModel):
    vendor_id: str
    gstin: str | None = None
    name: str | None = None
    avg_invoice_amount: float = 0.0
    invoice_count: int = 0
    avg_frequency_days: float = 0.0
    price_history: dict[str, list[float]] = Field(default_factory=dict)
    template_hashes: list[str] = Field(default_factory=list)
    addresses: list[str] = Field(default_factory=list)
    bank_accounts: list[dict[str, str]] = Field(default_factory=list)
    risk_score: float = 0.0


class GoogleSheetsConfig(BaseModel):
    spreadsheet_id: str
    credentials_json: str | None = None
    sheet_name: str = "AuditLens Results"


class AnomalyResult(BaseModel):
    is_anomaly: bool = False
    anomaly_score: float = 0.0
    anomaly_factors: list[str] = Field(default_factory=list)
    benford_pass: bool = True
    confidence: float = 0.0
