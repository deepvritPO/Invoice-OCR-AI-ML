# Code Review: AuditLens AI

## Overview

Forensic audit prototype for invoice verification with a FastAPI backend and React+Vite frontend. The codebase is clean and well-structured for a prototype but has several issues to address before production use.

---

## 1. Security Issues

### HIGH - CORS wildcard with credentials (`backend/app/main.py:14-20`)

`allow_origins=["*"]` combined with `allow_credentials=True` is a security misconfiguration. Per the CORS spec, browsers will reject credentialed requests when the origin is `*`. Either restrict `allow_origins` to specific domains or set `allow_credentials=False`.

### MEDIUM - No file size limit on upload (`backend/app/main.py:41`)

`file_bytes = await file.read()` reads the entire upload into memory with no size cap. A malicious client can exhaust server memory. Add a max file size check (e.g., reject files > 20 MB).

### MEDIUM - No file type validation (`backend/app/main.py:41`)

The endpoint accepts any file regardless of content type. The filename extension is trusted without verifying actual file content.

### LOW - History file race condition (`backend/app/services/history_service.py:14-18`)

`HistoryService.append()` has a read-modify-write race under concurrent requests. Production use needs a database or file locking.

### LOW - Hardcoded history path (`backend/app/main.py:25`)

`Path("backend/data/audit_history.json")` uses a relative path dependent on the working directory at startup.

---

## 2. Backend Code Quality

### `forensic_service.py`

- **Line 86-87**: Enhanced ELA image is computed but discarded (assigned to `_`). Wasted computation.
- **Line 90**: Hardcoded ELA thresholds (mean > 12, max > 60) will produce false positives on JPEGs with varying compression.

### `audit_service.py`

- **Line 146**: `# type: ignore[arg-type]` on status parameter. The `_result` method should accept `CheckStatus` instead of `str`.
- 21 of 26 checks return `"data_missing"` scaffolds, adding 63 points of baseline risk score noise.

### `statutory_service.py`

- **Line 54**: Hardcoded 4-entry mock tax master for HSN/SAC validation.

### `history_service.py`

- `read_all()` loads entire history into memory every time. Won't scale.

---

## 3. Frontend Code Quality

### `App.jsx`

- **Line 4**: Hardcoded `API_BASE_URL = 'http://localhost:8000'`. Should use an environment variable.
- **Lines 33-36**: Empty strings sent for optional fields cause the backend to treat them as invalid input rather than missing data.
- No result clearing when starting a new audit.

### `RiskScorecard.jsx`

- Clean component. `warning` and `data_missing` share the same CSS pill style which may confuse users.

---

## 4. Testing Gaps

- Only 3 unit tests covering GSTIN validation and control count.
- No API endpoint tests (despite `httpx` in requirements).
- No tests for `ForensicService`, `HistoryService`, or edge cases (corrupt files, empty strings, oversized uploads).
- `test_control_coverage_count` uses invalid PDF bytes, testing only the error path.

---

## 5. CI/CD Issues

- **Python 3.9 in CI matrix will fail**: Code uses `str | None` and `dict[str, str]` syntax requiring Python 3.10+.
- `actions/setup-python@v3` is outdated (current is v5).
- No frontend build/test step.
- Second flake8 pass uses `--exit-zero`, so style violations never fail the build.

---

## 6. Dependency Issues

- **PyPDF2 is deprecated** and renamed to `pypdf`. Migrate to `pypdf`.
- `pytest` and `httpx` are in `requirements.txt` (production deps file). Should be in dev dependencies.

---

## 7. Priority Fixes

| Priority | Issue | Location |
|----------|-------|----------|
| High | CORS misconfiguration | `main.py:14-20` |
| High | CI fails on Python 3.9 | `python-package.yml` + all backend |
| Medium | No upload file size limit | `main.py:41` |
| Medium | Empty string vs None form data | `App.jsx:33-36` |
| Medium | PyPDF2 deprecated | `requirements.txt` |
| Low | Wasted ELA computation | `forensic_service.py:86-87` |
| Low | Type ignore on CheckStatus | `audit_service.py:146` |
| Low | Hardcoded API URL | `App.jsx:4` |
| Low | Insufficient test coverage | `test_api.py` |
