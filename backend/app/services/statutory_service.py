from __future__ import annotations

import re
from typing import Any

from ..models.schemas import GSTINValidationResult, HSNValidationResult, PANValidationResult


class StatutoryService:
    GSTIN_PATTERN = re.compile(
        r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$"
    )
    PAN_PATTERN = re.compile(
        r"^[A-Z]{3}[PCHABGJLFT][A-Z][0-9]{4}[A-Z]$"
    )
    IFSC_PATTERN = re.compile(r"^[A-Z]{4}0[A-Z0-9]{6}$")

    ENTITY_TYPE_MAP = {
        "C": "Company",
        "P": "Individual",
        "H": "HUF",
        "F": "Firm",
        "A": "Association of Persons",
        "B": "Body of Individuals",
        "T": "Trust",
        "L": "Local Authority",
        "J": "Artificial Juridical Person",
        "G": "Government",
    }

    STATE_CODE_MAP = {
        "01": "Jammu & Kashmir", "02": "Himachal Pradesh", "03": "Punjab",
        "04": "Chandigarh", "05": "Uttarakhand", "06": "Haryana",
        "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh",
        "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh",
        "13": "Nagaland", "14": "Manipur", "15": "Mizoram",
        "16": "Tripura", "17": "Meghalaya", "18": "Assam",
        "19": "West Bengal", "20": "Jharkhand", "21": "Odisha",
        "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat",
        "26": "Dadra & Nagar Haveli and Daman & Diu",
        "27": "Maharashtra", "29": "Karnataka", "30": "Goa",
        "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu",
        "34": "Puducherry", "35": "Andaman & Nicobar Islands",
        "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh",
    }

    # Extended HSN/SAC master with ~40 common codes
    HSN_SAC_MASTER: dict[str, dict[str, Any]] = {
        "9983": {"description": "Professional services", "rate": 18.0, "type": "SAC"},
        "9984": {"description": "Telecommunication services", "rate": 18.0, "type": "SAC"},
        "9985": {"description": "Transport services", "rate": 5.0, "type": "SAC"},
        "9986": {"description": "Rental services", "rate": 18.0, "type": "SAC"},
        "9987": {"description": "Maintenance and repair", "rate": 18.0, "type": "SAC"},
        "9988": {"description": "Manufacturing services", "rate": 18.0, "type": "SAC"},
        "9971": {"description": "Financial services", "rate": 18.0, "type": "SAC"},
        "9972": {"description": "Real estate services", "rate": 12.0, "type": "SAC"},
        "9973": {"description": "Leasing services", "rate": 18.0, "type": "SAC"},
        "9954": {"description": "Construction services", "rate": 12.0, "type": "SAC"},
        "9961": {"description": "Education services", "rate": 0.0, "type": "SAC"},
        "9963": {"description": "Accommodation services", "rate": 12.0, "type": "SAC"},
        "9964": {"description": "Passenger transport", "rate": 5.0, "type": "SAC"},
        "9965": {"description": "Goods transport", "rate": 5.0, "type": "SAC"},
        "8471": {"description": "Computers & peripherals", "rate": 18.0, "type": "HSN"},
        "8443": {"description": "Printers & scanners", "rate": 18.0, "type": "HSN"},
        "8523": {"description": "Storage media", "rate": 18.0, "type": "HSN"},
        "8504": {"description": "Electrical transformers", "rate": 18.0, "type": "HSN"},
        "8517": {"description": "Telephones & smartphones", "rate": 12.0, "type": "HSN"},
        "7318": {"description": "Screws, bolts, nuts", "rate": 18.0, "type": "HSN"},
        "3004": {"description": "Medicaments", "rate": 12.0, "type": "HSN"},
        "3002": {"description": "Vaccines & blood products", "rate": 5.0, "type": "HSN"},
        "1001": {"description": "Wheat", "rate": 5.0, "type": "HSN"},
        "1006": {"description": "Rice", "rate": 5.0, "type": "HSN"},
        "1701": {"description": "Sugar", "rate": 5.0, "type": "HSN"},
        "2201": {"description": "Mineral water", "rate": 18.0, "type": "HSN"},
        "2202": {"description": "Aerated drinks", "rate": 28.0, "type": "HSN"},
        "4820": {"description": "Paper stationery", "rate": 12.0, "type": "HSN"},
        "4901": {"description": "Printed books", "rate": 0.0, "type": "HSN"},
        "6109": {"description": "T-shirts", "rate": 5.0, "type": "HSN"},
        "6110": {"description": "Jerseys, pullovers", "rate": 12.0, "type": "HSN"},
        "7308": {"description": "Iron/steel structures", "rate": 18.0, "type": "HSN"},
        "8415": {"description": "Air conditioners", "rate": 28.0, "type": "HSN"},
        "8418": {"description": "Refrigerators", "rate": 18.0, "type": "HSN"},
        "8528": {"description": "Monitors & TVs", "rate": 18.0, "type": "HSN"},
        "8703": {"description": "Motor vehicles", "rate": 28.0, "type": "HSN"},
        "9401": {"description": "Seats & furniture", "rate": 18.0, "type": "HSN"},
        "9403": {"description": "Other furniture", "rate": 18.0, "type": "HSN"},
        "9503": {"description": "Toys", "rate": 12.0, "type": "HSN"},
    }

    # ── 2.1  GSTIN Validation ────────────────────────────────────────

    def validate_gstin(self, gstin: str | None) -> GSTINValidationResult:
        if not gstin:
            return GSTINValidationResult(
                is_valid=False,
                alerts=["Data Missing: GSTIN not provided."],
            )

        cleaned = gstin.strip().upper()
        if not self.GSTIN_PATTERN.match(cleaned):
            return GSTINValidationResult(
                is_valid=False,
                alerts=["Invalid GSTIN format."],
            )

        alerts: list[str] = []
        state_code = cleaned[:2]
        state_name = self.STATE_CODE_MAP.get(state_code)
        if state_name is None:
            alerts.append(f"Invalid state code: {state_code}.")

        pan = cleaned[2:12]
        entity_code = pan[3]
        entity_type = self.ENTITY_TYPE_MAP.get(entity_code)

        # Validate check digit using Modulo 36 algorithm
        if not self._verify_gstin_checksum(cleaned):
            alerts.append("GSTIN check digit (Mod 36) verification failed.")

        if entity_type is None:
            alerts.append(f"Unknown PAN entity type code: {entity_code}.")

        return GSTINValidationResult(
            is_valid=len(alerts) == 0,
            pan=pan,
            entity_type=entity_type,
            state_code=state_code,
            registration_status="Format Valid",
            alerts=alerts,
        )

    @staticmethod
    def _verify_gstin_checksum(gstin: str) -> bool:
        """Verify GSTIN check digit using the Modulo 36 algorithm."""
        chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        factor = 1
        total = 0
        code_point_count = len(chars)

        for i in range(len(gstin) - 1):
            cp = chars.index(gstin[i])
            product = factor * cp
            factor = 2 if factor == 1 else 1
            total += product // code_point_count + product % code_point_count

        remainder = total % code_point_count
        check_digit = chars[(code_point_count - remainder) % code_point_count]
        return gstin[-1] == check_digit

    # ── 2.2  PAN Validation ──────────────────────────────────────────

    def validate_pan(self, pan: str | None) -> PANValidationResult:
        if not pan:
            return PANValidationResult(
                is_valid=False,
                alerts=["Data Missing: PAN not provided."],
            )

        cleaned = pan.strip().upper()
        if not self.PAN_PATTERN.match(cleaned):
            return PANValidationResult(
                is_valid=False,
                pan=cleaned,
                alerts=["Invalid PAN format."],
            )

        entity_code = cleaned[3]
        entity_type = self.ENTITY_TYPE_MAP.get(entity_code)
        alerts: list[str] = []
        if entity_type is None:
            alerts.append(f"Unknown entity type code: {entity_code}.")

        return PANValidationResult(
            is_valid=True,
            pan=cleaned,
            entity_type=entity_type,
            entity_code=entity_code,
            alerts=alerts,
        )

    # ── 2.3  HSN/SAC Validation ──────────────────────────────────────

    def validate_hsn_sac(
        self, hsn_or_sac: str | None, claimed_tax_rate: float | None
    ) -> HSNValidationResult:
        if not hsn_or_sac:
            return HSNValidationResult(
                is_valid=False,
                alert="Data Missing: HSN/SAC code not provided.",
            )

        cleaned = hsn_or_sac.strip()
        # HSN: 4/6/8 digits; SAC: 6 digits starting with 99
        if not re.match(r"^\d{4,8}$", cleaned):
            return HSNValidationResult(
                is_valid=False,
                code=cleaned,
                alert="Invalid HSN/SAC format (expected 4-8 digits).",
            )

        master_entry = self.HSN_SAC_MASTER.get(cleaned)
        code_type = "SAC" if cleaned.startswith("99") else "HSN"

        if master_entry is None:
            # Try prefix match (4-digit match for 6/8 digit codes)
            prefix = cleaned[:4]
            master_entry = self.HSN_SAC_MASTER.get(prefix)
            if master_entry is None:
                return HSNValidationResult(
                    is_valid=False,
                    code=cleaned,
                    code_type=code_type,
                    alert=f"{code_type} code not found in master.",
                )

        expected_rate = master_entry["rate"]

        if claimed_tax_rate is None:
            return HSNValidationResult(
                is_valid=False,
                code=cleaned,
                code_type=code_type,
                expected_tax_rate=expected_rate,
                alert="Data Missing: Claimed tax rate not provided.",
            )

        rate_match = abs(expected_rate - claimed_tax_rate) < 0.01
        return HSNValidationResult(
            is_valid=rate_match,
            code=cleaned,
            code_type=code_type,
            expected_tax_rate=expected_rate,
            claimed_tax_rate=claimed_tax_rate,
            rate_match=rate_match,
            alert=None if rate_match else (
                f"Tax rate mismatch: expected {expected_rate}%, claimed {claimed_tax_rate}%."
            ),
        )

    # ── 2.4  GST Calculation Verification ────────────────────────────

    def verify_gst_calculations(self, ocr_data: dict[str, Any]) -> dict[str, Any]:
        """Verify mathematical accuracy of GST amounts from OCR-extracted data."""
        alerts: list[str] = []
        taxable = ocr_data.get("taxable_amount")
        total = ocr_data.get("total_amount")
        cgst = ocr_data.get("cgst")
        sgst = ocr_data.get("sgst")
        igst = ocr_data.get("igst")

        if taxable is None or total is None:
            return {
                "verified": False,
                "alert": "Data Missing: Cannot verify GST - taxable amount or total not extracted.",
            }

        computed_tax = 0.0
        gst_type = "unknown"
        if cgst is not None and sgst is not None:
            computed_tax = cgst + sgst
            gst_type = "intra-state (CGST+SGST)"
            if abs(cgst - sgst) > 0.5:
                alerts.append(f"CGST ({cgst}) and SGST ({sgst}) should be equal for intra-state.")
        elif igst is not None:
            computed_tax = igst
            gst_type = "inter-state (IGST)"
        else:
            return {
                "verified": False,
                "gst_type": gst_type,
                "alert": "Data Missing: No tax components (CGST/SGST/IGST) extracted.",
            }

        expected_total = taxable + computed_tax
        variance = abs(expected_total - total)
        if variance > 1.0:
            alerts.append(
                f"Total mismatch: Taxable({taxable}) + Tax({computed_tax}) = "
                f"{expected_total}, but invoice shows {total}. Variance: {variance:.2f}"
            )

        # Check line items
        line_items = ocr_data.get("line_items", [])
        line_errors: list[str] = []
        for i, item in enumerate(line_items):
            qty = item.get("quantity")
            rate = item.get("rate")
            amount = item.get("amount")
            if qty is not None and rate is not None and amount is not None:
                expected_amt = qty * rate
                if abs(expected_amt - amount) > 0.5:
                    line_errors.append(
                        f"Row {i + 1}: {qty} x {rate} = {expected_amt}, but shows {amount}"
                    )
        if line_errors:
            alerts.extend(line_errors)

        return {
            "verified": len(alerts) == 0,
            "gst_type": gst_type,
            "taxable_amount": taxable,
            "computed_tax": computed_tax,
            "expected_total": expected_total,
            "invoice_total": total,
            "variance": round(variance, 2),
            "alerts": alerts,
        }

    # ── 2.5  Invoice Number Validation ───────────────────────────────

    def validate_invoice_number(
        self, invoice_number: str | None, vendor_history: list[dict[str, Any]]
    ) -> dict[str, Any]:
        if not invoice_number:
            return {"valid": False, "alert": "Data Missing: Invoice number not extracted."}

        alerts: list[str] = []
        # Max 16 chars for GST compliance
        if len(invoice_number) > 16:
            alerts.append(f"Invoice number exceeds 16 characters ({len(invoice_number)}).")

        # Check for duplicates in history
        historical_numbers = [h.get("invoice_number") for h in vendor_history if h.get("invoice_number")]
        if invoice_number in historical_numbers:
            alerts.append(f"Duplicate invoice number: {invoice_number} found in history.")

        # Pattern learning from history
        if len(historical_numbers) >= 3:
            # Check if current number follows similar pattern
            pattern_match = self._check_number_pattern(invoice_number, historical_numbers)
            if not pattern_match:
                alerts.append("Invoice number pattern deviates from vendor's historical format.")

        return {
            "valid": len(alerts) == 0,
            "invoice_number": invoice_number,
            "length": len(invoice_number),
            "historical_count": len(historical_numbers),
            "alerts": alerts,
        }

    @staticmethod
    def _check_number_pattern(current: str, historical: list[str]) -> bool:
        """Simple pattern matching: check if current number has similar length and prefix."""
        if not historical:
            return True
        avg_len = sum(len(h) for h in historical) / len(historical)
        if abs(len(current) - avg_len) > 4:
            return False
        # Check common prefix
        if len(historical) >= 2:
            common_prefix_len = 0
            ref = historical[0]
            for i in range(min(len(ref), len(historical[1]))):
                if ref[i] == historical[1][i] and not ref[i].isdigit():
                    common_prefix_len += 1
                else:
                    break
            if common_prefix_len > 2 and current[:common_prefix_len] != ref[:common_prefix_len]:
                return False
        return True

    # ── 2.6  Bank Account Validation (IFSC) ──────────────────────────

    def validate_bank_details(
        self, ifsc: str | None, account_number: str | None
    ) -> dict[str, Any]:
        if not ifsc and not account_number:
            return {"valid": False, "alert": "Data Missing: No bank details provided."}

        alerts: list[str] = []
        if ifsc:
            cleaned_ifsc = ifsc.strip().upper()
            if not self.IFSC_PATTERN.match(cleaned_ifsc):
                alerts.append(f"Invalid IFSC format: {cleaned_ifsc}")
            else:
                bank_code = cleaned_ifsc[:4]
                alerts_extra = []  # Could add RBI API lookup here
                if alerts_extra:
                    alerts.extend(alerts_extra)

        if account_number:
            acc = account_number.strip()
            if not (9 <= len(acc) <= 18 and acc.isdigit()):
                alerts.append(f"Account number format suspicious (length: {len(acc)}).")

        return {
            "valid": len(alerts) == 0,
            "ifsc": ifsc,
            "account_number": account_number,
            "alerts": alerts,
        }

    # ── 2.7  E-Invoice / IRN Validation ──────────────────────────────

    def validate_einvoice(self, irn: str | None, qr_data: dict[str, Any] | None) -> dict[str, Any]:
        if not irn:
            return {
                "applicable": True,
                "irn_present": False,
                "alert": "Data Missing: IRN not found on invoice. E-Invoice may be required for vendors with turnover > 5 Cr.",
            }

        alerts: list[str] = []
        # IRN is a 64-character SHA256 hash
        if len(irn) != 64:
            alerts.append(f"IRN length invalid: expected 64 chars, got {len(irn)}.")

        if qr_data:
            # Cross-check QR decoded fields
            qr_gstin = qr_data.get("gstin")
            qr_irn = qr_data.get("irn")
            if qr_irn and qr_irn != irn:
                alerts.append("IRN from QR code doesn't match document IRN.")
            if qr_gstin:
                pass  # Cross-validate with invoice GSTIN

        return {
            "applicable": True,
            "irn_present": True,
            "irn": irn,
            "irn_length_valid": len(irn) == 64,
            "alerts": alerts,
        }
