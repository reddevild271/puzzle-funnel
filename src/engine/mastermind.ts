import type { Code, Score, Constraint, PuzzleConfig } from './types';

/**
 * Score a guess against a secret code using Hit-and-Blow / Mastermind rules.
 *
 * Hits  = correct color in the correct position.
 * Blows = correct color present somewhere, but in the wrong position.
 *
 * Duplicate colors are handled correctly: each peg in the secret can only
 * account for one hit or one blow, whichever applies first.
 */
export function scoreGuess(guess: Code, secret: Code): Score {
  if (guess.length !== secret.length) {
    throw new Error(`Guess and secret must have the same length: got ${guess.length} and ${secret.length}`);
  }

  const n = guess.length;
  let hits = 0;
  const guessLeft: number[] = [];
  const secretLeft: number[] = [];

  for (let i = 0; i < n; i++) {
    if (guess[i] === secret[i]) {
      hits++;
    } else {
      guessLeft.push(guess[i]);
      secretLeft.push(secret[i]);
    }
  }

  // Count blows: how many guessLeft colors appear in secretLeft
  const secretCounts = new Map<number, number>();
  for (const c of secretLeft) {
    secretCounts.set(c, (secretCounts.get(c) ?? 0) + 1);
  }

  let blows = 0;
  for (const c of guessLeft) {
    const remaining = secretCounts.get(c) ?? 0;
    if (remaining > 0) {
      blows++;
      secretCounts.set(c, remaining - 1);
    }
  }

  return { hits, blows };
}

/**
 * Generate all possible codes for a given puzzle configuration in
 * lexicographic order: (0,0,…,0), (0,0,…,1), …, (C-1,C-1,…,C-1).
 */
export function generateAllCodes(config: PuzzleConfig): Code[] {
  const { pegs, colors } = config;
  const total = Math.pow(colors, pegs);
  const codes: number[][] = [];

  for (let i = 0; i < total; i++) {
    const code: number[] = new Array(pegs);
    let n = i;
    for (let p = pegs - 1; p >= 0; p--) {
      code[p] = n % colors;
      n = Math.floor(n / colors);
    }
    codes.push(code);
  }

  return codes;
}

/**
 * Convert a code to its index in the lexicographic ordering produced by
 * generateAllCodes.  Inverse of the loop in generateAllCodes.
 */
export function codeToIndex(code: Code, colors: number): number {
  let index = 0;
  for (const c of code) {
    index = index * colors + c;
  }
  return index;
}

/**
 * Return true if `candidate` is consistent with a single constraint
 * (i.e. scoring `guess` against `candidate` yields the observed `score`).
 */
export function isConsistentWith(candidate: Code, constraint: Constraint): boolean {
  const result = scoreGuess(constraint.guess, candidate);
  return result.hits === constraint.score.hits && result.blows === constraint.score.blows;
}

/**
 * Filter `codes` to only those that are consistent with every constraint
 * in `constraints`.
 */
export function filterCodes(codes: Code[], constraints: Constraint[]): Code[] {
  return codes.filter(code => constraints.every(c => isConsistentWith(code, c)));
}
