export default function RiskScorecard({ result }) {
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

  return (
    <div className="card">
      <h3>Risk Scorecard</h3>
      <div className={`score ${riskClass}`}>{result.composite_risk_score}/100</div>
      <h4>Alerts</h4>
      <ul>
        {result.alerts.map((alert, idx) => (
          <li key={`${alert}-${idx}`}>{alert}</li>
        ))}
      </ul>

      <h4>Control Coverage</h4>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Category</th>
              <th>Check</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {result.checks?.map((check) => (
              <tr key={check.check_id}>
                <td>{check.check_id}</td>
                <td>{check.category}</td>
                <td>{check.check_name}</td>
                <td><span className={`pill ${check.status}`}>{check.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
