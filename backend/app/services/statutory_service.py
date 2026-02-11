import re
from typing import Any

from ..models.schemas import GSTINValidationResult


class StatutoryService:
    GSTIN_PATTERN = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[A-Z0-9]{1}Z[A-Z0-9]{1}$")
    ENTITY_TYPE_MAP = {
        "C": "Company",
        "P": "Individual",
        "H": "HUF",
        "F": "Firm",
        "A": "Association of Persons",
        "T": "Trust",
        "L": "Local Authority",
        "J": "Artificial Juridical Person",
        "G": "Government",
    }

    def validate_gstin(self, gstin: str | None) -> GSTINValidationResult:
        alerts: list[str] = []

        if not gstin:
            return GSTINValidationResult(
                is_valid=False,
                pan=None,
                entity_type=None,
                alerts=["Data Missing: GSTIN not provided."],
            )

        cleaned = gstin.strip().upper()
        is_valid = bool(self.GSTIN_PATTERN.match(cleaned))

        if not is_valid:
            alerts.append("Invalid GSTIN format.")
            return GSTINValidationResult(is_valid=False, pan=None, entity_type=None, alerts=alerts)

        pan = cleaned[2:12]
        entity_code = pan[3]
        entity_type = self.ENTITY_TYPE_MAP.get(entity_code)

        if entity_type is None:
            alerts.append(f"Unknown PAN entity type code: {entity_code}.")

        return GSTINValidationResult(
            is_valid=True,
            pan=pan,
            entity_type=entity_type,
            alerts=alerts,
        )

    def validate_hsn_sac(self, hsn_or_sac: str | None, claimed_tax_rate: float | None) -> dict[str, Any]:
        mock_tax_master = {
            "9983": 18.0,
            "8471": 18.0,
            "1001": 5.0,
            "3004": 12.0,
        }

        if not hsn_or_sac:
            return {
                "is_valid": False,
                "expected_tax_rate": None,
                "alert": "Data Missing: HSN/SAC code not provided.",
            }

        expected_rate = mock_tax_master.get(hsn_or_sac)

        if expected_rate is None:
            return {
                "is_valid": False,
                "expected_tax_rate": None,
                "alert": "HSN/SAC code not found in master.",
            }

        if claimed_tax_rate is None:
            return {
                "is_valid": False,
                "expected_tax_rate": expected_rate,
                "alert": "Data Missing: Claimed tax rate not provided.",
            }

        is_match = abs(expected_rate - claimed_tax_rate) < 0.01
        return {
            "is_valid": is_match,
            "expected_tax_rate": expected_rate,
            "alert": None if is_match else "Claimed tax rate does not match master.",
        }
