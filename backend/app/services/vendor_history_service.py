from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

try:
    import imagehash
    from PIL import Image
    import io

    IMAGEHASH_AVAILABLE = True
except ImportError:
    IMAGEHASH_AVAILABLE = False

try:
    from rapidfuzz import fuzz

    RAPIDFUZZ_AVAILABLE = True
except ImportError:
    RAPIDFUZZ_AVAILABLE = False


class VendorHistoryService:
    """Vendor history analysis for checks 3.1-3.5."""

    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self._vendor_cache: dict[str, dict[str, Any]] = {}

    def get_vendor_profile(self, vendor_id: str) -> dict[str, Any]:
        if vendor_id in self._vendor_cache:
            return self._vendor_cache[vendor_id]

        profile_path = self.data_dir / f"vendor_{vendor_id}.json"
        if profile_path.exists():
            try:
                data = json.loads(profile_path.read_text(encoding="utf-8"))
                self._vendor_cache[vendor_id] = data
                return data
            except (json.JSONDecodeError, OSError):
                pass

        return {
            "vendor_id": vendor_id,
            "invoices": [],
            "template_hashes": [],
            "prices": {},
            "addresses": [],
            "bank_accounts": [],
            "terms": [],
        }

    def update_vendor_profile(
        self, vendor_id: str, invoice_data: dict[str, Any]
    ) -> None:
        profile = self.get_vendor_profile(vendor_id)

        profile["invoices"].append({
            "invoice_number": invoice_data.get("invoice_number"),
            "date": invoice_data.get("invoice_date"),
            "amount": invoice_data.get("total_amount"),
            "timestamp": datetime.utcnow().isoformat(),
        })

        # Update price history
        for item in invoice_data.get("line_items", []):
            desc = item.get("description", "").strip().lower()
            price = item.get("rate") or item.get("unit_price")
            if desc and price:
                if desc not in profile["prices"]:
                    profile["prices"][desc] = []
                profile["prices"][desc].append(price)

        self._vendor_cache[vendor_id] = profile
        profile_path = self.data_dir / f"vendor_{vendor_id}.json"
        profile_path.write_text(json.dumps(profile, indent=2, default=str), encoding="utf-8")

    # ── 3.1  Invoice Template Consistency ────────────────────────────

    def check_template_consistency(
        self, file_bytes: bytes, vendor_id: str
    ) -> dict[str, Any]:
        if not IMAGEHASH_AVAILABLE:
            return {"available": False, "reason": "imagehash not installed"}

        try:
            img = Image.open(io.BytesIO(file_bytes))
            current_hash = str(imagehash.phash(img))
        except Exception:
            return {"available": False, "reason": "Cannot compute image hash"}

        profile = self.get_vendor_profile(vendor_id)
        stored_hashes = profile.get("template_hashes", [])

        if not stored_hashes:
            profile.setdefault("template_hashes", []).append(current_hash)
            self._save_profile(vendor_id, profile)
            return {
                "template_match": True,
                "match_score": 100,
                "reason": "First invoice from vendor - establishing baseline.",
                "is_baseline": True,
            }

        distances = []
        for stored in stored_hashes:
            dist = imagehash.hex_to_hash(current_hash) - imagehash.hex_to_hash(stored)
            distances.append(int(dist))

        min_distance = min(distances)
        match_score = max(0, 100 - min_distance * 3)

        # Store the new hash
        if current_hash not in stored_hashes:
            profile["template_hashes"].append(current_hash)
            if len(profile["template_hashes"]) > 20:
                profile["template_hashes"] = profile["template_hashes"][-20:]
            self._save_profile(vendor_id, profile)

        alerts: list[str] = []
        if match_score < 85:
            alerts.append(
                f"Template match score: {match_score}%. "
                f"Significant layout deviation from vendor baseline."
            )

        return {
            "template_match": match_score >= 85,
            "match_score": match_score,
            "hamming_distance": min_distance,
            "baseline_count": len(stored_hashes),
            "alerts": alerts,
        }

    # ── 3.2  Pricing Variance Analysis ───────────────────────────────

    def analyze_pricing_variance(
        self, line_items: list[dict[str, Any]], vendor_id: str
    ) -> dict[str, Any]:
        profile = self.get_vendor_profile(vendor_id)
        price_history = profile.get("prices", {})

        if not price_history:
            return {
                "variance_detected": False,
                "reason": "No historical pricing data for this vendor.",
                "items_checked": 0,
            }

        alerts: list[str] = []
        items_checked: list[dict[str, Any]] = []

        for item in line_items:
            desc = item.get("description", "").strip().lower()
            current_price = item.get("rate") or item.get("unit_price")
            if not desc or current_price is None:
                continue

            # Fuzzy match against historical items
            best_match_key = None
            best_match_score = 0

            if RAPIDFUZZ_AVAILABLE:
                for hist_key in price_history:
                    score = fuzz.ratio(desc, hist_key)
                    if score > best_match_score and score > 70:
                        best_match_score = score
                        best_match_key = hist_key
            else:
                best_match_key = price_history.get(desc) and desc

            if best_match_key and best_match_key in price_history:
                hist_prices = price_history[best_match_key]
                if hist_prices:
                    avg_price = sum(hist_prices) / len(hist_prices)
                    std_price = (
                        sum((p - avg_price) ** 2 for p in hist_prices) / len(hist_prices)
                    ) ** 0.5 if len(hist_prices) > 1 else 0

                    variance_pct = (
                        abs(current_price - avg_price) / avg_price * 100
                        if avg_price > 0 else 0
                    )

                    item_result = {
                        "description": desc,
                        "current_price": current_price,
                        "historical_avg": round(avg_price, 2),
                        "variance_pct": round(variance_pct, 1),
                        "last_price": hist_prices[-1],
                        "trend": "stable",
                    }

                    if len(hist_prices) >= 3:
                        recent = hist_prices[-3:]
                        if all(recent[i] <= recent[i + 1] for i in range(len(recent) - 1)):
                            item_result["trend"] = "increasing"
                        elif all(recent[i] >= recent[i + 1] for i in range(len(recent) - 1)):
                            item_result["trend"] = "decreasing"

                    if variance_pct > 25:
                        alerts.append(
                            f"Price spike for '{desc}': current {current_price} "
                            f"vs avg {avg_price:.2f} ({variance_pct:.0f}% variance)."
                        )

                    if std_price > 0 and abs(current_price - avg_price) > 2 * std_price:
                        item_result["outlier"] = True

                    items_checked.append(item_result)

        return {
            "variance_detected": len(alerts) > 0,
            "items_checked": len(items_checked),
            "item_details": items_checked,
            "alerts": alerts,
        }

    # ── 3.3  Invoice Frequency & Amount Pattern Analysis ─────────────

    def analyze_frequency_patterns(self, vendor_id: str) -> dict[str, Any]:
        profile = self.get_vendor_profile(vendor_id)
        invoices = profile.get("invoices", [])

        if len(invoices) < 3:
            return {
                "pattern_normal": True,
                "reason": "Insufficient history (need 3+ invoices).",
                "invoice_count": len(invoices),
            }

        amounts = [inv.get("amount", 0) for inv in invoices if inv.get("amount")]
        alerts: list[str] = []

        if amounts:
            avg_amount = sum(amounts) / len(amounts)
            latest_amount = amounts[-1] if amounts else 0

            # Check if latest amount is unusually high
            if avg_amount > 0 and latest_amount > avg_amount * 2:
                alerts.append(
                    f"Latest invoice amount ({latest_amount:,.2f}) is "
                    f"{latest_amount / avg_amount:.1f}x the average ({avg_amount:,.2f})."
                )

            # Round number analysis
            round_count = sum(1 for a in amounts if a == int(a) and a % 1000 == 0)
            if len(amounts) >= 5 and round_count > len(amounts) * 0.6:
                alerts.append(
                    f"High frequency of round numbers: {round_count}/{len(amounts)} invoices."
                )

        # Frequency analysis
        dates = []
        for inv in invoices:
            d = inv.get("date") or inv.get("timestamp")
            if d:
                try:
                    dates.append(datetime.fromisoformat(str(d).replace("Z", "+00:00")))
                except (ValueError, TypeError):
                    pass

        if len(dates) >= 3:
            dates.sort()
            gaps = [(dates[i + 1] - dates[i]).days for i in range(len(dates) - 1)]
            avg_gap = sum(gaps) / len(gaps) if gaps else 0
            if gaps and gaps[-1] < avg_gap * 0.3 and avg_gap > 5:
                alerts.append(
                    f"Unusual frequency spike: latest gap {gaps[-1]} days "
                    f"vs average {avg_gap:.0f} days."
                )

        return {
            "pattern_normal": len(alerts) == 0,
            "invoice_count": len(invoices),
            "avg_amount": round(sum(amounts) / len(amounts), 2) if amounts else 0,
            "alerts": alerts,
        }

    # ── 3.4  Address & Contact Consistency ───────────────────────────

    def check_address_consistency(
        self, current_address: str | None, vendor_id: str
    ) -> dict[str, Any]:
        if not current_address:
            return {"consistent": True, "alert": "Data Missing: No address extracted."}

        profile = self.get_vendor_profile(vendor_id)
        stored_addresses = profile.get("addresses", [])

        if not stored_addresses:
            profile.setdefault("addresses", []).append(current_address)
            self._save_profile(vendor_id, profile)
            return {
                "consistent": True,
                "reason": "First address recorded for vendor.",
            }

        # Compare with stored addresses
        best_match = 0
        if RAPIDFUZZ_AVAILABLE:
            for addr in stored_addresses:
                score = fuzz.ratio(current_address.lower(), addr.lower())
                best_match = max(best_match, score)
        else:
            for addr in stored_addresses:
                if current_address.strip().lower() == addr.strip().lower():
                    best_match = 100
                    break

        alerts: list[str] = []
        if best_match < 80:
            alerts.append(
                f"Address change detected (match score: {best_match}%). "
                f"Current address differs from master."
            )

        if current_address not in stored_addresses:
            profile["addresses"].append(current_address)
            self._save_profile(vendor_id, profile)

        return {
            "consistent": best_match >= 80,
            "match_score": best_match,
            "stored_addresses": len(stored_addresses),
            "alerts": alerts,
        }

    # ── 3.5  Terms & Conditions Variance ─────────────────────────────

    def check_terms_variance(
        self, current_terms: dict[str, Any] | None, vendor_id: str
    ) -> dict[str, Any]:
        if not current_terms:
            return {
                "variance_detected": False,
                "alert": "Data Missing: No T&C data extracted.",
            }

        profile = self.get_vendor_profile(vendor_id)
        stored_terms = profile.get("terms", [])

        if not stored_terms:
            profile.setdefault("terms", []).append(current_terms)
            self._save_profile(vendor_id, profile)
            return {
                "variance_detected": False,
                "reason": "First T&C recorded for vendor.",
            }

        alerts: list[str] = []
        last_terms = stored_terms[-1]

        # Compare payment terms
        current_payment = current_terms.get("payment_days")
        last_payment = last_terms.get("payment_days")
        if current_payment and last_payment and current_payment != last_payment:
            if current_payment < last_payment:
                alerts.append(
                    f"Payment terms shortened: {last_payment} days -> {current_payment} days (vendor benefit)."
                )
            else:
                alerts.append(
                    f"Payment terms changed: {last_payment} days -> {current_payment} days."
                )

        # Compare warranty
        current_warranty = current_terms.get("warranty_months")
        last_warranty = last_terms.get("warranty_months")
        if current_warranty and last_warranty and current_warranty < last_warranty:
            alerts.append(
                f"Warranty reduced: {last_warranty} months -> {current_warranty} months."
            )

        profile["terms"].append(current_terms)
        self._save_profile(vendor_id, profile)

        return {
            "variance_detected": len(alerts) > 0,
            "alerts": alerts,
        }

    def _save_profile(self, vendor_id: str, profile: dict[str, Any]) -> None:
        self._vendor_cache[vendor_id] = profile
        profile_path = self.data_dir / f"vendor_{vendor_id}.json"
        profile_path.write_text(
            json.dumps(profile, indent=2, default=str), encoding="utf-8"
        )
