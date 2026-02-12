from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

try:
    import gspread
    from google.oauth2.service_account import Credentials

    GSPREAD_AVAILABLE = True
except ImportError:
    GSPREAD_AVAILABLE = False

logger = logging.getLogger(__name__)

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]


class GoogleSheetsService:
    """Spool audit results and insights to Google Sheets."""

    def __init__(self) -> None:
        self._client: Any | None = None
        self._spreadsheet_id: str | None = None
        self._sheet_name: str = "AuditLens Results"
        self._configured: bool = False

    @property
    def is_configured(self) -> bool:
        return self._configured and self._client is not None

    def configure(
        self,
        spreadsheet_id: str,
        credentials_json: str | None = None,
        credentials_path: str | None = None,
        sheet_name: str = "AuditLens Results",
    ) -> dict[str, Any]:
        if not GSPREAD_AVAILABLE:
            return {"success": False, "error": "gspread not installed. Run: pip install gspread google-auth"}

        self._spreadsheet_id = spreadsheet_id
        self._sheet_name = sheet_name

        try:
            if credentials_json:
                creds_dict = json.loads(credentials_json)
                creds = Credentials.from_service_account_info(creds_dict, scopes=SCOPES)
            elif credentials_path:
                creds = Credentials.from_service_account_file(credentials_path, scopes=SCOPES)
            else:
                return {"success": False, "error": "No credentials provided."}

            self._client = gspread.authorize(creds)
            self._configured = True

            # Verify access & setup headers
            self._ensure_headers()

            return {"success": True, "spreadsheet_id": spreadsheet_id, "sheet_name": sheet_name}
        except Exception as exc:
            self._configured = False
            return {"success": False, "error": str(exc)}

    def export_audit_result(self, audit_result: dict[str, Any]) -> dict[str, Any]:
        if not self.is_configured:
            return {"success": False, "error": "Google Sheets not configured."}

        try:
            spreadsheet = self._client.open_by_key(self._spreadsheet_id)
            try:
                worksheet = spreadsheet.worksheet(self._sheet_name)
            except gspread.WorksheetNotFound:
                worksheet = spreadsheet.add_worksheet(
                    title=self._sheet_name, rows=1000, cols=40
                )
                self._write_headers(worksheet)

            row = self._format_row(audit_result)
            worksheet.append_row(row, value_input_option="USER_ENTERED")

            return {"success": True, "rows_written": 1}
        except Exception as exc:
            logger.error("Failed to write to Google Sheets: %s", exc)
            return {"success": False, "error": str(exc)}

    def export_batch(self, audit_results: list[dict[str, Any]]) -> dict[str, Any]:
        if not self.is_configured:
            return {"success": False, "error": "Google Sheets not configured."}

        try:
            spreadsheet = self._client.open_by_key(self._spreadsheet_id)
            try:
                worksheet = spreadsheet.worksheet(self._sheet_name)
            except gspread.WorksheetNotFound:
                worksheet = spreadsheet.add_worksheet(
                    title=self._sheet_name, rows=1000, cols=40
                )
                self._write_headers(worksheet)

            rows = [self._format_row(r) for r in audit_results]
            worksheet.append_rows(rows, value_input_option="USER_ENTERED")

            return {"success": True, "rows_written": len(rows)}
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    def export_insights(self, insights: dict[str, Any]) -> dict[str, Any]:
        """Write analytics insights to a separate 'Insights' sheet."""
        if not self.is_configured:
            return {"success": False, "error": "Google Sheets not configured."}

        try:
            spreadsheet = self._client.open_by_key(self._spreadsheet_id)
            sheet_name = "AuditLens Insights"
            try:
                worksheet = spreadsheet.worksheet(sheet_name)
            except gspread.WorksheetNotFound:
                worksheet = spreadsheet.add_worksheet(
                    title=sheet_name, rows=500, cols=20
                )

            timestamp = datetime.now(timezone.utc).isoformat()
            rows = [
                [timestamp, "Total Audits", str(insights.get("total_audits", 0))],
                [timestamp, "Avg Risk Score", str(insights.get("avg_risk_score", 0))],
                [timestamp, "High Risk Count", str(insights.get("high_risk_count", 0))],
                [timestamp, "Duplicates Found", str(insights.get("duplicates_found", 0))],
                [timestamp, "Anomalies Detected", str(insights.get("anomalies_detected", 0))],
                [timestamp, "Top Risk Category", str(insights.get("top_risk_category", "N/A"))],
            ]

            worksheet.append_rows(rows, value_input_option="USER_ENTERED")
            return {"success": True, "insights_written": len(rows)}
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    def _ensure_headers(self) -> None:
        try:
            spreadsheet = self._client.open_by_key(self._spreadsheet_id)
            try:
                worksheet = spreadsheet.worksheet(self._sheet_name)
                first_row = worksheet.row_values(1)
                if not first_row:
                    self._write_headers(worksheet)
            except gspread.WorksheetNotFound:
                worksheet = spreadsheet.add_worksheet(
                    title=self._sheet_name, rows=1000, cols=40
                )
                self._write_headers(worksheet)
        except Exception as exc:
            logger.warning("Could not verify headers: %s", exc)

    @staticmethod
    def _write_headers(worksheet: Any) -> None:
        headers = [
            "Timestamp",
            "File Name",
            "Composite Risk Score",
            "Risk Level",
            "Alerts",
            "GSTIN",
            "GSTIN Valid",
            "PAN",
            "Entity Type",
            "HSN/SAC",
            "Tax Rate Match",
            "Metadata Tampering",
            "ELA Flagged",
            "Font Consistent",
            "Doc Quality Score",
            "GST Calc Verified",
            "Invoice Number Valid",
            "Bank Details Valid",
            "E-Invoice/IRN Valid",
            "Template Match Score",
            "Pricing Variance",
            "Frequency Normal",
            "Address Consistent",
            "T&C Variance",
            "Exact Duplicate",
            "Near Duplicate",
            "PO/GRN Match",
            "Image Duplicate",
            "Content Duplicate",
            "Vendor Risk Score",
            "Anomaly Detected",
            "Expense Correlated",
            "Collusion Flag",
            "Threshold Circumvention",
        ]
        worksheet.update("A1", [headers])

    @staticmethod
    def _format_row(audit_result: dict[str, Any]) -> list[str]:
        checks = {c["check_id"]: c for c in audit_result.get("checks", [])}
        metadata = audit_result.get("metadata", {})
        risk_score = audit_result.get("composite_risk_score", 0)

        def _status(check_id: str) -> str:
            c = checks.get(check_id)
            return c["status"] if c else "N/A"

        def _detail(check_id: str, key: str, default: str = "") -> str:
            c = checks.get(check_id)
            if c:
                return str(c.get("details", {}).get(key, default))
            return default

        if risk_score >= 70:
            level = "High"
        elif risk_score >= 40:
            level = "Medium"
        else:
            level = "Low"

        return [
            datetime.now(timezone.utc).isoformat(),
            str(metadata.get("file_name", "")),
            str(risk_score),
            level,
            "; ".join(audit_result.get("alerts", [])),
            str(metadata.get("gstin", {}).get("pan", "")),
            _status("2.1"),
            _detail("2.2", "pan"),
            _detail("2.2", "entity_type"),
            _detail("2.3", "code", ""),
            _status("2.3"),
            _status("1.1"),
            _status("1.2"),
            _status("1.3"),
            _detail("1.4", "quality_score", ""),
            _status("2.4"),
            _status("2.5"),
            _status("2.6"),
            _status("2.7"),
            _detail("3.1", "match_score", ""),
            _status("3.2"),
            _status("3.3"),
            _status("3.4"),
            _status("3.5"),
            _status("4.1"),
            _status("4.2"),
            _status("4.3"),
            _status("4.4"),
            _status("4.5"),
            _detail("5.1", "risk_score", ""),
            _status("5.2"),
            _status("5.3"),
            _status("5.4"),
            _status("5.5"),
        ]
