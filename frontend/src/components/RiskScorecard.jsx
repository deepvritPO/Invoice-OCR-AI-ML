import { useState } from 'react'

const CATEGORIES = [
  'Metadata & Image Integrity',
  'Statutory Validation',
  'Vendor History Analysis',
  'Duplicate Detection',
  'Advanced Analytics',
]

export default function RiskScorecard({ result }) {
  const [expandedCheck, setExpandedCheck] = useState(null)
  const [filterCategory, setFilterCategory] = useState('all')

  if (!result) {
    return (
      <div className="card muted">
        <h3>Risk Scorecard</h3>
        <p>Upload an invoice and run audit to view risk signals.</p>
      </div>
    )
  }

  const riskClass =
    result.composite_risk_score >= 70
      ? 'high'
      : result.composite_risk_score >= 40
      ? 'medium'
      : 'low'

  const statusCounts = {}
  result.checks?.forEach((c) => {
    statusCounts[c.status] = (statusCounts[c.status] || 0) + 1
  })

  const filteredChecks = filterCategory === 'all'
    ? result.checks
    : result.checks?.filter((c) => c.category === filterCategory)

  return (
    <div className="card">
      <h3>Risk Scorecard</h3>

      <div className="score-section">
        <div className={`score ${riskClass}`}>{result.composite_risk_score}/100</div>
        <div className="score-label">{riskClass.charAt(0).toUpperCase() + riskClass.slice(1)} Risk</div>
      </div>

      <div className="status-summary">
        {Object.entries(statusCounts).map(([status, count]) => (
          <span key={status} className={`pill ${status}`}>
            {status}: {count}
          </span>
        ))}
      </div>

      <h4>Alerts ({result.alerts.length})</h4>
      <ul className="alerts-list">
        {result.alerts.map((alert, idx) => (
          <li key={idx} className="alert-item">{alert}</li>
        ))}
      </ul>

      <h4>Control Coverage (26 checks across 5 categories)</h4>

      <div className="category-filter">
        <button
          className={filterCategory === 'all' ? 'filter-btn active' : 'filter-btn'}
          onClick={() => setFilterCategory('all')}
        >
          All
        </button>
        {CATEGORIES.map((cat) => (
          <button
            key={cat}
            className={filterCategory === cat ? 'filter-btn active' : 'filter-btn'}
            onClick={() => setFilterCategory(cat)}
          >
            {cat}
          </button>
        ))}
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Category</th>
              <th>Check</th>
              <th>Status</th>
              <th>Alert</th>
            </tr>
          </thead>
          <tbody>
            {filteredChecks?.map((check) => (
              <>
                <tr
                  key={check.check_id}
                  className="check-row"
                  onClick={() =>
                    setExpandedCheck(expandedCheck === check.check_id ? null : check.check_id)
                  }
                >
                  <td>{check.check_id}</td>
                  <td>{check.category}</td>
                  <td>{check.check_name}</td>
                  <td><span className={`pill ${check.status}`}>{check.status.replace('_', ' ')}</span></td>
                  <td className="alert-cell">{check.alert || '-'}</td>
                </tr>
                {expandedCheck === check.check_id && check.details && (
                  <tr key={`${check.check_id}-details`} className="details-row">
                    <td colSpan={5}>
                      <pre className="details-json">
                        {JSON.stringify(check.details, null, 2)}
                      </pre>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
