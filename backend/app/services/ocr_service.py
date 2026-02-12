from __future__ import annotations

import io
import re
from pathlib import Path
from typing import Any

from PIL import Image, UnidentifiedImageError

from ..models.schemas import OCRResult

try:
    import pytesseract

    TESSERACT_AVAILABLE = True
except ImportError:
    TESSERACT_AVAILABLE = False

try:
    from pypdf import PdfReader

    PYPDF_AVAILABLE = True
except ImportError:
    PYPDF_AVAILABLE = False


_GSTIN_RE = re.compile(r"[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]")
_PAN_RE = re.compile(r"[A-Z]{3}[PCHABGJLFT][A-Z][0-9]{4}[A-Z]")
_INV_NO_RE = re.compile(r"(?:invoice\s*(?:no|number|#)[:\s]*)([\w\-/]+)", re.IGNORECASE)
_DATE_RE = re.compile(
    r"(?:date[:\s]*)?(\d{1,2}[/\-\.]\d{1,2}[/\-\.]\d{2,4})", re.IGNORECASE
)
_AMOUNT_RE = re.compile(
    r"(?:total|grand\s*total|net\s*amount|amount\s*payable)[:\s]*[₹$]?\s*([\d,]+\.?\d*)",
    re.IGNORECASE,
)
_CGST_RE = re.compile(r"CGST[:\s@%\d.]*[₹$]?\s*([\d,]+\.?\d*)", re.IGNORECASE)
_SGST_RE = re.compile(r"SGST[:\s@%\d.]*[₹$]?\s*([\d,]+\.?\d*)", re.IGNORECASE)
_IGST_RE = re.compile(r"IGST[:\s@%\d.]*[₹$]?\s*([\d,]+\.?\d*)", re.IGNORECASE)
_TAXABLE_RE = re.compile(
    r"(?:taxable\s*(?:value|amount)|sub\s*total)[:\s]*[₹$]?\s*([\d,]+\.?\d*)",
    re.IGNORECASE,
)
_HSN_RE = re.compile(r"\b(\d{4,8})\b")


def _parse_amount(text: str) -> float | None:
    try:
        return float(text.replace(",", ""))
    except (ValueError, AttributeError):
        return None


class OCRService:
    """Extract structured data from invoices using OCR."""

    def extract(self, filename: str, file_bytes: bytes) -> OCRResult:
        raw_text = self._extract_raw_text(filename, file_bytes)
        if not raw_text:
            return OCRResult(raw_text="", confidence=0.0)

        return OCRResult(
            raw_text=raw_text,
            invoice_number=self._find_invoice_number(raw_text),
            invoice_date=self._find_date(raw_text),
            vendor_name=self._find_vendor_name(raw_text),
            gstin=self._find_gstin(raw_text),
            pan=self._find_pan(raw_text),
            total_amount=self._find_amount(raw_text, _AMOUNT_RE),
            taxable_amount=self._find_amount(raw_text, _TAXABLE_RE),
            cgst=self._find_amount(raw_text, _CGST_RE),
            sgst=self._find_amount(raw_text, _SGST_RE),
            igst=self._find_amount(raw_text, _IGST_RE),
            hsn_codes=self._find_hsn_codes(raw_text),
            confidence=self._estimate_confidence(raw_text),
        )

    def _extract_raw_text(self, filename: str, file_bytes: bytes) -> str:
        ext = Path(filename).suffix.lower()
        if ext == ".pdf":
            return self._extract_pdf_text(file_bytes)
        return self._extract_image_text(file_bytes)

    def _extract_pdf_text(self, file_bytes: bytes) -> str:
        if not PYPDF_AVAILABLE:
            return ""
        try:
            reader = PdfReader(io.BytesIO(file_bytes))
            parts: list[str] = []
            for page in reader.pages:
                text = page.extract_text()
                if text:
                    parts.append(text)
            text = "\n".join(parts)
            if text.strip():
                return text
        except Exception:
            pass

        # Fall back to OCR on first page rendered as image
        if TESSERACT_AVAILABLE:
            try:
                img = Image.open(io.BytesIO(file_bytes))
                return pytesseract.image_to_string(img)
            except Exception:
                pass
        return ""

    def _extract_image_text(self, file_bytes: bytes) -> str:
        if not TESSERACT_AVAILABLE:
            return ""
        try:
            img = Image.open(io.BytesIO(file_bytes))
            return pytesseract.image_to_string(img)
        except (UnidentifiedImageError, OSError):
            return ""

    def _find_invoice_number(self, text: str) -> str | None:
        match = _INV_NO_RE.search(text)
        return match.group(1).strip() if match else None

    def _find_date(self, text: str) -> str | None:
        match = _DATE_RE.search(text)
        return match.group(1).strip() if match else None

    def _find_vendor_name(self, text: str) -> str | None:
        lines = [l.strip() for l in text.split("\n") if l.strip()]
        if lines:
            return lines[0][:120]
        return None

    def _find_gstin(self, text: str) -> str | None:
        match = _GSTIN_RE.search(text)
        return match.group(0) if match else None

    def _find_pan(self, text: str) -> str | None:
        match = _PAN_RE.search(text)
        return match.group(0) if match else None

    @staticmethod
    def _find_amount(text: str, pattern: re.Pattern[str]) -> float | None:
        match = pattern.search(text)
        if match:
            return _parse_amount(match.group(1))
        return None

    @staticmethod
    def _find_hsn_codes(text: str) -> list[str]:
        candidates = _HSN_RE.findall(text)
        valid: list[str] = []
        for c in candidates:
            if len(c) in (4, 6, 8) and not c.startswith("0"):
                valid.append(c)
        return sorted(set(valid))

    @staticmethod
    def _estimate_confidence(text: str) -> float:
        if not text.strip():
            return 0.0
        words = text.split()
        if len(words) < 5:
            return 0.1
        alpha_words = sum(1 for w in words if any(c.isalpha() for c in w))
        ratio = alpha_words / len(words) if words else 0
        return min(round(ratio, 2), 1.0)
