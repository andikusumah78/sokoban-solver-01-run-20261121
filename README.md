[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/andikusumah78/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/andikusumah78/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

# Sokoban solver

A push-optimal Sokoban solver for make.fun's "Build the best Sokoban solver, 21 November 2026" bounty. One program (`main.ts`, Node 22, no dependencies) answers every instance of a set: it reads `/input/<id>/level.txt` and writes `/output/<id>/solution.txt` with the player's moves in LURD.

## How it works

- **Rooms are independent.** A level is a hallway with small rooms off it (3 or 4 boxes each), and a box pushed out of a room into the hallway can never come back, so the level's optimum is the sum of its rooms' optima. The solver cuts the hallway (the dead squares of the player's row) out of the floor and solves each room on its own.
- **A\* over pushes.** A state is the boxes' squares plus the player's reachable region (named by its lowest square). The estimate is the cheapest one-to-one matching of boxes to goals by push distance ignoring the other boxes, which never overstates the pushes left — so the first solution found is push-optimal.
- **Safe deadlock pruning.** A box on a dead square (no pull from a goal ever reaches it) and a box frozen inside a 2 x 2 block of walls and boxes with a box off its goal are both pruned; neither prunes a solvable state.
- **Budgeted by work, never by the clock.** Each room's search stops after a fixed number of expanded states, and the whole run after a fixed total, so two runs write the same bytes.

## Results

- Practice set: **1,000,000** — every instance solved in exactly P\* pushes (13, 16, 29, 47, 60), in about 0.3 s for the whole set.
- 10 freshly drawn sets from the kit's own generator: **1,000,000 on all 10** (50/50 levels optimal), each set in about 0.2–0.3 s.
- The house baseline (plain-astar 1.0.0) scores 200,000 on the practice set — it only solves the first instance.

## Local test

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Then score the outputs with the kit's scorer (`program/scorer/score.ts`) against `practice/reference/`.

## License

MIT
