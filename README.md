# Puzzle Funnel 🔮

An interactive **3D visualizer** that shows how the possibility space of a logic puzzle *funnels* from many candidates down to a single solution as guesses and responses are applied.

The initial focus is **Mastermind / Hit and Blow** (Nintendo Clubhouse Games–style: 4 pegs, 6 colors, duplicates allowed — 1,296 possible codes).

---

## Concept

Every code in the puzzle's state space is rendered as a **coloured particle** on a 3D sphere.
When you enter a guess and its response, all codes inconsistent with that response **drift outward and fade away**, leaving only the valid candidates bright at the centre.
The shrinking cluster of active particles makes the *funnelling* of information immediately visible.

---

## Getting Started

### Prerequisites

- **Node.js ^20.19.0 or >=22.12.0** and **npm 9+**

### Install & run locally

```bash
npm install
npm run dev
```

Then open **http://localhost:5173** in any modern browser.

### Production build

```bash
npm run build    # compiles TypeScript then bundles with Vite
npm run preview  # serves the dist/ folder locally
```

---

## How to Use

| Step | Action |
|------|--------|
| 1 | Click any of the **4 peg buttons** in the *Add Constraint* panel to select a colour |
| 2 | Adjust **Hits** (right colour, right place) and **Blows** (right colour, wrong place) with the ± steppers |
| 3 | Press **Apply Constraint** — eliminated codes fly outward and fade; the remaining count updates |
| 4 | Repeat until the count drops to **1** (unique solution found) |
| 5 | Press **Reset** to start over |

> **Orbit / explore the 3D scene** by dragging, scrolling, or pinching.

---

## Architecture

```
src/
├── engine/                 # Core puzzle logic — framework-agnostic
│   ├── types.ts            #   Shared interfaces: Code, Score, Constraint, PuzzleConfig
│   ├── mastermind.ts       #   Hit & Blow scoring, code generation, state filtering
│   └── stateSpace.ts       #   StateSpace class — tracks remaining candidates
├── visualization/
│   └── FunnelViz.ts        # Three.js particle system & animation loop
├── App.tsx                 # React UI — wires engine ↔ visualization
├── App.css                 # Dark-theme panel styles
└── main.tsx                # Entry point
```

### Key design decisions

| Choice | Rationale |
|--------|-----------|
| **Vite** | Sub-second HMR; native ESM; no config boilerplate |
| **React 18** | Declarative UI for the control panel; keeps visualization imperative |
| **Three.js** | Mature WebGL library with `OrbitControls`, shader materials, and a WebGPU upgrade path |
| **Custom `ShaderMaterial`** | Per-particle colour, size *and* opacity — needed for smooth fade/drift animation |
| **Additive blending** | Overlapping active particles create a natural glow; the cluster brightens as codes converge |
| **Fibonacci sphere layout** | Gives a uniform, aesthetically stable initial distribution of 1,296 points |

### Generalisation path

The `engine/` layer is designed to work for any puzzle where the state space can be enumerated and scored:
- `PuzzleConfig` carries peg/color counts (or equivalent parameters)
- `scoreGuess` + `filterCodes` are the only puzzle-specific primitives
- `StateSpace` is fully generic — swap in a different scoring function to support other games

---

## Tech Stack

| Tool | Version | Purpose |
|------|---------|---------|
| TypeScript | 5.x | Type safety throughout |
| Vite | 8.0 | Build tool & dev server |
| React | 18 | UI components |
| Three.js | 0.165 | 3D WebGL rendering |

---

## Future Directions

- Visualize the **full decision tree** (branching structure, not just current state)
- Color-coded **clusters** showing information-gain per guess
- **Strategy comparison** — render two game paths side-by-side
- **WebGPU renderer** for larger state spaces (e.g. 5-peg, 8-color = 32,768 codes)
- Generalize to other puzzles (Simon Tatham's collection, Wordle, …)
