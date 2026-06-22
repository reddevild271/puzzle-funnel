import type { Code, Constraint, PuzzleConfig } from './types';
import { generateAllCodes, filterCodes, codeToIndex } from './mastermind';

/**
 * Tracks the shrinking set of possible solutions as constraints are added.
 *
 * Designed to be puzzle-agnostic: it works for any puzzle where
 * - the full state space can be enumerated upfront, and
 * - consistency with a constraint can be checked per-code.
 */
export class StateSpace {
  readonly config: PuzzleConfig;

  /** Every possible code for this configuration, in stable lexicographic order. */
  readonly allCodes: Code[];

  private _remaining: Code[];
  private _history: Constraint[];

  constructor(config: PuzzleConfig) {
    this.config = config;
    this.allCodes = generateAllCodes(config);
    this._remaining = [...this.allCodes];
    this._history = [];
  }

  /** Codes that are still consistent with all applied constraints. */
  get remaining(): readonly Code[] {
    return this._remaining;
  }

  /** Ordered history of all applied constraints. */
  get history(): readonly Constraint[] {
    return this._history;
  }

  /**
   * Apply a new guess/response constraint and update the remaining set.
   * The constraint is appended to history.
   */
  addConstraint(constraint: Constraint): void {
    this._history = [...this._history, constraint];
    this._remaining = filterCodes(this._remaining, [constraint]);
  }

  /** Remove all constraints and restore the full candidate set. */
  reset(): void {
    this._remaining = [...this.allCodes];
    this._history = [];
  }

  /**
   * Return the index (in allCodes) of the given code.
   * Uses the lexicographic base-colors numbering — O(pegs) lookup.
   */
  indexOf(code: Code): number {
    return codeToIndex(code, this.config.colors);
  }

  /** Indices (into allCodes) of the currently remaining codes. */
  remainingIndices(): Set<number> {
    return new Set(this._remaining.map(c => this.indexOf(c)));
  }
}
