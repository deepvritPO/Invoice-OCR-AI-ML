# AuditLens AI (Invoice-OCR-AI-ML)

AuditLens AI is a forensic audit prototype for invoice verification. It combines integrity checks (metadata + ELA), statutory checks (GSTIN/PAN/HSN-SAC), and a web dashboard for risk triage.

## Boilerplate First: Requirements + Folder Structure

### `requirements.txt`
Python backend dependencies:
- `fastapi`
- `uvicorn`
- `python-multipart`
- `pillow`
- `PyPDF2`
- `pytest`
- `httpx`

### Project layout

```text
backend/
  app/
    main.py
    models/schemas.py
    services/
      audit_service.py
      forensic_service.py
      statutory_service.py
      history_service.py
  data/
    audit_history.json   # created on first run
frontend/
  src/
    App.jsx
    components/RiskScorecard.jsx
    main.jsx
    styles.css
  index.html
  package.json
  vite.config.js
requirements.txt
README.md
```

## Backend (FastAPI)

### Run

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn backend.app.main:app --reload
```

### Endpoint

`POST /audit` with multipart form-data:
- `file` (required): invoice PDF/image
- `gstin` (optional): GSTIN to validate
- `hsn_or_sac` (optional): HSN/SAC code
- `claimed_tax_rate` (optional): tax rate for master match

Response includes:
- `composite_risk_score` (0-100)
- `alerts` list
- `checks`: full control list (`1.1` ... `5.5`) with status per control
- `metadata` object for diagnostics

## Control Matrix Coverage

The web tool now tracks all requested controls from:
- `1.1` to `1.4` Metadata & Image Integrity
- `2.1` to `2.7` Statutory Validation
- `3.1` to `3.5` Vendor History Analysis
- `4.1` to `4.5` Duplicate Detection
- `5.1` to `5.5` Advanced Analytics

Current implementation status:
- **Implemented logic now**: 1.1, 1.2, 2.1, 2.2, 2.3
- **Scaffolded with Zero-Inference alerts (`Data Missing`)**: remaining controls awaiting OCR/ERP/history/API integrations.

## Frontend (React + Vite)

### Run

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`.

## Zero-Inference Rule

If required evidence is unavailable, the API returns explicit `Data Missing` alerts for that control (no guessed outputs).
