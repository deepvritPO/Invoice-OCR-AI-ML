from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..models.schemas import CheckResult, CheckStatus
from .duplicate_service import DuplicateService
from .forensic_service import ForensicService
from .ml_service import MLService
from .ocr_service import OCRService
from .statutory_service import StatutoryService
from .vendor_history_service import VendorHistoryService


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

    def __init__(
        self,
        forensic_service: ForensicService,
        statutory_service: StatutoryService,
        ocr_service: OCRService,
        duplicate_service: DuplicateService,
        ml_service: MLService,
        vendor_history_service: VendorHistoryService,
    ) -> None:
        self.forensic = forensic_service
        self.statutory = statutory_service
        self.ocr = ocr_service
        self.duplicate = duplicate_service
        self.ml = ml_service
        self.vendor_history = vendor_history_service

    def run_checks(
        self,
        *,
        filename: str,
        file_bytes: bytes,
        gstin: str | None,
        hsn_or_sac: str | None,
        claimed_tax_rate: float | None,
    ) -> tuple[list[CheckResult], dict[str, Any]]:
        is_image = self._is_image(filename)

        # ── Stage 1: Data extraction ─────────────────────────────────
        metadata = self.forensic.extract_metadata(filename, file_bytes)
        ela = self.forensic.perform_ela(file_bytes) if is_image else {"ela_possible": False}
        font_analysis = self.forensic.analyze_font_consistency(file_bytes) if is_image else {"available": False}
        quality = self.forensic.assess_document_quality(file_bytes) if is_image else {"quality_score": None}
        ocr_result = self.ocr.extract(filename, file_bytes)
        gstin_val = self.statutory.validate_gstin(gstin or ocr_result.gstin)
        pan_val = self.statutory.validate_pan(gstin_val.pan)
        hsn_val = self.statutory.validate_hsn_sac(hsn_or_sac, claimed_tax_rate)
        gst_calc = self.statutory.verify_gst_calculations(ocr_result.model_dump())

        vendor_id = gstin or ocr_result.gstin or "unknown"
        vendor_profile = self.vendor_history.get_vendor_profile(vendor_id)
        inv_number_val = self.statutory.validate_invoice_number(
            ocr_result.invoice_number, vendor_profile.get("invoices", [])
        )

        # Duplicate checks
        exact_dup = self.duplicate.check_exact_duplicate(
            vendor_id, ocr_result.invoice_number, ocr_result.invoice_date, ocr_result.total_amount
        )
        near_dup = self.duplicate.check_near_duplicate(
            vendor_id, ocr_result.invoice_number, ocr_result.invoice_date, ocr_result.total_amount
        )
        image_dup = self.duplicate.check_image_duplicate(file_bytes, filename) if is_image else {"available": False}
        content_dup = self.duplicate.check_content_duplicate(ocr_result.raw_text, ocr_result.invoice_number)

        # Vendor history checks
        template_check = self.vendor_history.check_template_consistency(file_bytes, vendor_id) if is_image else {"available": False}
        pricing_check = self.vendor_history.analyze_pricing_variance(ocr_result.line_items, vendor_id)
        frequency_check = self.vendor_history.analyze_frequency_patterns(vendor_id)
        address_check = self.vendor_history.check_address_consistency(None, vendor_id)
        terms_check = self.vendor_history.check_terms_variance(None, vendor_id)

        # ML/Analytics
        invoice_features = {
            "amount": ocr_result.total_amount or 0,
            "line_items": float(len(ocr_result.line_items)),
            "tax_rate": claimed_tax_rate or 0,
            "day_of_month": 15,  # Default; would parse from invoice_date
        }
        anomaly_result = self.ml.detect_anomaly(invoice_features)

        # Build risk factors for vendor scoring
        risk_factors = {
            "gstin_status": 0 if gstin_val.is_valid else 1,
            "metadata_tampering": 1 if metadata.get("suspicious_software") else 0,
            "ela_manipulation": 1 if ela.get("ela_flagged") else 0,
            "font_inconsistency": 0 if font_analysis.get("font_consistent", True) else 1,
            "document_quality": 0 if (quality.get("quality_score") or 100) >= 50 else 1,
            "hsn_mismatch": 0 if hsn_val.is_valid else 1,
            "gst_calculation_error": 0 if gst_calc.get("verified", True) else 1,
            "duplicate_detected": 1 if exact_dup.get("is_duplicate") or near_dup.get("is_duplicate") else 0,
            "price_variance": 1 if pricing_check.get("variance_detected") else 0,
            "anomaly_detected": 1 if anomaly_result.get("is_anomaly") else 0,
        }
        vendor_risk = self.ml.compute_vendor_risk_score(risk_factors)
        threshold_result = self.ml.detect_threshold_circumvention(
            ocr_result.total_amount or 0,
            recent_amounts=[inv.get("amount", 0) for inv in vendor_profile.get("invoices", []) if inv.get("amount")],
        )

        # ── Stage 2: Build context for check evaluation ──────────────
        ctx = {
            "metadata": metadata,
            "ela": ela,
            "font_analysis": font_analysis,
            "quality": quality,
            "ocr": ocr_result.model_dump(),
            "gstin_val": gstin_val.model_dump(),
            "pan_val": pan_val.model_dump(),
            "hsn_val": hsn_val.model_dump(),
            "gst_calc": gst_calc,
            "inv_number_val": inv_number_val,
            "exact_dup": exact_dup,
            "near_dup": near_dup,
            "po_grn": {"alert": "Data Missing: PO/GRN data requires ERP integration."},
            "image_dup": image_dup,
            "content_dup": content_dup,
            "template_check": template_check,
            "pricing_check": pricing_check,
            "frequency_check": frequency_check,
            "address_check": address_check,
            "terms_check": terms_check,
            "vendor_risk": vendor_risk,
            "anomaly": anomaly_result,
            "expense_correlation": {"alert": "Data Missing: Expense/activity data requires ERP integration."},
            "collusion": {"collusion_detected": False, "alert": "Data Missing: Multi-vendor analysis requires vendor master."},
            "threshold": threshold_result,
            "bank_validation": {"alert": "Data Missing: Bank details not extracted from invoice."},
            "einvoice_validation": {"alert": "Data Missing: IRN/QR not extracted from invoice."},
        }

        # ── Stage 3: Evaluate all 26 checks ─────────────────────────
        checks: list[CheckResult] = []
        for defn in self.CHECK_DEFINITIONS:
            checks.append(self._evaluate_check(defn, ctx))

        # Update vendor history for future checks
        self.vendor_history.update_vendor_profile(vendor_id, ocr_result.model_dump())

        artifacts = {
            "forensics": metadata,
            "ela": ela,
            "font_analysis": font_analysis,
            "document_quality": quality,
            "ocr": ocr_result.model_dump(),
            "gstin": gstin_val.model_dump(),
            "pan": pan_val.model_dump(),
            "hsn_sac": hsn_val.model_dump(),
            "gst_calculation": gst_calc,
            "vendor_risk": vendor_risk,
            "anomaly_detection": anomaly_result,
        }
        return checks, artifacts

    def _evaluate_check(self, defn: CheckDefinition, ctx: dict[str, Any]) -> CheckResult:
        handler = self._CHECK_HANDLERS.get(defn.check_id, self._default_handler)
        return handler(self, defn, ctx)

    # ── Check handlers ───────────────────────────────────────────────

    def _check_1_1(self, defn: CheckDefinition, ctx: dict[str, Any]) -> CheckResult:
        md = ctx["metadata"]
        if md.get("error"):
            return self._result(defn, "fail", md["error"], md)
        suspicious = md.get("suspicious_software", [])
        if suspicious:
            return self._result(defn, "warning", f"Editing software detected: {', '.join(suspicious)}", {"software": suspicious})
        if md.get("modify_after_create"):
            return self._result(defn, "warning", "Metadata shows ModifyDate differs from CreationDate.", md)
        if md.get("incremental_saves", 0) > 2:
            return self._result(defn, "warning", f"PDF has {md['incremental_saves']} incremental saves (indicates edits).", md)
        creators = " ".join(str(v) for v in md.get("metadata", {}).values()).lower()
        if any(k in creators for k in ["adobe", "photoshop", "gimp"]):
            return self._result(defn, "warning", "Creator/Producer indicates editing tooling.", md)
        return self._result(defn, "pass", None, {"metadata_fields": list(md.get("metadata", {}).keys())})

    def _check_1_2(self, defn: CheckDefinition, ctx: dict[str, Any]) -> CheckResult:
        ela = ctx["ela"]
        if not ela.get("ela_possible"):
            return self._result(defn, "not_applicable", "ELA is only applicable for image uploads.", {})
        if ela.get("error"):
            return self._result(defn, "fail", ela["error"], ela)
        if ela.get("ela_flagged"):
            details = {k: ela[k] for k in ["ela_mean_diff", "ela_max_diff", "high_variance_regions"] if k in ela}
            return self._result(defn, "warning", "Potential manipulation detected by ELA variance.", details)
        return self._result(defn, "pass", None, ela)

    def _check_1_3(self, defn: CheckDefinition, ctx: dict[str, Any]) -> CheckResult:
        fa = ctx["font_analysis"]
        if not fa.get("available"):
            return self._result(defn, "data_missing", f"Data Missing: {fa.get('reason', 'Font analysis not available.')}", fa)
        if not fa.get("font_consistent"):
            return self._result(defn, "warning", f"Font inconsistency: {fa.get('low_confidence_words', 0)} low-confidence words, std={fa.get('std_confidence', 0)}.", fa)
        return self._result(defn, "pass", None, fa)

    def _check_1_4(self, defn: CheckDefinition, ctx: dict[str, Any]) -> CheckResult:
        q = ctx["quality"]
        score = q.get("quality_score")
        if score is None:
            return self._result(defn, "not_applicable", "Quality check is only applicable for image uploads.", {})
        issues = q.get("issues", [])
        if q.get("moire_detected"):
            return self._result(defn, "warning", f"Document appears to be photographed from screen. Quality: {score}%", q)
        if score < 40:
            return self._result(defn, "warning", f"Low document quality ({score}%): {'; '.join(issues)}", q)
        return self._result(defn, "pass", None, q)

    def _check_2_1(self, defn: CheckDefinition, ctx: dict[str, Any]) -> CheckResult:
        gv = ctx["gstin_val"]
        alerts = gv.get("alerts", [])
        if not gv.get("is_valid"):
            if any("Data Missing" in a for a in alerts):
                return self._result(defn, "data_missing", "; ".join(alerts), gv)
            return self._result(defn, "fail", "; ".join(alerts) or "Invalid GSTIN.", gv)
        return self._result(defn, "pass", None, gv)

    def _check_2_2(self, defn: CheckDefinition, ctx: dict[str, Any]) -> CheckResult:
        pv = ctx["pan_val"]
        if not pv.get("is_valid"):
            alerts = pv.get("alerts", [])
            if any("Data Missing" in a for a in alerts):
                return self._result(defn, "data_missing", "; ".join(alerts), pv)
            return self._result(defn, "fail", "; ".join(alerts) or "Invalid PAN.", pv)
        return self._result(defn, "pass", None, pv)

    def _check_2_3(self, defn: CheckDefinition, ctx: dict[str, Any]) -> CheckResult:
        hv = ctx["hsn_val"]
        alert = hv.get("alert")
        if alert:
            status: CheckStatus = "data_missing" if "Data Missing" in alert else "warning"
            return self._result(defn, status, alert, hv)
        if not hv.get("is_valid"):
            return self._result(defn, "fail", "HSN/SAC validation failed.", hv)
        return self._result(defn, "pass", None, hv)

    def _check_2_4(self, defn: CheckDefinition, ctx: dict[str, Any]) -> CheckResult:
        gc = ctx["gst_calc"]
        if gc.get("alert") and "Data Missing" in gc["alert"]:
            return self._result(defn, "data_missing", gc["alert"], gc)
        if not gc.get("verified"):
            alerts_text = "; ".join(gc.get("alerts", ["GST calculation error."]))
            return self._result(defn, "fail", alerts_text, gc)
        return self._result(defn, "pass", None, gc)

    def _check_2_5(self, defn: CheckDefinition, ctx: dict[str, Any]) -> CheckResult:
        iv = ctx["inv_number_val"]
        if iv.get("alert") and "Data Missing" in iv["alert"]:
            return self._result(defn, "data_missing", iv["alert"], iv)
        alerts = iv.get("alerts", [])
        if alerts:
            has_duplicate = any("Duplicate" in a for a in alerts)
            status: CheckStatus = "fail" if has_duplicate else "warning"
            return self._result(defn, status, "; ".join(alerts), iv)
        return self._result(defn, "pass", None, iv)

    def _check_2_6(self, defn: CheckDefinition, ctx: dict[str, Any]) -> CheckResult:
        bv = ctx["bank_validation"]
        if bv.get("alert") and "Data Missing" in bv["alert"]:
            return self._result(defn, "data_missing", bv["alert"], bv)
        if not bv.get("valid", True):
            return self._result(defn, "fail", "; ".join(bv.get("alerts", ["Invalid bank details."])), bv)
        return self._result(defn, "pass", None, bv)

    def _check_2_7(self, defn: CheckDefinition, ctx: dict[str, Any]) -> CheckResult:
        ev = ctx["einvoice_validation"]
        if ev.get("alert") and "Data Missing" in ev["alert"]:
            return self._result(defn, "data_missing", ev["alert"], ev)
        if not ev.get("irn_present", True):
            return self._result(defn, "warning", ev.get("alert", "IRN not found."), ev)
        return self._result(defn, "pass", None, ev)

    def _check_3_1(self, defn: CheckDefinition, ctx: dict[str, Any]) -> CheckResult:
        tc = ctx["template_check"]
        if not tc.get("available", True) and not tc.get("template_match", True):
            return self._result(defn, "data_missing", f"Data Missing: {tc.get('reason', 'Template check not available.')}", tc)
        if tc.get("is_baseline"):
            return self._result(defn, "pass", "First invoice - baseline established.", tc)
        alerts = tc.get("alerts", [])
        if alerts:
            return self._result(defn, "warning", "; ".join(alerts), tc)
        if tc.get("template_match") is False:
            return self._result(defn, "warning", f"Template match score: {tc.get('match_score', 0)}%", tc)
        return self._result(defn, "pass", None, tc)

    def _check_3_2(self, defn: CheckDefinition, ctx: dict[str, Any]) -> CheckResult:
        pc = ctx["pricing_check"]
        if pc.get("items_checked", 0) == 0:
            return self._result(defn, "data_missing", pc.get("reason", "Data Missing: No pricing data."), pc)
        if pc.get("variance_detected"):
            return self._result(defn, "warning", "; ".join(pc.get("alerts", ["Price variance detected."])), pc)
        return self._result(defn, "pass", None, pc)

    def _check_3_3(self, defn: CheckDefinition, ctx: dict[str, Any]) -> CheckResult:
        fc = ctx["frequency_check"]
        if fc.get("invoice_count", 0) < 3:
            return self._result(defn, "data_missing", fc.get("reason", "Data Missing: Insufficient history."), fc)
        if not fc.get("pattern_normal"):
            return self._result(defn, "warning", "; ".join(fc.get("alerts", ["Abnormal pattern."])), fc)
        return self._result(defn, "pass", None, fc)

    def _check_3_4(self, defn: CheckDefinition, ctx: dict[str, Any]) -> CheckResult:
        ac = ctx["address_check"]
        if ac.get("alert") and "Data Missing" in ac.get("alert", ""):
            return self._result(defn, "data_missing", ac["alert"], ac)
        if not ac.get("consistent", True):
            return self._result(defn, "warning", "; ".join(ac.get("alerts", ["Address inconsistency."])), ac)
        return self._result(defn, "pass", None, ac)

    def _check_3_5(self, defn: CheckDefinition, ctx: dict[str, Any]) -> CheckResult:
        tc = ctx["terms_check"]
        if tc.get("alert") and "Data Missing" in tc.get("alert", ""):
            return self._result(defn, "data_missing", tc["alert"], tc)
        if tc.get("variance_detected"):
            return self._result(defn, "warning", "; ".join(tc.get("alerts", ["T&C variance."])), tc)
        return self._result(defn, "pass", None, tc)

    def _check_4_1(self, defn: CheckDefinition, ctx: dict[str, Any]) -> CheckResult:
        ed = ctx["exact_dup"]
        if ed.get("alert") and "Data Missing" in ed.get("alert", ""):
            return self._result(defn, "data_missing", ed["alert"], ed)
        if ed.get("is_duplicate"):
            return self._result(defn, "fail", ed.get("alert", "Exact duplicate detected."), ed)
        return self._result(defn, "pass", None, ed)

    def _check_4_2(self, defn: CheckDefinition, ctx: dict[str, Any]) -> CheckResult:
        nd = ctx["near_dup"]
        if not nd.get("available", True):
            return self._result(defn, "data_missing", f"Data Missing: {nd.get('reason', 'Fuzzy matching not available.')}", nd)
        if nd.get("is_duplicate"):
            return self._result(defn, "warning", nd.get("alert", "Near-duplicate detected."), nd)
        return self._result(defn, "pass", None, nd)

    def _check_4_3(self, defn: CheckDefinition, ctx: dict[str, Any]) -> CheckResult:
        pg = ctx["po_grn"]
        if pg.get("alert") and "Data Missing" in pg.get("alert", ""):
            return self._result(defn, "data_missing", pg["alert"], pg)
        if not pg.get("matched", True):
            return self._result(defn, "fail", "; ".join(pg.get("alerts", ["3-way match failed."])), pg)
        return self._result(defn, "pass", None, pg)

    def _check_4_4(self, defn: CheckDefinition, ctx: dict[str, Any]) -> CheckResult:
        id_ = ctx["image_dup"]
        if not id_.get("available", True):
            return self._result(defn, "not_applicable", id_.get("reason", "Image hashing not applicable."), id_)
        if id_.get("is_duplicate"):
            return self._result(defn, "fail", id_.get("alert", "Image duplicate detected."), id_)
        return self._result(defn, "pass", None, id_)

    def _check_4_5(self, defn: CheckDefinition, ctx: dict[str, Any]) -> CheckResult:
        cd = ctx["content_dup"]
        if not cd.get("available", True):
            return self._result(defn, "data_missing", f"Data Missing: {cd.get('reason', 'OCR content comparison not available.')}", cd)
        if cd.get("is_duplicate"):
            return self._result(defn, "warning", cd.get("alert", "Content duplicate detected."), cd)
        return self._result(defn, "pass", None, cd)

    def _check_5_1(self, defn: CheckDefinition, ctx: dict[str, Any]) -> CheckResult:
        vr = ctx["vendor_risk"]
        score = vr.get("risk_score", 0)
        level = vr.get("risk_level", "Low")
        if level == "Critical":
            return self._result(defn, "fail", f"Vendor risk: {level} ({score}/100). {vr.get('recommended_action', '')}", vr)
        if level == "High":
            return self._result(defn, "warning", f"Vendor risk: {level} ({score}/100). {vr.get('recommended_action', '')}", vr)
        if level == "Medium":
            return self._result(defn, "warning", f"Vendor risk: {level} ({score}/100).", vr)
        return self._result(defn, "pass", None, vr)

    def _check_5_2(self, defn: CheckDefinition, ctx: dict[str, Any]) -> CheckResult:
        an = ctx["anomaly"]
        if an.get("is_anomaly"):
            factors = ", ".join(an.get("anomaly_factors", []))
            return self._result(defn, "warning", f"Statistical anomaly detected: {factors}", an)
        return self._result(defn, "pass", None, an)

    def _check_5_3(self, defn: CheckDefinition, ctx: dict[str, Any]) -> CheckResult:
        ec = ctx["expense_correlation"]
        if ec.get("alert") and "Data Missing" in ec.get("alert", ""):
            return self._result(defn, "data_missing", ec["alert"], ec)
        if not ec.get("correlated", True):
            return self._result(defn, "warning", "; ".join(ec.get("alerts", ["Weak expense correlation."])), ec)
        return self._result(defn, "pass", None, ec)

    def _check_5_4(self, defn: CheckDefinition, ctx: dict[str, Any]) -> CheckResult:
        co = ctx["collusion"]
        if co.get("alert") and "Data Missing" in co.get("alert", ""):
            return self._result(defn, "data_missing", co["alert"], co)
        if co.get("collusion_detected"):
            return self._result(defn, "fail", "; ".join(co.get("alerts", ["Collusion indicators found."])), co)
        return self._result(defn, "pass", None, co)

    def _check_5_5(self, defn: CheckDefinition, ctx: dict[str, Any]) -> CheckResult:
        th = ctx["threshold"]
        if th.get("split_detected"):
            return self._result(defn, "warning", "; ".join(th.get("alerts", ["Threshold circumvention pattern."])), th)
        if th.get("threshold_proximity"):
            return self._result(defn, "warning", "; ".join(th.get("alerts", ["Near approval threshold."])), th)
        return self._result(defn, "pass", None, th)

    def _default_handler(self, defn: CheckDefinition, ctx: dict[str, Any]) -> CheckResult:
        return self._result(defn, "data_missing", "Data Missing: Check not yet implemented.", {})

    _CHECK_HANDLERS: dict[str, Any] = {
        "1.1": _check_1_1, "1.2": _check_1_2, "1.3": _check_1_3, "1.4": _check_1_4,
        "2.1": _check_2_1, "2.2": _check_2_2, "2.3": _check_2_3, "2.4": _check_2_4,
        "2.5": _check_2_5, "2.6": _check_2_6, "2.7": _check_2_7,
        "3.1": _check_3_1, "3.2": _check_3_2, "3.3": _check_3_3, "3.4": _check_3_4, "3.5": _check_3_5,
        "4.1": _check_4_1, "4.2": _check_4_2, "4.3": _check_4_3, "4.4": _check_4_4, "4.5": _check_4_5,
        "5.1": _check_5_1, "5.2": _check_5_2, "5.3": _check_5_3, "5.4": _check_5_4, "5.5": _check_5_5,
    }

    # ── Helpers ──────────────────────────────────────────────────────

    @staticmethod
    def _result(
        defn: CheckDefinition,
        status: CheckStatus,
        alert: str | None,
        details: dict[str, Any],
    ) -> CheckResult:
        return CheckResult(
            check_id=defn.check_id,
            category=defn.category,
            check_name=defn.check_name,
            status=status,
            alert=alert,
            risk_indicator=defn.risk_indicator,
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
