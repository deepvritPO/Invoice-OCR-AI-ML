from __future__ import annotations

import io
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, UnidentifiedImageError

try:
    from pypdf import PdfReader

    PYPDF_AVAILABLE = True
except ImportError:
    PYPDF_AVAILABLE = False

try:
    import cv2
    import numpy as np

    CV2_AVAILABLE = True
except ImportError:
    CV2_AVAILABLE = False


class ForensicService:
    EDITING_SOFTWARE_KEYWORDS = ["photoshop", "canva", "illustrator", "gimp", "coreldraw"]

    # ── 1.1  Metadata Tampering Detection ────────────────────────────

    def extract_metadata(self, filename: str, file_bytes: bytes) -> dict[str, Any]:
        extension = Path(filename).suffix.lower()
        if extension == ".pdf":
            return self._extract_pdf_metadata(file_bytes)
        return self._extract_image_metadata(file_bytes)

    def _extract_pdf_metadata(self, file_bytes: bytes) -> dict[str, Any]:
        if not PYPDF_AVAILABLE:
            return {
                "file_type": "pdf",
                "metadata": {},
                "suspicious_software": [],
                "error": "pypdf not installed.",
            }
        try:
            reader = PdfReader(io.BytesIO(file_bytes))
            raw_meta = reader.metadata or {}
            normalized: dict[str, str] = {str(k): str(v) for k, v in raw_meta.items()}
            suspicious_software = self._detect_editing_software(normalized)
            incremental_saves = self._count_pdf_incremental_saves(file_bytes)
            modify_after_create = self._check_modify_after_create(normalized)

            return {
                "file_type": "pdf",
                "metadata": normalized,
                "suspicious_software": suspicious_software,
                "incremental_saves": incremental_saves,
                "modify_after_create": modify_after_create,
                "page_count": len(reader.pages),
            }
        except Exception as exc:
            return {
                "file_type": "pdf",
                "metadata": {},
                "suspicious_software": [],
                "error": f"Corrupt or unreadable PDF: {exc}",
            }

    def _extract_image_metadata(self, file_bytes: bytes) -> dict[str, Any]:
        try:
            image = Image.open(io.BytesIO(file_bytes))
            metadata: dict[str, str] = {str(k): str(v) for k, v in image.info.items()}
            suspicious_software = self._detect_editing_software(metadata)
            exif_data = self._extract_exif(image)

            return {
                "file_type": "image",
                "metadata": metadata,
                "suspicious_software": suspicious_software,
                "exif": exif_data,
                "format": image.format,
                "size": list(image.size),
                "mode": image.mode,
            }
        except (UnidentifiedImageError, OSError) as exc:
            return {
                "file_type": "image",
                "metadata": {},
                "suspicious_software": [],
                "error": f"Corrupt or unreadable image: {exc}",
            }

    @staticmethod
    def _extract_exif(image: Image.Image) -> dict[str, str]:
        exif: dict[str, str] = {}
        try:
            exif_data = image.getexif()
            if exif_data:
                for tag_id, value in exif_data.items():
                    exif[str(tag_id)] = str(value)[:200]
        except Exception:
            pass
        return exif

    @staticmethod
    def _count_pdf_incremental_saves(file_bytes: bytes) -> int:
        return file_bytes.count(b"%%EOF")

    @staticmethod
    def _check_modify_after_create(metadata: dict[str, str]) -> bool:
        create_keys = [k for k in metadata if "creation" in k.lower()]
        modify_keys = [k for k in metadata if "modify" in k.lower() or "moddate" in k.lower()]
        if create_keys and modify_keys:
            create_val = metadata.get(create_keys[0], "")
            modify_val = metadata.get(modify_keys[0], "")
            if create_val and modify_val and create_val != modify_val:
                return True
        return False

    # ── 1.2  Error Level Analysis (ELA) ──────────────────────────────

    def perform_ela(self, file_bytes: bytes, quality: int = 90) -> dict[str, Any]:
        try:
            original = Image.open(io.BytesIO(file_bytes)).convert("RGB")
        except (UnidentifiedImageError, OSError) as exc:
            return {
                "ela_possible": False,
                "ela_mean_diff": None,
                "ela_max_diff": None,
                "ela_flagged": False,
                "error": f"Unable to process image for ELA: {exc}",
            }

        buf = io.BytesIO()
        original.save(buf, format="JPEG", quality=quality)
        buf.seek(0)
        recompressed = Image.open(buf)

        diff = ImageChops.difference(original, recompressed)
        extrema = diff.getextrema()
        max_diff = max(ch_max for _, ch_max in extrema)

        if max_diff == 0:
            mean_diff = 0.0
        else:
            diff_data = list(diff.getdata())
            total = sum(sum(px) / 3 for px in diff_data)
            mean_diff = total / len(diff_data)

        localized = self._localized_ela_analysis(diff) if CV2_AVAILABLE else {}

        ela_flagged = mean_diff > 12 or max_diff > 60
        if localized.get("high_variance_regions", 0) > 0:
            ela_flagged = True

        return {
            "ela_possible": True,
            "ela_mean_diff": round(mean_diff, 2),
            "ela_max_diff": int(max_diff),
            "ela_flagged": ela_flagged,
            **localized,
        }

    @staticmethod
    def _localized_ela_analysis(diff_image: Image.Image) -> dict[str, Any]:
        if not CV2_AVAILABLE:
            return {}
        try:
            arr = np.array(diff_image)
            gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)

            h, w = gray.shape
            block_size = max(h, w) // 8
            if block_size < 10:
                return {"high_variance_regions": 0}

            block_means: list[float] = []
            for y in range(0, h - block_size, block_size):
                for x in range(0, w - block_size, block_size):
                    block = gray[y : y + block_size, x : x + block_size]
                    block_means.append(float(np.mean(block)))

            if len(block_means) < 4:
                return {"high_variance_regions": 0}

            overall_mean = np.mean(block_means)
            overall_std = np.std(block_means)
            high_var = sum(1 for m in block_means if m > overall_mean + 2 * overall_std)
            return {
                "high_variance_regions": int(high_var),
                "block_mean_std": round(float(overall_std), 2),
            }
        except Exception:
            return {"high_variance_regions": 0}

    # ── 1.3  Font Consistency Analysis ───────────────────────────────

    def analyze_font_consistency(self, file_bytes: bytes) -> dict[str, Any]:
        try:
            img = Image.open(io.BytesIO(file_bytes)).convert("RGB")
        except (UnidentifiedImageError, OSError):
            return {"available": False, "reason": "Cannot open image"}

        try:
            import pytesseract

            data = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT)
            confidences = [int(c) for c in data.get("conf", []) if int(c) > 0]
            if not confidences:
                return {"available": True, "font_consistent": True, "reason": "No text detected"}

            mean_conf = sum(confidences) / len(confidences)
            std_conf = (sum((c - mean_conf) ** 2 for c in confidences) / len(confidences)) ** 0.5

            flagged = std_conf > 25 or min(confidences) < 20
            return {
                "available": True,
                "font_consistent": not flagged,
                "mean_confidence": round(mean_conf, 1),
                "std_confidence": round(std_conf, 1),
                "word_count": len(confidences),
                "low_confidence_words": sum(1 for c in confidences if c < 40),
            }
        except ImportError:
            return {"available": False, "reason": "pytesseract not installed"}
        except Exception as exc:
            return {"available": False, "reason": str(exc)}

    # ── 1.4  Document Orientation & Quality Score ────────────────────

    def assess_document_quality(self, file_bytes: bytes) -> dict[str, Any]:
        try:
            img = Image.open(io.BytesIO(file_bytes)).convert("RGB")
        except (UnidentifiedImageError, OSError):
            return {"quality_score": 0, "issues": ["Cannot open image"]}

        issues: list[str] = []
        width, height = img.size

        dpi = img.info.get("dpi", (72, 72))
        avg_dpi = (dpi[0] + dpi[1]) / 2 if isinstance(dpi, tuple) else 72
        if avg_dpi < 150:
            issues.append(f"Low DPI ({avg_dpi})")

        if not CV2_AVAILABLE:
            quality_score = 50 if not issues else 30
            return {"quality_score": quality_score, "dpi": avg_dpi, "issues": issues}

        arr = np.array(img)
        gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)

        laplacian_var = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        if laplacian_var < 50:
            issues.append(f"Blurry image (Laplacian variance: {laplacian_var:.1f})")

        noise = float(np.std(gray.astype(float)))
        if noise > 80:
            issues.append(f"High noise level ({noise:.1f})")

        moire_detected = self._detect_moire(gray)
        if moire_detected:
            issues.append("Moiré pattern detected (possible screen photograph)")

        score = 100
        if avg_dpi < 150:
            score -= 25
        if laplacian_var < 50:
            score -= 25
        if noise > 80:
            score -= 15
        if moire_detected:
            score -= 30
        if width < 600 or height < 400:
            score -= 15
            issues.append("Low resolution image")

        return {
            "quality_score": max(0, score),
            "dpi": avg_dpi,
            "laplacian_variance": round(laplacian_var, 1),
            "noise_level": round(noise, 1),
            "moire_detected": moire_detected,
            "resolution": [width, height],
            "issues": issues,
        }

    @staticmethod
    def _detect_moire(gray: Any) -> bool:
        try:
            f_transform = np.fft.fft2(gray.astype(float))
            f_shift = np.fft.fftshift(f_transform)
            magnitude = np.log(np.abs(f_shift) + 1)

            h, w = magnitude.shape
            cy, cx = h // 2, w // 2
            ring = magnitude[cy - h // 4 : cy + h // 4, cx - w // 4 : cx + w // 4]
            overall_mean = float(np.mean(magnitude))
            ring_max = float(np.max(ring))
            return ring_max > overall_mean * 3.5
        except Exception:
            return False

    # ── Utility ──────────────────────────────────────────────────────

    def _detect_editing_software(self, metadata: dict[str, str]) -> list[str]:
        hits: set[str] = set()
        joined = " ".join(metadata.values()).lower()
        for keyword in self.EDITING_SOFTWARE_KEYWORDS:
            if keyword in joined:
                hits.add(keyword)
        return sorted(hits)
