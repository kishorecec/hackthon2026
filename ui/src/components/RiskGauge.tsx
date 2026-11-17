/** Risk gauge — the model's number, and only the model's number. */

import type { Forecast, WindowEvent } from '../lib/types'
import {
  BAND_COLOURS,
  BAND_LABELS,
  formatRate,
  formatRiskScore,
  formatSeconds,
} from '../lib/format'

interface Props {
  forecast: Forecast | null
  leadSeconds: number | null
  bellRung: boolean
  /** Every window streamed so far; the mitigation strip reads from the bell on. */
  windows?: WindowEvent[]
  running?: boolean
}

const RADIUS = 68
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export function RiskGauge({ forecast, leadSeconds, bellRung, windows = [], running = false }: Props) {
  const score = forecast?.risk_score ?? null
  const band = forecast?.risk_band ?? 'unknown'
  const colour = BAND_COLOURS[band]
  const filled = score === null ? 0 : Math.max(0, Math.min(1, score))

  return (
    <section className="panel gauge-panel">
      <header className="panel-head">
        <h2>Risk of onset</h2>
        <span className="panel-note">
          next {forecast?.horizon_seconds ?? 120}s · from the model
        </span>
      </header>

      <div className="gauge-body">
        <svg viewBox="0 0 160 160" className="gauge" role="img" aria-label="risk gauge">
          <circle cx="80" cy="80" r={RADIUS} className="gauge-track" />
          <circle
            cx="80"
            cy="80"
            r={RADIUS}
            className="gauge-fill"
            stroke={colour}
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - filled)}
            transform="rotate(-90 80 80)"
          />
          <text x="80" y="76" className="gauge-score" fill={colour}>
            {formatRiskScore(score)}
          </text>
          <text x="80" y="98" className="gauge-band">
            {BAND_LABELS[band]}
          </text>
        </svg>

        <dl className="gauge-facts">
          <div>
            <dt>DFSI state</dt>
            <dd className={forecast?.degraded ? 'is-degraded' : undefined}>
              {forecast?.degraded
                ? 'Monitoring only'
                : forecast?.predicted_state === 'ABOUT_TO_START'
                  ? 'About to start'
                  : 'Quiet'}
            </dd>
          </div>
          <div>
            <dt>Shared State</dt>
            <dd>{bellRung ? 'Attack declared' : 'No attack declared'}</dd>
          </div>
          <div>
            <dt>Head start</dt>
            <dd className={leadSeconds ? 'is-lead' : undefined}>
              {formatSeconds(leadSeconds)}
            </dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd className="mono">{forecast?.model_version ?? '—'}</dd>
          </div>
        </dl>
      </div>

      {bellRung && <MitigationStrip windows={windows} running={running} />}

      {forecast?.degraded && (
        <p className="degraded-note">
          <strong>Monitoring only.</strong> {forecast.degraded_reason} Treat this as
          unknown, not as low risk.
        </p>
      )}
    </section>
  )
}

/**
 * Mitigation, simulated: from the bell on, the wall drops what exceeds the
 * line. A donut splits what is arriving into dropped and reaching the range;
 * a thin outer ring shows the load against the peak seen so far, so the
 * rings keep moving window by window.
 */
const M_INNER = 38
const M_OUTER = 52
const M_INNER_C = 2 * Math.PI * M_INNER
const M_OUTER_C = 2 * Math.PI * M_OUTER

function MitigationStrip({ windows, running }: { windows: WindowEvent[]; running: boolean }) {
  const bellIndex = windows.findIndex((w) => w.shared_state.declared)
  if (bellIndex < 0) return null
  const last = windows[windows.length - 1].traffic
  const peak = Math.max(1, ...windows.slice(bellIndex).map((w) => w.traffic.total_pps))
  const arriving = last.total_pps
  const dropped = Math.min(arriving, last.blocked_pps)
  const reaching = Math.max(0, arriving - dropped)
  const droppedShare = arriving > 0 ? dropped / arriving : 0
  const load = Math.min(1, arriving / peak)

  return (
    <div className="mitigation">
      <header className="mitigation-head">
        <h3>
          <span className={running ? 'live-dot is-live' : 'live-dot'} aria-hidden="true" />
          Mitigation
        </h3>
        <span className="panel-note">simulated · nothing is applied</span>
      </header>
      <div className="mitigation-body">
        <svg viewBox="0 0 120 120" className="mitigation-donut" role="img" aria-label="mitigation">
          <g transform="rotate(-90 60 60)">
            <circle cx="60" cy="60" r={M_OUTER} className="m-track m-thin" />
            <circle
              cx="60"
              cy="60"
              r={M_OUTER}
              className="m-arc m-load"
              strokeDasharray={M_OUTER_C}
              strokeDashoffset={M_OUTER_C * (1 - load)}
            />
            <circle cx="60" cy="60" r={M_INNER} className="m-track" />
            <circle
              cx="60"
              cy="60"
              r={M_INNER}
              className="m-arc m-passed"
              strokeDasharray={M_INNER_C}
              strokeDashoffset={0}
            />
            <circle
              cx="60"
              cy="60"
              r={M_INNER}
              className="m-arc m-dropped"
              strokeDasharray={`${M_INNER_C * droppedShare} ${M_INNER_C}`}
            />
          </g>
          <text x="60" y="60" className="m-score">
            {Math.round(droppedShare * 100)}%
          </text>
          <text x="60" y="75" className="m-label">
            dropped
          </text>
        </svg>
        <dl className="mitigation-facts">
          <div>
            <dt>
              <i className="swatch m-load-swatch" />
              Arriving
            </dt>
            <dd className="mono">{formatRate(arriving)}</dd>
          </div>
          <div>
            <dt>
              <i className="swatch m-dropped-swatch" />
              Dropped
            </dt>
            <dd className="mono is-dropped">{formatRate(dropped)}</dd>
          </div>
          <div>
            <dt>
              <i className="swatch m-passed-swatch" />
              Reaching range
            </dt>
            <dd className="mono is-passed">{formatRate(reaching)}</dd>
          </div>
        </dl>
      </div>
      <p className="panel-note">
        {running ? 'Live · ' : ''}outer ring: load vs peak since the bell.
      </p>
    </div>
  )
}
