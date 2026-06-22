import { useEffect, useRef, useState, useCallback } from 'react';
import { StateSpace } from './engine/stateSpace';
import { FunnelViz } from './visualization/FunnelViz';
import type { Constraint } from './engine/types';
import './App.css';

const MASTERMIND_CONFIG = { pegs: 4, colors: 6 };

const COLOR_NAMES = ['Red', 'Orange', 'Yellow', 'Green', 'Blue', 'Purple'];
const COLOR_HEX = ['#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#3498db', '#9b59b6'];

// ─── Subcomponents ────────────────────────────────────────────────────────────

function PegDisplay({ colorIndex, size = 'md' }: { colorIndex: number; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <div
      className={`peg peg-${size}`}
      style={{ backgroundColor: COLOR_HEX[colorIndex] }}
      title={COLOR_NAMES[colorIndex]}
    />
  );
}

function ScoreTag({ hits, blows }: { hits: number; blows: number }) {
  return (
    <div className="score-tag">
      <span className="score-hit" title="Hits (right colour, right place)">{hits}H</span>
      <span className="score-blow" title="Blows (right colour, wrong place)">{blows}B</span>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const vizRef = useRef<FunnelViz | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  // StateSpace is mutable; we hold it in a ref and derive display state from it.
  const stateSpaceRef = useRef(new StateSpace(MASTERMIND_CONFIG));

  const [remaining, setRemaining] = useState(
    () => stateSpaceRef.current.allCodes.length,
  );
  const [history, setHistory] = useState<readonly Constraint[]>([]);

  // Current guess being composed
  const [guess, setGuess] = useState<number[]>([0, 0, 0, 0]);
  // Which peg is currently being edited (null = none)
  const [editingPeg, setEditingPeg] = useState<number | null>(null);
  const [hits, setHits] = useState(0);
  const [blows, setBlows] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');

  const total = stateSpaceRef.current.allCodes.length;

  // ── Bootstrap Three.js once the canvas is in the DOM ──────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ss = stateSpaceRef.current;
    const viz = new FunnelViz(canvas, ss.allCodes);
    vizRef.current = viz;
    viz.updateActiveSet(ss.remainingIndices());

    return () => {
      viz.dispose();
      vizRef.current = null;
    };
  }, []);

  // ── Keep viz centred in the visible free area above the bottom panel ───────
  // On mobile (≤480 px) the panel sits at the bottom of the screen and covers
  // roughly 50% of the viewport.  We measure its actual rendered height and
  // pass it to FunnelViz so it can shift the camera frustum upward and keep
  // the sphere visually centred in the unobstructed area.  The same measurement
  // is re-run whenever the panel resizes (content change, keyboard, orientation).
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    const isMobileLayout = () => window.matchMedia('(max-width: 480px)').matches;

    const update = () => {
      const viz = vizRef.current;
      if (!viz) return;
      // Only apply bottom inset on the mobile breakpoint where the panel is
      // at the bottom.  On wider screens the panel is on the side and does not
      // obstruct the vertical centre of the viewport.
      viz.setBottomInset(isMobileLayout() ? panel.offsetHeight : 0);
    };

    // Observe panel height changes (content change, colour-picker, keyboard).
    const ro = new ResizeObserver(update);
    ro.observe(panel);

    // Also recompute on window resize (breakpoint crossing, orientation change).
    window.addEventListener('resize', update);
    update(); // apply immediately after mount

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  // ── Constraint helpers ──────────────────────────────────────────────────────

  const applyConstraint = useCallback(() => {
    if (hits + blows > MASTERMIND_CONFIG.pegs) {
      setErrorMsg(`Hits + Blows cannot exceed ${MASTERMIND_CONFIG.pegs}`);
      return;
    }
    if (hits === MASTERMIND_CONFIG.pegs && blows > 0) {
      setErrorMsg('When all pegs hit, Blows must be 0');
      return;
    }
    setErrorMsg('');

    const ss = stateSpaceRef.current;
    ss.addConstraint({ guess: [...guess], score: { hits, blows } });

    setRemaining(ss.remaining.length);
    setHistory(ss.history);
    vizRef.current?.updateActiveSet(ss.remainingIndices());
    // Reset peg editor after applying
    setEditingPeg(null);
  }, [guess, hits, blows]);

  const reset = useCallback(() => {
    const ss = stateSpaceRef.current;
    ss.reset();
    setRemaining(ss.allCodes.length);
    setHistory([]);
    setGuess([0, 0, 0, 0]);
    setEditingPeg(null);
    setHits(0);
    setBlows(0);
    setErrorMsg('');
    vizRef.current?.updateActiveSet(ss.remainingIndices());
  }, []);

  const selectColor = (colorIndex: number) => {
    if (editingPeg === null) return;
    const next = [...guess];
    next[editingPeg] = colorIndex;
    setGuess(next);
    setEditingPeg(null);
  };

  const clampHits = (v: number) => Math.max(0, Math.min(MASTERMIND_CONFIG.pegs, v));
  const clampBlows = (v: number) => Math.max(0, Math.min(MASTERMIND_CONFIG.pegs, v));

  // ── Derived display state ───────────────────────────────────────────────────
  const isSolved = remaining === 1 && history.length > 0;
  const isImpossible = remaining === 0;
  const progressPct = total > 0 ? (remaining / total) * 100 : 0;

  return (
    <div className="app">
      {/* ── Three.js canvas fills the whole viewport ── */}
      <canvas ref={canvasRef} className="viz-canvas" />

      {/* ── Control panel overlaid on the left ── */}
      <aside className="panel" ref={panelRef}>
        <header className="panel-header">
          <h1 className="title">🔮 Puzzle Funnel</h1>
          <p className="subtitle">Mastermind · Hit &amp; Blow</p>
        </header>

        {/* Remaining count */}
        <div className="stat-block">
          <div className="stat-row">
            <span
              className="stat-value"
              style={{
                color: isSolved
                  ? '#2ecc71'
                  : isImpossible
                    ? '#e74c3c'
                    : '#a78bfa',
              }}
            >
              {remaining}
            </span>
            <span className="stat-label">/ {total} codes</span>
          </div>
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <span className="stat-subtext">
            {progressPct.toFixed(1)}% of search space remaining
          </span>
        </div>

        {isSolved && (
          <div className="banner banner-success">✓ Unique solution found!</div>
        )}
        {isImpossible && (
          <div className="banner banner-error">
            ✗ No valid codes remain — check the entered responses
          </div>
        )}

        {/* ── Constraint entry ── */}
        <section className="section">
          <h2 className="section-title">Add Constraint</h2>

          {/* Guess pegs */}
          <label className="field-label">Guess</label>
          <div className="guess-row">
            {guess.map((c, i) => (
              <button
                key={i}
                type="button"
                className={`peg-btn${editingPeg === i ? ' peg-btn--active' : ''}`}
                style={{ backgroundColor: COLOR_HEX[c] }}
                onClick={() => setEditingPeg(editingPeg === i ? null : i)}
                aria-label={`Peg ${i + 1}: ${COLOR_NAMES[c]} (click to change)`}
                title={`Peg ${i + 1}: ${COLOR_NAMES[c]} — click to change`}
              />
            ))}
          </div>

          {/* Colour picker — appears when a peg is selected */}
          {editingPeg !== null && (
            <div className="color-picker">
              <span className="field-label">Pick colour for peg {editingPeg + 1}</span>
              <div className="color-options">
                {COLOR_HEX.map((hex, ci) => (
                  <button
                    key={ci}
                    type="button"
                    className={`color-dot${guess[editingPeg] === ci ? ' color-dot--selected' : ''}`}
                    style={{ backgroundColor: hex }}
                    onClick={() => selectColor(ci)}
                    aria-label={`Set peg ${editingPeg + 1} to ${COLOR_NAMES[ci]}`}
                    title={COLOR_NAMES[ci]}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Score entry */}
          <div className="score-row">
            <div className="score-field">
              <label className="field-label">
                Hits <span className="field-hint">(right place)</span>
              </label>
              <div className="stepper">
                <button
                  className="stepper-btn"
                  onClick={() => setHits(clampHits(hits - 1))}
                  aria-label="Decrease hits"
                >
                  −
                </button>
                <span className="stepper-val">{hits}</span>
                <button
                  className="stepper-btn"
                  onClick={() => setHits(clampHits(hits + 1))}
                  aria-label="Increase hits"
                >
                  +
                </button>
              </div>
            </div>

            <div className="score-field">
              <label className="field-label">
                Blows <span className="field-hint">(wrong place)</span>
              </label>
              <div className="stepper">
                <button
                  className="stepper-btn"
                  onClick={() => setBlows(clampBlows(blows - 1))}
                  aria-label="Decrease blows"
                >
                  −
                </button>
                <span className="stepper-val">{blows}</span>
                <button
                  className="stepper-btn"
                  onClick={() => setBlows(clampBlows(blows + 1))}
                  aria-label="Increase blows"
                >
                  +
                </button>
              </div>
            </div>
          </div>

          {errorMsg && <p className="error-text">{errorMsg}</p>}

          <button
            className="btn btn-primary"
            onClick={applyConstraint}
            disabled={isSolved || isImpossible}
          >
            Apply Constraint
          </button>
        </section>

        {/* ── History ── */}
        {history.length > 0 && (
          <section className="section">
            <h2 className="section-title">History</h2>
            <ol className="history-list">
              {history.map((c, i) => (
                <li key={i} className="history-item">
                  <span className="history-num">{i + 1}</span>
                  <div className="history-code">
                    {c.guess.map((col, pi) => (
                      <PegDisplay key={pi} colorIndex={col} size="sm" />
                    ))}
                  </div>
                  <ScoreTag hits={c.score.hits} blows={c.score.blows} />
                </li>
              ))}
            </ol>
          </section>
        )}

        <button className="btn btn-secondary" onClick={reset}>
          Reset
        </button>

        <p className="hint">Drag · scroll · pinch to explore the 3D space</p>
      </aside>
    </div>
  );
}
