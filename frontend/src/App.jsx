import { useState } from 'react'
import RiskScorecard from './components/RiskScorecard'

const API_BASE_URL = 'http://localhost:8000'

export default function App() {
  const [file, setFile] = useState(null)
  const [gstin, setGstin] = useState('')
  const [hsn, setHsn] = useState('')
  const [taxRate, setTaxRate] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)

  const handleDrop = (event) => {
    event.preventDefault()
    const droppedFile = event.dataTransfer.files?.[0]
    if (droppedFile) {
      setFile(droppedFile)
    }
  }

  const runAudit = async () => {
    if (!file) {
      setError('Please upload a file before auditing.')
      return
    }

    setLoading(true)
    setError('')

    const formData = new FormData()
    formData.append('file', file)
    formData.append('gstin', gstin)
    formData.append('hsn_or_sac', hsn)
    formData.append('claimed_tax_rate', taxRate)

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
      <h1>AuditLens AI</h1>
      <p className="subtitle">Forensic invoice verification for internal auditors.</p>

      <div
        className="drop-zone"
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
      >
        {file ? <p>Selected: {file.name}</p> : <p>Drag & drop invoice (PDF/Image), or click below.</p>}
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
          Claimed Tax Rate
          <input value={taxRate} onChange={(e) => setTaxRate(e.target.value)} placeholder="18" type="number" step="0.01" />
        </label>
      </div>

      <button onClick={runAudit} disabled={loading}>
        {loading ? 'Auditing...' : 'Run Audit'}
      </button>

      {error && <p className="error">{error}</p>}

      <RiskScorecard result={result} />
    </main>
  )
}
