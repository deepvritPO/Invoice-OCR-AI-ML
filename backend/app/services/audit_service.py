from dataclasses import dataclass
from typing import Any

from ..models.schemas import CheckResult
from .forensic_service import ForensicService
from .statutory_service import StatutoryService


@dataclass(frozen=True)
class CheckDefinition:
    check_id: str
    category: str
    check_name: str
    risk_indicator: str


class AuditService:
    CHECK_DEFINITIONS = [
        CheckDefinition("1.1", "Metadata & Image Integrity", "PDF/Image Metadata Tampering Detection", "Modified invoices suggest tampering with amounts/dates/vendor details."),
        CheckDefinition("1.2", "Metadata & Image Integrity", "Image Forensics - Error Level Analysis (ELA)", "Localized ELA spikes can indicate edited fields."),
        CheckDefinition("1.3", "Metadata & Image Integrity", "Font Consistency Analysis", "Font mismatches can indicate cut-paste edits."),
        CheckDefinition("1.4", "Metadata & Image Integrity", "Document Orientation & Quality Score", "Screen photos/re-scans may hide origin trail."),
        CheckDefinition("2.1", "Statutory Validation", "GSTIN Validation & Cross-Verification", "Invalid/cancelled GSTIN may indicate shell vendor risk."),
        CheckDefinition("2.2", "Statutory Validation", "PAN Validation & Linkage Check", "PAN mismatch can indicate identity fraud."),
        CheckDefinition("2.3", "Statutory Validation", "HSN/SAC Code Validation", "Wrong HSN/SAC can indicate tax evasion risk."),
        CheckDefinition("2.4", "Statutory Validation", "GST Calculation & Check Sum Validation", "Math mismatches can suggest manual manipulation."),
        CheckDefinition("2.5", "Statutory Validation", "Invoice Number Format & Sequence Validation", "Sequence gaps/duplicates may indicate fake invoicing."),
        CheckDefinition("2.6", "Statutory Validation", "Bank Account Validation (IFSC & Account)", "Bank detail changes are a common fraud vector."),
        CheckDefinition("2.7", "Statutory Validation", "E-Invoice / IRN Validation", "Missing/fake IRN can indicate bogus ITC claims."),
        CheckDefinition("3.1", "Vendor History Analysis", "Invoice Template Consistency Check", "Sudden template changes may indicate counterfeit invoices."),
        CheckDefinition("3.2", "Vendor History Analysis", "Pricing Variance Analysis", "Price spikes can indicate inflation/collusion."),
        CheckDefinition("3.3", "Vendor History Analysis", "Invoice Frequency & Amount Pattern Analysis", "Abnormal submission patterns suggest splitting/ghost invoicing."),
        CheckDefinition("3.4", "Vendor History Analysis", "Address & Contact Information Consistency", "Address mismatch may indicate vendor substitution fraud."),
        CheckDefinition("3.5", "Vendor History Analysis", "Terms & Conditions Variance", "Unapproved T&C changes can favor vendor unfairly."),
        CheckDefinition("4.1", "Duplicate Detection", "Exact Duplicate Invoice Detection", "Exact duplicates are critical double-billing attempts."),
        CheckDefinition("4.2", "Duplicate Detection", "Near-Duplicate Detection (Fuzzy Matching)", "Near-duplicates indicate sophisticated evasion."),
        CheckDefinition("4.3", "Duplicate Detection", "Cross-Reference PO/GRN Matching", "3-way mismatches indicate over/false billing."),
        CheckDefinition("4.4", "Duplicate Detection", "Image Hash / Perceptual Duplicate Detection", "Same invoice image resubmission indicates replay fraud."),
        CheckDefinition("4.5", "Duplicate Detection", "OCR Content Duplicate Detection", "High text similarity with changed headers indicates manipulation."),
        CheckDefinition("5.1", "Advanced Analytics", "Vendor Risk Scoring", "Composite score helps risk-based payment controls."),
        CheckDefinition("5.2", "Advanced Analytics", "Anomaly Detection - Statistical Outliers", "ML outliers help detect novel fraud patterns."),
        CheckDefinition("5.3", "Advanced Analytics", "Invoice-Expense Correlation Check", "Expenses without activity context can be fictitious."),
        CheckDefinition("5.4", "Advanced Analytics", "Multi-Vendor Collusion Detection", "Shared attributes may indicate collusion networks."),
        CheckDefinition("5.5", "Advanced Analytics", "Approval Threshold Circumvention Detection", "Near-threshold clustering suggests invoice splitting."),
    ]

    def __init__(self, forensic_service: ForensicService, statutory_service: StatutoryService):
        self.forensic_service = forensic_service
        self.statutory_service = statutory_service

    def run_checks(
        self,
        *,
        filename: str,
        file_bytes: bytes,
        gstin: str | None,
        hsn_or_sac: str | None,
        claimed_tax_rate: float | None,
    ) -> tuple[list[CheckResult], dict[str, Any]]:
        metadata = self.forensic_service.extract_metadata(filename, file_bytes)
        ela = self.forensic_service.perform_ela(file_bytes) if self._is_image(filename) else {"ela_possible": False, "status": "not_applicable"}
        gstin_validation = self.statutory_service.validate_gstin(gstin)
        hsn_validation = self.statutory_service.validate_hsn_sac(hsn_or_sac, claimed_tax_rate)

        checks: list[CheckResult] = []
        for definition in self.CHECK_DEFINITIONS:
            checks.append(
                self._evaluate_check(
                    definition,
                    metadata=metadata,
                    ela=ela,
                    gstin_validation=gstin_validation.model_dump(),
                    hsn_validation=hsn_validation,
                )
            )

        artifacts = {
            "forensics": metadata,
            "ela": ela,
            "gstin": gstin_validation.model_dump(),
            "hsn_sac": hsn_validation,
        }
        return checks, artifacts

    def _evaluate_check(self, definition: CheckDefinition, **context: Any) -> CheckResult:
        metadata = context["metadata"]
        ela = context["ela"]
        gstin_validation = context["gstin_validation"]
        hsn_validation = context["hsn_validation"]

        if definition.check_id == "1.1":
            creators = " ".join(str(v) for v in metadata.get("metadata", {}).values()).lower()
            suspicious = metadata.get("suspicious_software", [])
            if metadata.get("error"):
                return self._result(definition, "fail", metadata["error"], {"metadata": metadata.get("metadata", {})})
            if suspicious:
                return self._result(definition, "warning", f"Metadata indicates editing software: {', '.join(suspicious)}", {"software": suspicious})
            if any(k in creators for k in ["adobe", "photoshop", "gimp"]):
                return self._result(definition, "warning", "Creator/Producer indicates editing tooling.", {"creator_fields": metadata.get("metadata", {})})
            return self._result(definition, "pass", None, {"metadata_fields": list(metadata.get("metadata", {}).keys())})

        if definition.check_id == "1.2":
            if not ela.get("ela_possible"):
                return self._result(definition, "not_applicable", "ELA is only applicable for image uploads.", {})
            if ela.get("error"):
                return self._result(definition, "fail", ela["error"], ela)
            if ela.get("ela_flagged"):
                return self._result(definition, "warning", "Potential manipulation detected by ELA variance.", ela)
            return self._result(definition, "pass", None, ela)

        if definition.check_id == "2.1":
            if not gstin_validation.get("is_valid"):
                return self._result(definition, "fail", "; ".join(gstin_validation.get("alerts", ["Invalid GSTIN."])), gstin_validation)
            return self._result(definition, "pass", None, gstin_validation)

        if definition.check_id == "2.2":
            pan = gstin_validation.get("pan")
            entity = gstin_validation.get("entity_type")
            if pan is None:
                return self._result(definition, "data_missing", "Data Missing: PAN could not be derived without valid GSTIN.", gstin_validation)
            if entity is None:
                return self._result(definition, "warning", "PAN extracted but entity type could not be mapped.", {"pan": pan})
            return self._result(definition, "pass", None, {"pan": pan, "entity_type": entity})

        if definition.check_id == "2.3":
            if hsn_validation.get("alert"):
                status = "data_missing" if "Data Missing" in hsn_validation["alert"] else "warning"
                return self._result(definition, status, hsn_validation["alert"], hsn_validation)
            if not hsn_validation.get("is_valid"):
                return self._result(definition, "fail", "HSN/SAC failed validation.", hsn_validation)
            return self._result(definition, "pass", None, hsn_validation)

        # Remaining controls are scaffolds with zero-inference behavior.
        return self._result(
            definition,
            "data_missing",
            "Data Missing: This control requires OCR, ERP/vendor master, or external API integration in next phase.",
            {},
        )

    def _result(self, definition: CheckDefinition, status: str, alert: str | None, details: dict[str, Any]) -> CheckResult:
        return CheckResult(
            check_id=definition.check_id,
            category=definition.category,
            check_name=definition.check_name,
            status=status,  # type: ignore[arg-type]
            alert=alert,
            risk_indicator=definition.risk_indicator,
            details=details,
        )

    @staticmethod
    def _is_image(filename: str) -> bool:
        name = (filename or "").lower()
        return any(name.endswith(ext) for ext in [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff"])

    @staticmethod
    def compute_risk_score(checks: list[CheckResult]) -> int:
        weights = {"fail": 15, "warning": 8, "data_missing": 3, "pass": 0, "not_applicable": 0}
        score = sum(weights.get(check.status, 0) for check in checks)
        return min(score, 100)

    @staticmethod
    def collect_alerts(checks: list[CheckResult]) -> list[str]:
        return [f"[{check.check_id}] {check.alert}" for check in checks if check.alert]
