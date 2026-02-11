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
    pan: str | None
    entity_type: str | None
    alerts: list[str]
