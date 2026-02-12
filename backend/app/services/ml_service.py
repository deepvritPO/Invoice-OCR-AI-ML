from __future__ import annotations

import math
from collections import Counter
from typing import Any

try:
    import numpy as np
    from sklearn.ensemble import IsolationForest
    from sklearn.neighbors import LocalOutlierFactor

    SKLEARN_AVAILABLE = True
except ImportError:
    SKLEARN_AVAILABLE = False


class MLService:
    """AI/ML analytics for fraud detection (Checks 5.1-5.5)."""

    def __init__(self) -> None:
        self._training_data: list[dict[str, float]] = []
        self._isolation_forest: Any | None = None
        self._min_training_samples = 10

    # ── 5.1  Vendor Risk Scoring ─────────────────────────────────────

    def compute_vendor_risk_score(self, factors: dict[str, Any]) -> dict[str, Any]:
        """Weighted composite risk score from multiple validation results."""
        weights = {
            "gstin_status": 15,
            "metadata_tampering": 12,
            "ela_manipulation": 12,
            "font_inconsistency": 8,
            "document_quality": 5,
            "hsn_mismatch": 10,
            "gst_calculation_error": 10,
            "duplicate_detected": 20,
            "price_variance": 8,
            "anomaly_detected": 10,
        }

        score = 0.0
        triggered: list[str] = []

        for factor_name, weight in weights.items():
            value = factors.get(factor_name, 0)
            if isinstance(value, bool):
                value = 1.0 if value else 0.0
            contribution = value * weight
            score += contribution
            if contribution > 0:
                triggered.append(f"{factor_name}: +{contribution:.1f}")

        score = min(score, 100)

        if score <= 30:
            level = "Low"
            action = "Auto-approve"
        elif score <= 60:
            level = "Medium"
            action = "Manual review recommended"
        elif score <= 80:
            level = "High"
            action = "Hold payment for review"
        else:
            level = "Critical"
            action = "Block vendor - immediate investigation"

        return {
            "risk_score": round(score, 1),
            "risk_level": level,
            "recommended_action": action,
            "top_risk_factors": triggered[:5],
            "factor_count": len(triggered),
        }

    # ── 5.2  Anomaly Detection (Isolation Forest + Z-score) ──────────

    def detect_anomaly(self, invoice_features: dict[str, float]) -> dict[str, Any]:
        self._training_data.append(invoice_features)

        feature_names = ["amount", "line_items", "tax_rate", "day_of_month"]
        current = [invoice_features.get(f, 0.0) for f in feature_names]

        # Z-score analysis (works with any amount of data)
        z_score_result = self._z_score_analysis(current, feature_names)

        # Isolation Forest (needs minimum training data)
        if_result: dict[str, Any] = {"available": False}
        if SKLEARN_AVAILABLE and len(self._training_data) >= self._min_training_samples:
            if_result = self._isolation_forest_predict(current, feature_names)

        # Benford's Law on first digits of amounts
        benford_result = self._benford_analysis()

        is_anomaly = (
            z_score_result.get("is_outlier", False)
            or if_result.get("is_anomaly", False)
        )

        factors: list[str] = []
        factors.extend(z_score_result.get("outlier_features", []))
        if if_result.get("is_anomaly"):
            factors.append("Isolation Forest flagged")
        if not benford_result.get("benford_pass", True):
            factors.append("Benford's Law violation")

        confidence = 0.0
        if z_score_result.get("is_outlier"):
            confidence += 0.4
        if if_result.get("is_anomaly"):
            confidence += 0.4
        if not benford_result.get("benford_pass", True):
            confidence += 0.2

        return {
            "is_anomaly": is_anomaly,
            "anomaly_score": round(confidence * 100, 1),
            "anomaly_factors": factors,
            "z_score": z_score_result,
            "isolation_forest": if_result,
            "benford": benford_result,
            "confidence": round(confidence, 2),
            "training_samples": len(self._training_data),
        }

    def _z_score_analysis(
        self, current: list[float], feature_names: list[str]
    ) -> dict[str, Any]:
        if len(self._training_data) < 3:
            return {"available": False, "is_outlier": False}

        outlier_features: list[str] = []
        z_scores: dict[str, float] = {}

        for i, name in enumerate(feature_names):
            values = [d.get(name, 0.0) for d in self._training_data[:-1]]
            if not values:
                continue
            mean_val = sum(values) / len(values)
            std_val = (sum((v - mean_val) ** 2 for v in values) / len(values)) ** 0.5
            if std_val > 0:
                z = abs(current[i] - mean_val) / std_val
                z_scores[name] = round(z, 2)
                if z > 2.5:
                    outlier_features.append(f"{name} (z={z:.1f})")

        return {
            "available": True,
            "is_outlier": len(outlier_features) > 0,
            "z_scores": z_scores,
            "outlier_features": outlier_features,
        }

    def _isolation_forest_predict(
        self, current: list[float], feature_names: list[str]
    ) -> dict[str, Any]:
        if not SKLEARN_AVAILABLE:
            return {"available": False}

        try:
            training_matrix = []
            for d in self._training_data:
                row = [d.get(f, 0.0) for f in feature_names]
                training_matrix.append(row)

            X = np.array(training_matrix)
            model = IsolationForest(contamination=0.1, random_state=42)
            model.fit(X)

            sample = np.array([current])
            prediction = model.predict(sample)[0]
            score = float(model.decision_function(sample)[0])

            return {
                "available": True,
                "is_anomaly": prediction == -1,
                "anomaly_score": round(-score, 3),
            }
        except Exception as exc:
            return {"available": False, "error": str(exc)}

    def _benford_analysis(self) -> dict[str, Any]:
        """Apply Benford's Law to the first digits of invoice amounts."""
        amounts = [d.get("amount", 0.0) for d in self._training_data if d.get("amount", 0) > 0]
        if len(amounts) < 20:
            return {"available": False, "benford_pass": True, "reason": "Need 20+ invoices"}

        first_digits = []
        for a in amounts:
            first_char = str(abs(a)).lstrip("0").replace(".", "")
            if first_char:
                first_digits.append(int(first_char[0]))

        if not first_digits:
            return {"available": False, "benford_pass": True}

        counts = Counter(first_digits)
        total = len(first_digits)

        # Benford's expected distribution
        expected = {d: math.log10(1 + 1 / d) for d in range(1, 10)}

        chi_squared = 0.0
        observed_dist: dict[int, float] = {}
        for d in range(1, 10):
            observed = counts.get(d, 0) / total
            observed_dist[d] = round(observed, 3)
            exp = expected[d]
            chi_squared += ((observed - exp) ** 2) / exp

        # Critical value for chi-squared with 8 df at 0.05 significance: 15.507
        benford_pass = chi_squared < 15.507

        return {
            "available": True,
            "benford_pass": benford_pass,
            "chi_squared": round(chi_squared, 3),
            "observed_distribution": observed_dist,
            "sample_size": total,
        }

    # ── 5.3  Invoice-Expense Correlation ─────────────────────────────

    def check_expense_correlation(
        self, invoice_data: dict[str, Any], activity_data: dict[str, Any] | None
    ) -> dict[str, Any]:
        if not activity_data:
            return {
                "correlated": False,
                "alert": "Data Missing: No activity data for expense correlation.",
            }

        alerts: list[str] = []
        category = invoice_data.get("category", "general")
        amount = invoice_data.get("amount", 0)
        expected_range = activity_data.get("expected_range", {})
        min_expected = expected_range.get("min", 0)
        max_expected = expected_range.get("max", float("inf"))

        if amount < min_expected or amount > max_expected:
            alerts.append(
                f"Invoice amount ({amount}) outside expected range "
                f"({min_expected}-{max_expected}) for category '{category}'."
            )

        has_activity = activity_data.get("has_supporting_activity", True)
        if not has_activity:
            alerts.append(f"No supporting business activity found for '{category}' expense.")

        return {
            "correlated": len(alerts) == 0,
            "category": category,
            "amount": amount,
            "expected_range": expected_range,
            "alerts": alerts,
        }

    # ── 5.4  Multi-Vendor Collusion Detection ────────────────────────

    def detect_collusion(self, vendors: list[dict[str, Any]]) -> dict[str, Any]:
        if len(vendors) < 2:
            return {"collusion_detected": False, "reason": "Need 2+ vendors for analysis"}

        alerts: list[str] = []
        relationships: list[dict[str, str]] = []

        # Check shared attributes
        addresses = {}
        bank_accounts = {}
        phones = {}

        for v in vendors:
            vid = v.get("id", "unknown")
            addr = v.get("address", "").strip().lower()
            bank = v.get("bank_account", "")
            phone = v.get("phone", "")

            if addr and addr in addresses:
                relationships.append({
                    "type": "same_address",
                    "vendors": f"{addresses[addr]} & {vid}",
                })
                alerts.append(f"Vendors {addresses[addr]} and {vid} share the same address.")
            elif addr:
                addresses[addr] = vid

            if bank and bank in bank_accounts:
                relationships.append({
                    "type": "same_bank_account",
                    "vendors": f"{bank_accounts[bank]} & {vid}",
                })
                alerts.append(f"Vendors {bank_accounts[bank]} and {vid} share bank account.")
            elif bank:
                bank_accounts[bank] = vid

            if phone and phone in phones:
                relationships.append({
                    "type": "same_phone",
                    "vendors": f"{phones[phone]} & {vid}",
                })
            elif phone:
                phones[phone] = vid

        collusion_score = min(len(relationships) * 25, 100)

        return {
            "collusion_detected": len(relationships) > 0,
            "collusion_score": collusion_score,
            "relationships": relationships,
            "alerts": alerts,
            "vendors_analyzed": len(vendors),
        }

    # ── 5.5  Approval Threshold Circumvention Detection ──────────────

    def detect_threshold_circumvention(
        self,
        invoice_amount: float,
        thresholds: list[float] | None = None,
        recent_amounts: list[float] | None = None,
    ) -> dict[str, Any]:
        if thresholds is None:
            thresholds = [10000, 50000, 100000, 500000, 1000000]

        alerts: list[str] = []
        proximity: list[dict[str, Any]] = []

        for t in thresholds:
            if t > 0:
                pct = (invoice_amount / t) * 100
                if 90 <= pct < 100:
                    proximity.append({"threshold": t, "percentage": round(pct, 1)})
                    alerts.append(
                        f"Invoice at {pct:.1f}% of approval threshold {t:,.0f}."
                    )

        # Check for splitting patterns in recent amounts
        split_detected = False
        if recent_amounts and len(recent_amounts) >= 2:
            for t in thresholds:
                # Check if recent invoices + current sum to just above a threshold
                running_sum = invoice_amount
                related_invoices = 0
                for amt in sorted(recent_amounts, reverse=True)[:5]:
                    running_sum += amt
                    related_invoices += 1
                    if t * 0.95 <= running_sum <= t * 1.10:
                        split_detected = True
                        alerts.append(
                            f"Possible split: {related_invoices + 1} recent invoices "
                            f"sum to {running_sum:,.0f} (near threshold {t:,.0f})."
                        )
                        break

            # Round number analysis
            round_count = sum(1 for a in recent_amounts if a == int(a) and a % 1000 == 0)
            if round_count > len(recent_amounts) * 0.5:
                alerts.append("High frequency of round-number invoices detected.")

        return {
            "threshold_proximity": proximity,
            "split_detected": split_detected,
            "alerts": alerts,
            "pattern_score": min(len(alerts) * 20, 100),
        }
