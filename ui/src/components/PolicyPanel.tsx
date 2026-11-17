/**
 * Policy store — the lines this range is protected by right now, how they got
 * there, and what the last runs of this attack looked like under them.
 *
 * The store is DFSI's simulated policy database (seeded from raw.json). An
 * approved threshold change lands here; replaying the attack then runs it
 * under the new lines, and the comparison shows the difference.
 */

import type { PolicySnapshot, SummaryEvent } from '../lib/types'
import { formatRate, formatSeconds } from '../lib/format'

interface Props {
  rangeId: number | null
  snapshot: PolicySnapshot | null
  runs: SummaryEvent[]
  onReset: () => void
  onReplay: () => void
  canReplay: boolean
  busy: boolean
  collapsed?: boolean
  onToggle?: () => void
}

function percent(value: number | undefined): string {
  return value === undefined ? '—' : `${(value * 100).toFixed(1)}%`
}

export function PolicyPanel({ rangeId, snapshot, runs, onReset, onReplay, canReplay, busy, collapsed = false, onToggle }: Props) {
  const range = snapshot?.ranges.find((entry) => entry.range_id === rangeId) ?? null
  const history = (snapshot?.history ?? []).filter(
    (entry) => entry.action === 'reset' || entry.range_id === rangeId,
  )
  const changedTypes = new Set(
    history.flatMap((entry) => (entry.changes ?? []).map((change) => change.traffic_type)),
  )
  const compared = runs.slice(-2)

  return (
    <section className="panel policy-panel">
      <header className="panel-head">
        <h2>Policy store</h2>
        <span className="panel-note">
          simulated · v{snapshot?.version ?? '—'}
          {snapshot?.source ? ' · seeded from raw.json' : ' · no raw.json loaded'}
        </span>
        {onToggle && (
          <button type="button" className="secondary" onClick={onToggle} aria-expanded={!collapsed}>
            {collapsed ? 'Show' : 'Hide'}
          </button>
        )}
      </header>

      {collapsed ? null : (
        <>

      {!range && <p className="empty">Pick a replay to see its range's policy.</p>}

      {range && (
        <table className="tradeoff">
          <thead>
            <tr>
              <th scope="col">Range {range.range_id}</th>
              <th scope="col">Line (pps)</th>
              <th scope="col">Line (Mbps)</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(range.traffic_types).map(([type, line]) => (
              <tr key={type} className={changedTypes.has(type) ? 'is-selected' : undefined}>
                <th scope="row">
                  {type}
                  {changedTypes.has(type) && <span className="recommended-tag">changed</span>}
                </th>
                <td className="mono">{formatRate(line.max_threshold_pps)}</td>
                <td className="mono">{line.max_threshold_mbps.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {history.length > 0 && (
        <ul className="policy-history">
          {history
            .slice()
            .reverse()
            .map((entry) => (
              <li key={entry.version} className="mono">
                v{entry.version} ·{' '}
                {entry.action === 'reset'
                  ? 'reset to raw.json'
                  : (entry.changes ?? [])
                      .map((c) => `${c.traffic_type} ${formatRate(c.from_pps)} → ${formatRate(c.to_pps)}`)
                      .join(', ')}
                {entry.operator ? ` · approved by ${entry.operator}` : ''}
              </li>
            ))}
        </ul>
      )}

      {compared.length > 0 && (
        <>
          <h3 className="policy-runs-title">Runs of this attack</h3>
          <table className="tradeoff">
            <thead>
              <tr>
                <th scope="col"></th>
                {compared.map((run, index) => (
                  <th scope="col" key={index}>
                    policy v{run.policy_version}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">DFSI warned at</th>
                {compared.map((run, index) => (
                  <td className="mono" key={index}>
                    {run.warning_after_seconds == null ? 'no warning' : `+${formatSeconds(run.warning_after_seconds)}`}
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row">Bell rang at</th>
                {compared.map((run, index) => (
                  <td className="mono" key={index}>
                    {run.bell_after_seconds == null ? 'never' : `+${formatSeconds(run.bell_after_seconds)}`}
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row">Dropped at the wall</th>
                {compared.map((run, index) => (
                  <td className="mono" key={index}>
                    {percent(run.blocked_share_total)}
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row">Peak reaching the range</th>
                {compared.map((run, index) => (
                  <td className="mono" key={index}>
                    {run.peak_passed_pps === undefined ? '—' : formatRate(run.peak_passed_pps)}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
          <p className="panel-note">
            Times are from the start of the episode. Figures cover the whole episode.
          </p>
        </>
      )}

      <div className="decision-actions">
        <button type="button" className="secondary" onClick={onReplay} disabled={!canReplay}>
          Replay this attack
        </button>
        <button type="button" className="secondary" onClick={onReset} disabled={busy}>
          Reset to raw.json
        </button>
      </div>
        </>
      )}
    </section>
  )
}
