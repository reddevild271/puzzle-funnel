/**
 * Core types shared across all puzzle implementations.
 * Designed to be generalizable beyond Mastermind.
 */

/** A single peg/slot value, represented as a 0-based color index */
export type Color = number;

/** A complete code sequence. Length equals the number of pegs. */
export type Code = readonly number[];

/**
 * Scoring result for a Mastermind-style guess.
 * Hits  = correct value in the correct position.
 * Blows = correct value in the wrong position.
 */
export interface Score {
  hits: number;
  blows: number;
}

/** A guess paired with the response/feedback it received */
export interface Constraint {
  guess: Code;
  score: Score;
}

/** Configuration describing a Mastermind-style puzzle variant */
export interface PuzzleConfig {
  pegs: number;
  colors: number;
}
