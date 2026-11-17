/**
 * DFSI dashboard.
 *
 * Drives the demo flow from the pitch: replay synthetic traffic → watch the
 * risk score climb before the threshold alarm → ask the agents whether it is
 * an attack or a flash crowd → compare the four responses → record a human
 * decision.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, streamReplay } from './lib/api'
import type {
  Briefing,
  CatalogueEntry,
  DecisionRecord,
  DrillResult,
  Health,
  ModelCard,
  PolicyKey,
  PolicySnapshot,
  ReplayEvent,
  RiskThresholds,
  SummaryEvent,
  WindowEvent,
} from './lib/types'
import { DecisionBar } from './components/DecisionBar'
import { EvidencePanel } from './components/EvidencePanel'
import { PolicyPanel } from './components/PolicyPanel'
import { RiskGauge } from './components/RiskGauge'
import { StatusBar } from './components/StatusBar'
import { Timeline } from './components/Timeline'
import { TradeOffTable } from './components/TradeOffTable'
import { TriggerPanel } from './components/TriggerPanel'

export default function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [modelCard, setModelCard] = useState<ModelCard | null>(null)
  const [catalogue, setCatalogue] = useState<CatalogueEntry[]>([])
  const [bootError, setBootError] = useState<string | null>(null)

  const [selectedReplay, setSelectedReplay] = useState<string | null>(null)
  const [speed, setSpeed] = useState(0.25)
  const [running, setRunning] = useState(false)
  const [windows, setWindows] = useState<WindowEvent[]>([])
  const [streamError, setStreamError] = useState<string | null>(null)
  const abortRef = useRef<(() => void) | null>(null)

  // The window the operator is reasoning about. Follows the stream while it
  // runs, then stays put so the drill and the briefing agree on one instant.
  const [focusEpoch, setFocusEpoch] = useState<number | null>(null)

  const [briefing, setBriefing] = useState<Briefing | null>(null)
  const [briefingLoading, setBriefingLoading] = useState(false)
  const [briefingError, setBriefingError] = useState<string | null>(null)

  const [drill, setDrill] = useState<DrillResult | null>(null)
  const [drillLoading, setDrillLoading] = useState(false)
  const [drillError, setDrillError] = useState<string | null>(null)

  const [selectedPolicy, setSelectedPolicy] = useState<PolicyKey | null>(null)
  const [lastDecision, setLastDecision] = useState<DecisionRecord | null>(null)
  const [decisionBusy, setDecisionBusy] = useState(false)
  const [decisionError, setDecisionError] = useState<string | null>(null)

  // The simulated policy store, and each replay's finished runs (so a run
  // after an approval can be compared with the run before it).
  const [policies, setPolicies] = useState<PolicySnapshot | null>(null)
  const [policyBusy, setPolicyBusy] = useState(false)
  const [policyCollapsed, setPolicyCollapsed] = useState(false)
  const bellHandledRef = useRef<string | null>(null)
  const [runs, setRuns] = useState<Record<string, SummaryEvent[]>>({})

  const refreshPolicies = useCallback(async () => {
    try {
      setPolicies(await api.policies())
    } catch {
      // Informational: the replay still runs under whatever the API holds.
    }
  }, [])

  useEffect(() => {
    void refreshPolicies()
  }, [refreshPolicies])

  // Per-range decision thresholds, as configured in raw.json.
  const [riskThresholds, setRiskThresholds] = useState<RiskThresholds | null>(null)
  useEffect(() => {
    api.riskThresholds().then(setRiskThresholds, () => {
      // Informational: without it the timeline uses the model card's threshold.
    })
  }, [])

  // ---------------------------------------------------------------- boot
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [healthResult, replayResult] = await Promise.all([
          api.health(),
          api.replays(),
        ])
        if (cancelled) return
        setHealth(healthResult)
        setCatalogue(replayResult.replays)
        setSelectedReplay(
          replayResult.replays.find((entry) => entry.scenario_type === 'gradual_buildup')
            ?.replay_id ?? replayResult.replays[0]?.replay_id ?? null,
        )
      } catch (error) {
        if (!cancelled) {
          setBootError(error instanceof Error ? error.message : String(error))
        }
      }
      try {
        const card = await api.modelCard()
        if (!cancelled) setModelCard(card)
      } catch {
        // The model card is informational; the dashboard works without it.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Abort any live stream when the component goes away.
  useEffect(() => () => abortRef.current?.(), [])

  // ---------------------------------------------------------------- replay
  const handleEvent = useCallback((event: ReplayEvent) => {
    switch (event.type) {
      case 'start':
        setWindows([])
        setStreamError(null)
        break
      case 'window':
        setWindows((previous) => [...previous, event])
        setFocusEpoch(event.window_start_epoch)
        break
      case 'summary':
        // The stream ends a few windows after the bell, which can be a lull
        // (between pulses, say). The moment an operator decides at is DFSI's
        // warning, which is also the API's default, so settle the focus there.
        if (event.first_warning_epoch !== null) setFocusEpoch(event.first_warning_epoch)
        setRuns((previous) => ({
          ...previous,
          [event.replay_id]: [...(previous[event.replay_id] ?? []), event].slice(-5),
        }))
        break
      case 'error':
        setStreamError(event.message)
        break
    }
  }, [])

  const start = useCallback(() => {
    if (!selectedReplay) return
    abortRef.current?.()
    setWindows([])
    setBriefing(null)
    setDrill(null)
    setSelectedPolicy(null)
    setLastDecision(null)
    setStreamError(null)
    setPolicyCollapsed(false)
    bellHandledRef.current = null
    setRunning(true)

    abortRef.current = streamReplay(
      { replayId: selectedReplay, speedSeconds: speed },
      handleEvent,
      (error) => {
        setRunning(false)
        abortRef.current = null
        if (error) setStreamError(error.message)
      },
    )
  }, [handleEvent, selectedReplay, speed])

  const stop = useCallback(() => {
    abortRef.current?.()
    abortRef.current = null
    setRunning(false)
  }, [])

  // ------------------------------------------------------- agents & drill
  const requestBriefing = useCallback(async () => {
    if (!selectedReplay) return
    setBriefingLoading(true)
    setBriefingError(null)
    try {
      const result = await api.explain(selectedReplay, focusEpoch ?? undefined)
      setBriefing(result)
      const pick = result.advisor.output.recommended_policy_key
      if (pick) setSelectedPolicy(pick)
    } catch (error) {
      setBriefingError(error instanceof Error ? error.message : String(error))
    } finally {
      setBriefingLoading(false)
    }
  }, [focusEpoch, selectedReplay])

  const runDrillAt = useCallback(
    async (epoch: number | null) => {
      if (!selectedReplay) return
      setDrillLoading(true)
      setDrillError(null)
      try {
        setDrill(await api.drill(selectedReplay, epoch ?? undefined))
      } catch (error) {
        setDrillError(error instanceof Error ? error.message : String(error))
      } finally {
        setDrillLoading(false)
      }
    },
    [selectedReplay],
  )

  const runDrill = useCallback(() => runDrillAt(focusEpoch), [focusEpoch, runDrillAt])

  // Move the decision to the window DFSI warned at and re-run the drill there,
  // for when the operator is looking at a moment with nothing to tighten.
  const decideAtWarning = useCallback(() => {
    const warning = windows[windows.length - 1]?.first_warning_epoch ?? null
    if (warning === null) return
    setFocusEpoch(warning)
    void runDrillAt(warning)
  }, [runDrillAt, windows])

  const decide = useCallback(
    async (verdict: 'approved' | 'rejected' | 'changed', note: string) => {
      if (!selectedReplay || !selectedPolicy) return
      const epoch = drill?.decision_epoch ?? focusEpoch
      if (epoch === null || epoch === undefined) return
      setDecisionBusy(true)
      setDecisionError(null)
      try {
        const record = await api.decide({
          replayId: selectedReplay,
          decisionEpoch: epoch,
          policyKey: selectedPolicy,
          verdict,
          note,
          modelVersion: health?.model_version ?? 'unknown',
        })
        setLastDecision(record)
        // An applied change makes the drill on screen stale: it was simulated
        // under the old lines. Refresh the store so the panel shows the new ones.
        if (record.applied) {
          setDrill(null)
          await refreshPolicies()
        }
      } catch (error) {
        setDecisionError(error instanceof Error ? error.message : String(error))
      } finally {
        setDecisionBusy(false)
      }
    },
    [
      drill?.decision_epoch,
      focusEpoch,
      health?.model_version,
      refreshPolicies,
      selectedPolicy,
      selectedReplay,
    ],
  )

  const selectedRangeId =
    catalogue.find((entry) => entry.replay_id === selectedReplay)?.range_id ?? null

  const resetPolicies = useCallback(async () => {
    setPolicyBusy(true)
    try {
      setPolicies(await api.resetPolicies())
      setDrill(null)
    } finally {
      setPolicyBusy(false)
    }
  }, [])

  // ---------------------------------------------------------------- render
  const latest = windows.length > 0 ? windows[windows.length - 1] : null
  const focused =
    windows.find((window) => window.window_start_epoch === focusEpoch) ?? latest

  // The bell rings: get the policy table out of the way and rehearse a
  // mitigation straight away, once per run.
  const bellEpoch = latest?.shared_state.declared ? latest.shared_state.bell_epoch : null
  useEffect(() => {
    if (bellEpoch === null || !selectedReplay) return
    const key = `${selectedReplay}:${bellEpoch}`
    if (bellHandledRef.current === key) return
    bellHandledRef.current = key
    setPolicyCollapsed(true)
    void runDrillAt(bellEpoch)
  }, [bellEpoch, runDrillAt, selectedReplay])

  const recommended = briefing?.advisor.output.recommended_policy_key ?? null
  const rangeThreshold =
    (selectedRangeId !== null ? riskThresholds?.ranges[String(selectedRangeId)] : undefined) ??
    riskThresholds?.model_default ??
    modelCard?.decision_threshold ??
    0.25

  if (bootError) {
    return (
      <main className="app">
        <StatusBar health={health} modelCard={modelCard} streamError={null} />
        <section className="panel">
          <h2>DFSI is not ready</h2>
          <p className="error">{bootError}</p>
          <p>
            Build the Memory layer and train the forecaster, then restart the API:
          </p>
          <pre>
            {`python -m dfsi.memory.pipeline --days 28
python -m dfsi.forecaster.train
uvicorn dfsi.api.app:app --port 8000`}
          </pre>
        </section>
      </main>
    )
  }

  return (
    <main className="app">
      <StatusBar health={health} modelCard={modelCard} streamError={streamError} />

      <div className="layout">
        <div className="column-left">
          <TriggerPanel
            catalogue={catalogue}
            policies={policies}
            selected={selectedReplay}
            onSelect={setSelectedReplay}
            speed={speed}
            onSpeedChange={setSpeed}
            running={running}
            onStart={start}
            onStop={stop}
            disabled={!health?.forecaster_ready}
          />
          <RiskGauge
            forecast={focused?.forecast ?? null}
            leadSeconds={latest?.lead_seconds ?? null}
            bellRung={Boolean(latest?.shared_state.declared)}
            windows={windows}
            running={running}
          />
          <PolicyPanel
            rangeId={selectedRangeId}
            snapshot={policies}
            runs={selectedReplay ? (runs[selectedReplay] ?? []) : []}
            onReset={resetPolicies}
            onReplay={start}
            canReplay={Boolean(selectedReplay) && !running && Boolean(health?.forecaster_ready)}
            busy={policyBusy || running}
            collapsed={policyCollapsed}
            onToggle={() => setPolicyCollapsed((c) => !c)}
          />
        </div>

        <div className="column-right">
          <Timeline
            windows={windows}
            threshold={rangeThreshold}
            selectedEpoch={focusEpoch}
            onScrub={(epoch) => {
              if (!running) setFocusEpoch(epoch)
            }}
          />
          <EvidencePanel
            briefing={briefing}
            loading={briefingLoading}
            error={briefingError}
            onRequest={requestBriefing}
            canRequest={Boolean(selectedReplay) && !briefingLoading}
          />
          <TradeOffTable
            drill={drill}
            loading={drillLoading}
            error={drillError}
            onRun={runDrill}
            canRun={Boolean(selectedReplay) && !drillLoading}
            recommended={recommended}
            selected={selectedPolicy}
            onSelect={setSelectedPolicy}
          />
          <DecisionBar
            selected={selectedPolicy}
            recommended={recommended}
            policyPlan={drill?.policy_plan ?? null}
            modelVersion={health?.model_version ?? 'unknown'}
            decisionEpoch={drill?.decision_epoch ?? focusEpoch}
            warningEpoch={latest?.first_warning_epoch ?? null}
            onDecideAtWarning={decideAtWarning}
            onDecide={decide}
            onReplay={start}
            canReplay={!running}
            lastDecision={lastDecision}
            busy={decisionBusy}
            error={decisionError}
          />
        </div>
      </div>

      <footer className="app-footer">
        <p>
          DFSI is read-only and simulation-only. It never changes a customer's
          configuration, never blocks traffic and never applies a policy. Every number
          on this page comes from the model or the simulator; the agents only explain.
        </p>
        {modelCard && (
          <details>
            <summary>Known limitations of this model</summary>
            <ul>
              {modelCard.known_limitations.map((limitation, index) => (
                <li key={index}>{limitation}</li>
              ))}
            </ul>
          </details>
        )}
      </footer>
    </main>
  )
}
