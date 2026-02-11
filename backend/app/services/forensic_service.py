import io
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageEnhance, UnidentifiedImageError
from PyPDF2 import PdfReader


class ForensicService:
    EDITING_SOFTWARE_KEYWORDS = ["photoshop", "canva", "illustrator", "gimp", "coreldraw"]

    def extract_metadata(self, filename: str, file_bytes: bytes) -> dict[str, Any]:
        extension = Path(filename).suffix.lower()

        if extension == ".pdf":
            return self._extract_pdf_metadata(file_bytes)

        return self._extract_image_metadata(file_bytes)

    def _extract_pdf_metadata(self, file_bytes: bytes) -> dict[str, Any]:
        try:
            reader = PdfReader(io.BytesIO(file_bytes))
            metadata = reader.metadata or {}
            normalized = {str(key): str(value) for key, value in metadata.items()}
            suspicious_software = self._detect_editing_software(normalized)
            return {
                "file_type": "pdf",
                "metadata": normalized,
                "suspicious_software": suspicious_software,
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
            metadata = {key: str(value) for key, value in image.info.items()}
            suspicious_software = self._detect_editing_software(metadata)
            return {
                "file_type": "image",
                "metadata": metadata,
                "suspicious_software": suspicious_software,
            }
        except (UnidentifiedImageError, OSError) as exc:
            return {
                "file_type": "image",
                "metadata": {},
                "suspicious_software": [],
                "error": f"Corrupt or unreadable image: {exc}",
            }

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

        buffer = io.BytesIO()
        original.save(buffer, format="JPEG", quality=quality)
        buffer.seek(0)
        recompressed = Image.open(buffer)

        diff = ImageChops.difference(original, recompressed)
        extrema = diff.getextrema()
        max_diff = max(channel_max for _, channel_max in extrema)

        if max_diff == 0:
            mean_diff = 0.0
        else:
            diff_data = list(diff.getdata())
            pixel_count = len(diff_data)
            total = sum(sum(pixel) / 3 for pixel in diff_data)
            mean_diff = total / pixel_count

        enhancer = ImageEnhance.Brightness(diff)
        _ = enhancer.enhance(255.0 / max(max_diff, 1))

        # Threshold is deliberately conservative; tune with labeled data later.
        ela_flagged = mean_diff > 12 or max_diff > 60

        return {
            "ela_possible": True,
            "ela_mean_diff": round(mean_diff, 2),
            "ela_max_diff": int(max_diff),
            "ela_flagged": ela_flagged,
        }

    def _detect_editing_software(self, metadata: dict[str, str]) -> list[str]:
        hits: set[str] = set()
        joined_values = " ".join(metadata.values()).lower()

        for keyword in self.EDITING_SOFTWARE_KEYWORDS:
            if keyword in joined_values:
                hits.add(keyword)

        return sorted(hits)
