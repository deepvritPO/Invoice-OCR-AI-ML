import { useState, useEffect } from 'react'

export default function GoogleSheetsPanel({ apiBase }) {
  const [spreadsheetId, setSpreadsheetId] = useState('')
  const [credentialsJson, setCredentialsJson] = useState('')
  const [sheetName, setSheetName] = useState('AuditLens Results')
  const [status, setStatus] = useState(null)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    fetch(`${apiBase}/sheets/status`)
      .then((r) => r.json())
      .then((data) => setStatus(data.configured))
      .catch(() => setStatus(false))
  }, [apiBase])

  const configure = async () => {
    if (!spreadsheetId.trim()) {
      setMessage('Please enter a Spreadsheet ID.')
      return
    }
    setLoading(true)
    setMessage('')
    try {
      const resp = await fetch(`${apiBase}/sheets/configure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          spreadsheet_id: spreadsheetId.trim(),
          credentials_json: credentialsJson.trim() || null,
          sheet_name: sheetName.trim() || 'AuditLens Results',
        }),
      })
      const data = await resp.json()
      if (data.success) {
        setStatus(true)
        setMessage('Google Sheets connected successfully.')
      } else {
        setMessage(`Error: ${data.error || 'Configuration failed.'}`)
      }
    } catch (e) {
      setMessage(`Error: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }

  const exportHistory = async () => {
    setLoading(true)
    setMessage('')
    try {
      const resp = await fetch(`${apiBase}/sheets/export-history`, { method: 'POST' })
      const data = await resp.json()
      if (data.rows_written !== undefined) {
        setMessage(`Exported ${data.rows_written} records to Google Sheets.`)
      } else {
        setMessage(`Error: ${data.detail || 'Export failed.'}`)
      }
    } catch (e) {
      setMessage(`Error: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }

  const exportInsights = async () => {
    setLoading(true)
    setMessage('')
    try {
      const resp = await fetch(`${apiBase}/sheets/export-insights`, { method: 'POST' })
      const data = await resp.json()
      if (data.insights_written !== undefined) {
        setMessage(`Exported ${data.insights_written} insight rows to Google Sheets.`)
      } else {
        setMessage(`Error: ${data.detail || 'Export failed.'}`)
      }
    } catch (e) {
      setMessage(`Error: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="card sheets-panel">
      <h4>Google Sheets Integration</h4>
      <p className="muted">Spool audit results and insights to Google Sheets for reporting.</p>

      <div className="sheets-status">
        Status: {status === null ? 'Checking...' : status ? <span className="pill pass">Connected</span> : <span className="pill data_missing">Not configured</span>}
      </div>

      {!status && (
        <div className="sheets-config">
          <label>
            Spreadsheet ID
            <input
              value={spreadsheetId}
              onChange={(e) => setSpreadsheetId(e.target.value)}
              placeholder="e.g. 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms"
            />
          </label>
          <label>
            Service Account Credentials (JSON)
            <textarea
              value={credentialsJson}
              onChange={(e) => setCredentialsJson(e.target.value)}
              placeholder='Paste service account JSON here...'
              rows={3}
            />
          </label>
          <label>
            Sheet Name
            <input
              value={sheetName}
              onChange={(e) => setSheetName(e.target.value)}
              placeholder="AuditLens Results"
            />
          </label>
          <button onClick={configure} disabled={loading}>
            {loading ? 'Connecting...' : 'Connect'}
          </button>
        </div>
      )}

      {status && (
        <div className="sheets-actions">
          <button onClick={exportHistory} disabled={loading}>Export All History</button>
          <button onClick={exportInsights} disabled={loading}>Export Insights</button>
        </div>
      )}

      {message && <p className={message.startsWith('Error') ? 'error' : 'success'}>{message}</p>}
    </div>
  )
}
