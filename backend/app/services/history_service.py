from __future__ import annotations

import fcntl
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class HistoryService:
    def __init__(self, history_path: Path) -> None:
        self.history_path = history_path
        self.history_path.parent.mkdir(parents=True, exist_ok=True)
        if not self.history_path.exists():
            self.history_path.write_text("[]", encoding="utf-8")

    def append(self, record: dict[str, Any]) -> None:
        record["created_at"] = datetime.now(timezone.utc).isoformat()
        with open(self.history_path, "r+", encoding="utf-8") as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            try:
                content = f.read()
                history = json.loads(content) if content.strip() else []
                if not isinstance(history, list):
                    history = []
                history.append(record)
                f.seek(0)
                f.truncate()
                f.write(json.dumps(history, indent=2))
            finally:
                fcntl.flock(f, fcntl.LOCK_UN)

    def read_all(self) -> list[dict[str, Any]]:
        try:
            content = self.history_path.read_text(encoding="utf-8")
            data = json.loads(content)
            if isinstance(data, list):
                return data
            return []
        except (json.JSONDecodeError, OSError):
            return []

    def get_insights(self) -> dict[str, Any]:
        records = self.read_all()
        if not records:
            return {"total_audits": 0}

        scores = [r.get("composite_risk_score", 0) for r in records]
        high_risk = sum(1 for s in scores if s >= 70)
        alerts_count = sum(len(r.get("alerts", [])) for r in records)

        return {
            "total_audits": len(records),
            "avg_risk_score": round(sum(scores) / len(scores), 1) if scores else 0,
            "high_risk_count": high_risk,
            "total_alerts": alerts_count,
        }
