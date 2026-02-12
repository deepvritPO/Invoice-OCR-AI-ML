from __future__ import annotations

import tempfile
from pathlib import Path

from backend.app.services.audit_service import AuditService
from backend.app.services.duplicate_service import DuplicateService
from backend.app.services.forensic_service import ForensicService
from backend.app.services.ml_service import MLService
from backend.app.services.ocr_service import OCRService
from backend.app.services.statutory_service import StatutoryService
from backend.app.services.vendor_history_service import VendorHistoryService


def _make_audit_service() -> AuditService:
    tmp = Path(tempfile.mkdtemp())
    return AuditService(
        forensic_service=ForensicService(),
        statutory_service=StatutoryService(),
        ocr_service=OCRService(),
        duplicate_service=DuplicateService(),
        ml_service=MLService(),
        vendor_history_service=VendorHistoryService(tmp / "vendors"),
    )


# ── GSTIN Validation ─────────────────────────────────────────────────

def test_gstin_validation_valid() -> None:
    service = StatutoryService()
    result = service.validate_gstin("27AAPFU0939F1ZV")
    assert result.is_valid
    assert result.pan == "AAPFU0939F"
    assert result.state_code == "27"


def test_gstin_validation_missing() -> None:
    service = StatutoryService()
    result = service.validate_gstin(None)
    assert not result.is_valid
    assert "Data Missing" in result.alerts[0]


def test_gstin_validation_invalid_format() -> None:
    service = StatutoryService()
    result = service.validate_gstin("INVALID")
    assert not result.is_valid
    assert "Invalid GSTIN format" in result.alerts[0]


def test_gstin_empty_string_treated_as_none() -> None:
    service = StatutoryService()
    result = service.validate_gstin("")
    assert not result.is_valid
    assert "Data Missing" in result.alerts[0]


# ── PAN Validation ───────────────────────────────────────────────────

def test_pan_validation_valid() -> None:
    service = StatutoryService()
    result = service.validate_pan("AAPFU0939F")
    assert result.is_valid
    assert result.entity_type == "Firm"
    assert result.entity_code == "F"


def test_pan_validation_missing() -> None:
    service = StatutoryService()
    result = service.validate_pan(None)
    assert not result.is_valid


def test_pan_validation_invalid() -> None:
    service = StatutoryService()
    result = service.validate_pan("12345")
    assert not result.is_valid


# ── HSN/SAC Validation ───────────────────────────────────────────────

def test_hsn_validation_matching_rate() -> None:
    service = StatutoryService()
    result = service.validate_hsn_sac("9983", 18.0)
    assert result.is_valid
    assert result.rate_match
    assert result.expected_tax_rate == 18.0


def test_hsn_validation_rate_mismatch() -> None:
    service = StatutoryService()
    result = service.validate_hsn_sac("9983", 12.0)
    assert not result.is_valid
    assert "mismatch" in (result.alert or "").lower()


def test_hsn_validation_missing() -> None:
    service = StatutoryService()
    result = service.validate_hsn_sac(None, None)
    assert not result.is_valid
    assert "Data Missing" in (result.alert or "")


def test_hsn_unknown_code() -> None:
    service = StatutoryService()
    result = service.validate_hsn_sac("0000", 18.0)
    assert not result.is_valid
    assert "not found" in (result.alert or "").lower()


# ── Forensic Service ─────────────────────────────────────────────────

def test_metadata_extraction_invalid_pdf() -> None:
    service = ForensicService()
    result = service.extract_metadata("test.pdf", b"%PDF-1.4 fake content")
    assert result["file_type"] == "pdf"
    # Should handle gracefully (either extract or error)
    assert "metadata" in result or "error" in result


def test_metadata_extraction_invalid_image() -> None:
    service = ForensicService()
    result = service.extract_metadata("test.png", b"not an image")
    assert result["file_type"] == "image"
    assert "error" in result


def test_ela_invalid_image() -> None:
    service = ForensicService()
    result = service.perform_ela(b"not an image")
    assert result["ela_possible"] is False


# ── Duplicate Detection ──────────────────────────────────────────────

def test_exact_duplicate_detection() -> None:
    service = DuplicateService()
    first = service.check_exact_duplicate("V001", "INV-001", "2024-01-01", 10000.0)
    assert not first["is_duplicate"]

    second = service.check_exact_duplicate("V001", "INV-001", "2024-01-01", 10000.0)
    assert second["is_duplicate"]
    assert second["duplicate_type"] == "exact"


def test_exact_duplicate_no_invoice_number() -> None:
    service = DuplicateService()
    result = service.check_exact_duplicate("V001", None, None, None)
    assert "Data Missing" in result.get("alert", "")


# ── ML Service ───────────────────────────────────────────────────────

def test_vendor_risk_scoring() -> None:
    service = MLService()
    factors = {
        "gstin_status": 0,
        "metadata_tampering": 0,
        "ela_manipulation": 0,
        "duplicate_detected": 0,
    }
    result = service.compute_vendor_risk_score(factors)
    assert result["risk_level"] == "Low"
    assert result["risk_score"] == 0


def test_vendor_risk_scoring_high() -> None:
    service = MLService()
    factors = {
        "gstin_status": 1,
        "metadata_tampering": 1,
        "ela_manipulation": 1,
        "duplicate_detected": 1,
        "hsn_mismatch": 1,
        "gst_calculation_error": 1,
    }
    result = service.compute_vendor_risk_score(factors)
    assert result["risk_level"] in ("High", "Critical")
    assert result["risk_score"] > 60


def test_anomaly_detection_initial() -> None:
    service = MLService()
    features = {"amount": 5000, "line_items": 3, "tax_rate": 18, "day_of_month": 15}
    result = service.detect_anomaly(features)
    assert "is_anomaly" in result
    assert result["training_samples"] == 1


def test_threshold_circumvention_near_threshold() -> None:
    service = MLService()
    result = service.detect_threshold_circumvention(
        invoice_amount=95000,
        thresholds=[100000],
    )
    assert len(result["threshold_proximity"]) > 0
    assert result["threshold_proximity"][0]["percentage"] == 95.0


# ── GST Calculation ──────────────────────────────────────────────────

def test_gst_calculation_verification_pass() -> None:
    service = StatutoryService()
    ocr_data = {
        "taxable_amount": 10000,
        "total_amount": 11800,
        "cgst": 900,
        "sgst": 900,
    }
    result = service.verify_gst_calculations(ocr_data)
    assert result["verified"]
    assert result["gst_type"] == "intra-state (CGST+SGST)"


def test_gst_calculation_verification_mismatch() -> None:
    service = StatutoryService()
    ocr_data = {
        "taxable_amount": 10000,
        "total_amount": 15000,
        "cgst": 900,
        "sgst": 900,
    }
    result = service.verify_gst_calculations(ocr_data)
    assert not result["verified"]


def test_gst_calculation_missing_data() -> None:
    service = StatutoryService()
    result = service.verify_gst_calculations({})
    assert not result["verified"]
    assert "Data Missing" in result.get("alert", "")


# ── Control Coverage ─────────────────────────────────────────────────

def test_control_coverage_count() -> None:
    audit_service = _make_audit_service()
    checks, _ = audit_service.run_checks(
        filename="sample.pdf",
        file_bytes=b"%PDF-1.4 fake",
        gstin=None,
        hsn_or_sac=None,
        claimed_tax_rate=None,
    )
    assert len(checks) == 26
    ids = {check.check_id for check in checks}
    assert "1.1" in ids and "5.5" in ids


def test_all_checks_have_valid_status() -> None:
    audit_service = _make_audit_service()
    checks, _ = audit_service.run_checks(
        filename="sample.pdf",
        file_bytes=b"%PDF-1.4 fake",
        gstin=None,
        hsn_or_sac=None,
        claimed_tax_rate=None,
    )
    valid_statuses = {"pass", "fail", "warning", "data_missing", "not_applicable"}
    for check in checks:
        assert check.status in valid_statuses, f"Check {check.check_id} has invalid status: {check.status}"


def test_risk_score_within_bounds() -> None:
    audit_service = _make_audit_service()
    checks, _ = audit_service.run_checks(
        filename="sample.pdf",
        file_bytes=b"%PDF-1.4 fake",
        gstin=None,
        hsn_or_sac=None,
        claimed_tax_rate=None,
    )
    score = audit_service.compute_risk_score(checks)
    assert 0 <= score <= 100


def test_audit_with_valid_gstin_and_hsn() -> None:
    audit_service = _make_audit_service()
    checks, artifacts = audit_service.run_checks(
        filename="invoice.pdf",
        file_bytes=b"%PDF-1.4 fake",
        gstin="27AAPFU0939F1ZV",
        hsn_or_sac="9983",
        claimed_tax_rate=18.0,
    )
    assert len(checks) == 26
    gstin_check = next(c for c in checks if c.check_id == "2.1")
    hsn_check = next(c for c in checks if c.check_id == "2.3")
    assert gstin_check.status == "pass"
    assert hsn_check.status == "pass"


# ── Invoice Number Validation ────────────────────────────────────────

def test_invoice_number_missing() -> None:
    service = StatutoryService()
    result = service.validate_invoice_number(None, [])
    assert "Data Missing" in result["alert"]


def test_invoice_number_valid() -> None:
    service = StatutoryService()
    result = service.validate_invoice_number("INV-2024-001", [])
    assert result["valid"]


def test_invoice_number_duplicate() -> None:
    service = StatutoryService()
    history = [{"invoice_number": "INV-001"}]
    result = service.validate_invoice_number("INV-001", history)
    assert not result["valid"]
    assert any("Duplicate" in a for a in result["alerts"])
