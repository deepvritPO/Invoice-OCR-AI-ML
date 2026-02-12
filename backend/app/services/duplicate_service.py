from __future__ import annotations

import hashlib
import io
from typing import Any

from PIL import Image, UnidentifiedImageError

try:
    import imagehash

    IMAGEHASH_AVAILABLE = True
except ImportError:
    IMAGEHASH_AVAILABLE = False

try:
    from rapidfuzz import fuzz

    RAPIDFUZZ_AVAILABLE = True
except ImportError:
    RAPIDFUZZ_AVAILABLE = False

try:
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.metrics.pairwise import cosine_similarity

    SKLEARN_AVAILABLE = True
except ImportError:
    SKLEARN_AVAILABLE = False


class DuplicateService:
    """Handles all duplicate detection checks (4.1 - 4.5)."""

    def __init__(self) -> None:
        self._invoice_hashes: dict[str, dict[str, Any]] = {}
        self._image_hashes: dict[str, dict[str, Any]] = {}
        self._text_corpus: list[dict[str, Any]] = []

    # ── 4.1  Exact Duplicate Detection ───────────────────────────────

    def check_exact_duplicate(
        self,
        vendor_id: str | None,
        invoice_number: str | None,
        invoice_date: str | None,
        total_amount: float | None,
    ) -> dict[str, Any]:
        if not invoice_number:
            return {"is_duplicate": False, "alert": "Data Missing: No invoice number for duplicate check."}

        composite = f"{vendor_id or ''}|{invoice_number}|{invoice_date or ''}|{total_amount or ''}"
        hash_key = hashlib.sha256(composite.encode()).hexdigest()

        if hash_key in self._invoice_hashes:
            original = self._invoice_hashes[hash_key]
            return {
                "is_duplicate": True,
                "duplicate_type": "exact",
                "similarity_score": 1.0,
                "matching_invoice": original.get("invoice_number"),
                "original_date": original.get("date"),
                "alert": f"CRITICAL: Exact duplicate of invoice {original.get('invoice_number')} "
                         f"processed on {original.get('date')}.",
            }

        self._invoice_hashes[hash_key] = {
            "vendor_id": vendor_id,
            "invoice_number": invoice_number,
            "date": invoice_date,
            "amount": total_amount,
        }
        return {"is_duplicate": False, "hash": hash_key}

    # ── 4.2  Near-Duplicate (Fuzzy) Detection ────────────────────────

    def check_near_duplicate(
        self,
        vendor_id: str | None,
        invoice_number: str | None,
        invoice_date: str | None,
        total_amount: float | None,
    ) -> dict[str, Any]:
        if not RAPIDFUZZ_AVAILABLE:
            return {"available": False, "reason": "rapidfuzz not installed"}

        if not invoice_number and total_amount is None:
            return {"is_duplicate": False, "alert": "Data Missing: Insufficient data for fuzzy matching."}

        best_match: dict[str, Any] | None = None
        best_score = 0.0

        for _hash, record in self._invoice_hashes.items():
            score = 0.0
            components: dict[str, float] = {}

            # Invoice number similarity (30% weight)
            if invoice_number and record.get("invoice_number"):
                inv_sim = fuzz.ratio(invoice_number, record["invoice_number"]) / 100
                components["invoice_number"] = inv_sim
                score += inv_sim * 0.30

            # Amount similarity (30% weight) - within 1%
            if total_amount is not None and record.get("amount") is not None:
                rec_amount = record["amount"]
                if rec_amount > 0:
                    amt_diff = abs(total_amount - rec_amount) / rec_amount
                    amt_sim = max(0, 1 - amt_diff)
                    components["amount"] = amt_sim
                    score += amt_sim * 0.30

            # Date similarity (20% weight) - crude: exact match = 1
            if invoice_date and record.get("date"):
                date_sim = 1.0 if invoice_date == record["date"] else 0.5
                components["date"] = date_sim
                score += date_sim * 0.20

            # Vendor similarity (20% weight)
            if vendor_id and record.get("vendor_id"):
                vendor_sim = 1.0 if vendor_id == record["vendor_id"] else 0.0
                components["vendor"] = vendor_sim
                score += vendor_sim * 0.20

            if score > best_score:
                best_score = score
                best_match = {"record": record, "components": components}

        if best_score >= 0.85 and best_match:
            return {
                "is_duplicate": True,
                "duplicate_type": "near-duplicate",
                "similarity_score": round(best_score, 3),
                "matching_invoice": best_match["record"].get("invoice_number"),
                "match_components": best_match["components"],
                "alert": f"Near-duplicate detected (similarity: {best_score:.0%}). "
                         f"Matches invoice {best_match['record'].get('invoice_number')}.",
            }

        return {
            "is_duplicate": False,
            "best_similarity": round(best_score, 3) if best_score > 0 else 0,
        }

    # ── 4.4  Image Hash / Perceptual Duplicate Detection ─────────────

    def check_image_duplicate(
        self, file_bytes: bytes, filename: str
    ) -> dict[str, Any]:
        if not IMAGEHASH_AVAILABLE:
            return {"available": False, "reason": "imagehash not installed"}

        try:
            img = Image.open(io.BytesIO(file_bytes))
        except (UnidentifiedImageError, OSError):
            return {"available": False, "reason": "Cannot open image for hashing"}

        p_hash = str(imagehash.phash(img))
        d_hash = str(imagehash.dhash(img))
        a_hash = str(imagehash.average_hash(img))

        for stored_key, stored in self._image_hashes.items():
            p_distance = imagehash.hex_to_hash(p_hash) - imagehash.hex_to_hash(stored["phash"])
            d_distance = imagehash.hex_to_hash(d_hash) - imagehash.hex_to_hash(stored["dhash"])

            if p_distance < 5:
                modification = "identical"
                if p_distance == 0:
                    modification = "exact same image"
                elif d_distance < 3:
                    modification = "minor edits (brightness/crop)"
                return {
                    "is_duplicate": True,
                    "duplicate_type": "perceptual",
                    "hamming_distance": int(p_distance),
                    "modification_type": modification,
                    "matching_file": stored.get("filename"),
                    "alert": f"Image matches previously processed file '{stored.get('filename')}' "
                             f"(hamming distance: {p_distance}). Possible re-submission.",
                }

        self._image_hashes[p_hash] = {
            "phash": p_hash,
            "dhash": d_hash,
            "ahash": a_hash,
            "filename": filename,
        }
        return {"is_duplicate": False, "phash": p_hash, "dhash": d_hash}

    # ── 4.5  OCR Content Duplicate Detection ─────────────────────────

    def check_content_duplicate(
        self, raw_text: str, invoice_number: str | None
    ) -> dict[str, Any]:
        if not raw_text.strip():
            return {"available": False, "reason": "No OCR text for content comparison"}

        if not SKLEARN_AVAILABLE:
            return self._simple_content_check(raw_text, invoice_number)

        if not self._text_corpus:
            self._text_corpus.append({
                "text": raw_text,
                "invoice_number": invoice_number,
            })
            return {"is_duplicate": False, "corpus_size": 1}

        texts = [entry["text"] for entry in self._text_corpus] + [raw_text]
        vectorizer = TfidfVectorizer(stop_words="english", max_features=500)
        tfidf_matrix = vectorizer.fit_transform(texts)

        similarities = cosine_similarity(tfidf_matrix[-1:], tfidf_matrix[:-1])[0]
        max_sim_idx = int(similarities.argmax())
        max_sim = float(similarities[max_sim_idx])

        self._text_corpus.append({
            "text": raw_text,
            "invoice_number": invoice_number,
        })

        if max_sim >= 0.90:
            matched = self._text_corpus[max_sim_idx]
            return {
                "is_duplicate": True,
                "duplicate_type": "content",
                "similarity_score": round(max_sim, 3),
                "matching_invoice": matched.get("invoice_number"),
                "alert": f"OCR content {max_sim:.0%} similar to invoice "
                         f"{matched.get('invoice_number', 'unknown')}.",
            }

        return {
            "is_duplicate": False,
            "best_similarity": round(max_sim, 3),
            "corpus_size": len(self._text_corpus),
        }

    def _simple_content_check(self, raw_text: str, invoice_number: str | None) -> dict[str, Any]:
        """Fallback when scikit-learn is not available."""
        text_hash = hashlib.md5(raw_text.strip().encode()).hexdigest()  # noqa: S324
        for entry in self._text_corpus:
            existing_hash = hashlib.md5(entry["text"].strip().encode()).hexdigest()  # noqa: S324
            if text_hash == existing_hash:
                return {
                    "is_duplicate": True,
                    "duplicate_type": "content-exact",
                    "similarity_score": 1.0,
                    "matching_invoice": entry.get("invoice_number"),
                    "alert": "Exact OCR text content match found.",
                }

        self._text_corpus.append({"text": raw_text, "invoice_number": invoice_number})
        return {"is_duplicate": False, "corpus_size": len(self._text_corpus)}

    # ── 4.3  PO/GRN 3-way Matching (Framework) ──────────────────────

    def check_po_grn_match(self, po_data: dict[str, Any] | None, grn_data: dict[str, Any] | None,
                           invoice_data: dict[str, Any] | None) -> dict[str, Any]:
        if not po_data:
            return {"matched": False, "alert": "Data Missing: No PO data for 3-way match."}
        if not grn_data:
            return {"matched": False, "alert": "Data Missing: No GRN data for 3-way match."}
        if not invoice_data:
            return {"matched": False, "alert": "Data Missing: No invoice line data for 3-way match."}

        alerts: list[str] = []
        po_total = po_data.get("total", 0)
        grn_total = grn_data.get("total", 0)
        inv_total = invoice_data.get("total", 0)

        if inv_total > grn_total:
            alerts.append(f"Invoice total ({inv_total}) exceeds GRN total ({grn_total}).")
        if inv_total > po_total:
            alerts.append(f"Invoice total ({inv_total}) exceeds PO total ({po_total}).")

        return {
            "matched": len(alerts) == 0,
            "po_total": po_total,
            "grn_total": grn_total,
            "invoice_total": inv_total,
            "alerts": alerts,
        }
