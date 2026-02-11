import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class HistoryService:
    def __init__(self, history_path: Path):
        self.history_path = history_path
        self.history_path.parent.mkdir(parents=True, exist_ok=True)
        if not self.history_path.exists():
            self.history_path.write_text("[]", encoding="utf-8")

    def append(self, record: dict[str, Any]) -> None:
        history = self.read_all()
        record["created_at"] = datetime.now(timezone.utc).isoformat()
        history.append(record)
        self.history_path.write_text(json.dumps(history, indent=2), encoding="utf-8")

    def read_all(self) -> list[dict[str, Any]]:
        try:
            content = self.history_path.read_text(encoding="utf-8")
            data = json.loads(content)
            if isinstance(data, list):
                return data
            return []
        except (json.JSONDecodeError, OSError):
            return []
