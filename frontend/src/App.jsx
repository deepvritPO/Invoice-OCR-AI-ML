import { useState } from 'react'
import RiskScorecard from './components/RiskScorecard'
import GoogleSheetsPanel from './components/GoogleSheetsPanel'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000'

export default function App() {
  const [file, setFile] = useState(null)
  const [gstin, setGstin] = useState('')
  const [hsn, setHsn] = useState('')
  const [taxRate, setTaxRate] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [showSheets, setShowSheets] = useState(false)

  const handleDrop = (event) => {
    event.preventDefault()
    const droppedFile = event.dataTransfer.files?.[0]
    if (droppedFile) {
      setFile(droppedFile)
      setError('')
    }
  }

  const runAudit = async () => {
    if (!file) {
      setError('Please upload a file before auditing.')
      return
    }

    setLoading(true)
    setError('')
    setResult(null)

    const formData = new FormData()
    formData.append('file', file)
    if (gstin.trim()) formData.append('gstin', gstin.trim())
    if (hsn.trim()) formData.append('hsn_or_sac', hsn.trim())
    if (taxRate.trim()) formData.append('claimed_tax_rate', taxRate.trim())

    try {
      const response = await fetch(`${API_BASE_URL}/audit`, {
        method: 'POST',
        body: formData,
      })

      if (!response.ok) {
        const detail = await response.text()
        throw new Error(detail || 'Audit failed')
      }

      const data = await response.json()
      setResult(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="container">
      <header className="app-header">
        <h1>AuditLens AI</h1>
        <p className="subtitle">Forensic invoice verification powered by AI/ML for internal auditors.</p>
        <div className="header-actions">
          <button className="btn-secondary" onClick={() => setShowSheets(!showSheets)}>
            {showSheets ? 'Hide' : 'Google Sheets'}
          </button>
        </div>
      </header>

      {showSheets && <GoogleSheetsPanel apiBase={API_BASE_URL} />}

      <div
        className="drop-zone"
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
      >
        {file ? <p>Selected: <strong>{file.name}</strong> ({(file.size / 1024).toFixed(1)} KB)</p> : <p>Drag & drop invoice (PDF/Image), or click below.</p>}
        <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.bmp,.tiff" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </div>

      <div className="inputs">
        <label>
          GSTIN
          <input value={gstin} onChange={(e) => setGstin(e.target.value)} placeholder="27ABCDE1234F1Z5" />
        </label>
        <label>
          HSN/SAC
          <input value={hsn} onChange={(e) => setHsn(e.target.value)} placeholder="9983" />
        </label>
        <label>
          Claimed Tax Rate (%)
          <input value={taxRate} onChange={(e) => setTaxRate(e.target.value)} placeholder="18" type="number" step="0.01" />
        </label>
      </div>

      <button className="btn-primary" onClick={runAudit} disabled={loading}>
        {loading ? 'Analyzing with AI/ML...' : 'Run Audit'}
      </button>

      {error && <p className="error">{error}</p>}

      <RiskScorecard result={result} />

      <footer className="app-footer">
        <p>AuditLens AI v1.0 &mdash; 26 controls across 5 categories &mdash; AI/ML powered forensic analysis</p>
      </footer>
    </main>
  )
}
