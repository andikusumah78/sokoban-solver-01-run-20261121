// A push-optimal Sokoban solver for make.fun's sokoban-solver-01-run-20261121.
//
// How it works, in short:
// - A level is a hallway with small rooms off it (3 or 4 boxes each), and a box
//   pushed out of a room into the hallway can never come back, so the rooms are
//   independent: the level's optimum is the sum of its rooms' optima. The solver
//   cuts the hallway out of the floor and solves each room on its own.
// - Each room is solved with A* over pushes: a state is the boxes' squares plus
//   the player's reachable region (named by its lowest square). The estimate is
//   the cheapest way to match every box to a different goal, where a box's cost
//   to a goal is its push distance ignoring the other boxes, so the estimate
//   never overstates the pushes left and the first solution found is optimal.
// - Two deadlocks are pruned, both safe: a box on a dead square (one no pull
//   from a goal ever reaches) and a box frozen inside a 2 x 2 block of walls
//   and boxes with a box off its goal.
// - Everything is budgeted by work, never by the clock, so two runs of the
//   program write the same bytes: each room's search stops after a fixed
//   number of expansions, and the whole run after a fixed total.
//
// Node 22 runs this file as it is (erasable TypeScript only): no imports
// beyond node:fs and node:path, no network, no clock, no randomness.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The four steps, always in this order, so every tie breaks the same way.
const DIRS = [
  { dx: 0, dy: -1, step: 'u', push: 'U' },
  { dx: 0, dy: 1, step: 'd', push: 'D' },
  { dx: -1, dy: 0, step: 'l', push: 'L' },
  { dx: 1, dy: 0, step: 'r', push: 'R' },
] as const;

// Work budgets (counts of expanded states, never seconds): one room's search
// gives up past ROOM_STATE_CAP, a whole-level search past LEVEL_STATE_CAP,
// and the run as a whole past GLOBAL_EXPANSION_CAP, leaving that instance
// with an empty (valid, scoreless) answer rather than risking the wall.
const ROOM_STATE_CAP = 200_000;
const LEVEL_STATE_CAP = 200_000;
const GLOBAL_EXPANSION_CAP = 800_000;
let expansionsUsed = 0;

/** A board with a one-cell wall border, so every neighbour lookup stays inside the arrays. */
interface Board {
  W: number;
  H: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

interface Room {
  squares: Set<number>;
  goals: number[];
}

/** Parse XSB text (# wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal). */
function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const W = w + 2;
  const H = h + 2;
  const wall = new Uint8Array(W * H).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = (y + 1) * W + (x + 1);
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  return { W, H, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * The live squares: every square a box can ever be pulled back to from some
 * goal. A box on any other square can never reach a goal, so a push onto one
 * is a dead end. The pull-back walks from the goals: a box at x can have come
 * from y = x - d when y is floor and the player could stand at y - d.
 */
function liveSquares(b: Board): Uint8Array {
  const live = new Uint8Array(b.W * b.H);
  const queue: number[] = [];
  for (const g of b.goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const d of DIRS) {
      const o = d.dy * b.W + d.dx;
      const y = x - o;
      if (!b.wall[y] && !b.wall[y - o] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * For each goal, the fewest pushes a lone box needs to reach it from every
 * square, ignoring the other boxes: the same pull-back as liveSquares, but
 * counting steps. -1 where the goal cannot be reached at all.
 */
function pushDistances(b: Board): Int32Array[] {
  return b.goals.map((g) => {
    const dist = new Int32Array(b.W * b.H).fill(-1);
    dist[g] = 0;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const x = queue[qi];
      for (const d of DIRS) {
        const o = d.dy * b.W + d.dx;
        const y = x - o;
        if (!b.wall[y] && !b.wall[y - o] && dist[y] < 0) {
          dist[y] = dist[x] + 1;
          queue.push(y);
        }
      }
    }
    return dist;
  });
}

/**
 * Whether the box just pushed onto t is frozen inside a 2 x 2 block of walls
 * and boxes with a box off its goal: no push can ever move a box of that
 * block again, so the state is dead.
 */
function frozenBlock(b: Board, occ: Uint8Array, goal: Uint8Array, t: number): boolean {
  const W = b.W;
  const wall = b.wall;
  for (const a of [t, t - 1, t - W, t - W - 1]) {
    const c1 = a;
    const c2 = a + 1;
    const c3 = a + W;
    const c4 = a + W + 1;
    if (
      (wall[c1] || occ[c1]) &&
      (wall[c2] || occ[c2]) &&
      (wall[c3] || occ[c3]) &&
      (wall[c4] || occ[c4])
    ) {
      if (
        (occ[c1] && !goal[c1]) ||
        (occ[c2] && !goal[c2]) ||
        (occ[c3] && !goal[c3]) ||
        (occ[c4] && !goal[c4])
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Flood the squares the player reaches from `from` around walls and boxes,
 * marking them in `seen` with `stamp`, and return the lowest square reached.
 * The lowest square names the region: two states with the same boxes and the
 * same region are one state, whatever square the player happens to stand on.
 */
function floodLow(
  b: Board,
  occ: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    const q0 = p - b.W;
    const q1 = p + b.W;
    const q2 = p - 1;
    const q3 = p + 1;
    if (!b.wall[q0] && !occ[q0] && seen[q0] !== stamp) {
      seen[q0] = stamp;
      stack[n++] = q0;
    }
    if (!b.wall[q1] && !occ[q1] && seen[q1] !== stamp) {
      seen[q1] = stamp;
      stack[n++] = q1;
    }
    if (!b.wall[q2] && !occ[q2] && seen[q2] !== stamp) {
      seen[q2] = stamp;
      stack[n++] = q2;
    }
    if (!b.wall[q3] && !occ[q3] && seen[q3] !== stamp) {
      seen[q3] = stamp;
      stack[n++] = q3;
    }
  }
  return low;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower-case LURD letters, or null. */
function walkTo(b: Board, occ: Uint8Array, from: number, to: number): string | null {
  if (from === to) return '';
  const size = b.W * b.H;
  const prev = new Int32Array(size).fill(-1);
  const how = new Array<string>(size);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const d of DIRS) {
      const q = p + d.dy * b.W + d.dx;
      if (b.wall[q] || occ[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = d.step;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** Play `moves` (LURD, either case) on the board: the boxes and player after them, or null on an illegal step. */
function applyMoves(
  b: Board,
  boxesIn: number[],
  playerIn: number,
  moves: string,
): { boxes: number[]; player: number } | null {
  const boxes = boxesIn.slice();
  let player = playerIn;
  for (const ch of moves) {
    const lower = ch.toLowerCase();
    const dir = DIRS.find((d) => d.step === lower);
    if (dir === undefined) return null;
    const o = dir.dy * b.W + dir.dx;
    const next = player + o;
    if (b.wall[next]) return null;
    const at = boxes.indexOf(next);
    if (at >= 0) {
      const beyond = next + o;
      if (b.wall[beyond] || boxes.includes(beyond)) return null;
      boxes[at] = beyond;
    }
    player = next;
  }
  boxes.sort((a, b) => a - b);
  return { boxes, player };
}

/** Every ordering of 0..n-1, for matching boxes to goals (n is at most 5 here). */
function allPerms(n: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const used = new Array<boolean>(n).fill(false);
  const build = (): void => {
    if (cur.length === n) {
      out.push(cur.slice());
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      build();
      cur.pop();
      used[i] = false;
    }
  };
  build();
  return out;
}

/** A heap entry: [f, h, insertion order, state index]. Lower f first, then lower h, then earlier. */
type HeapEntry = [number, number, number, number];

function heapLess(a: HeapEntry, b: HeapEntry): boolean {
  return a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
}

function heapPush(heap: HeapEntry[], e: HeapEntry): void {
  let i = heap.length;
  heap.push(e);
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (!heapLess(heap[i]!, heap[p]!)) break;
    const t = heap[i]!;
    heap[i] = heap[p]!;
    heap[p] = t;
    i = p;
  }
}

function heapPop(heap: HeapEntry[]): HeapEntry {
  const top = heap[0]!;
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    for (let i = 0; ; ) {
      let c = 2 * i + 1;
      if (c >= heap.length) break;
      if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
      if (!heapLess(heap[c]!, heap[i]!)) break;
      const t = heap[i]!;
      heap[i] = heap[c]!;
      heap[c] = t;
      i = c;
    }
  }
  return top;
}

/**
 * The push-optimal solution of one board (a room, or a whole level as a
 * fallback): { pushes, moves } with moves in LURD (a lower letter a step, an
 * upper one a push), or null when the search gives up. A* over pushes with
 * the cheapest box-to-goal matching as its estimate, which never overstates
 * the pushes left, so the first solved state the search takes off the heap
 * is optimal. Dead squares and frozen 2 x 2 blocks are pruned.
 */
function searchPushOptimal(sub: Board, cap: number): { pushes: number; moves: string } | null {
  const { W, H, wall, goals, boxes: startBoxes, player: startPlayer } = sub;
  const size = W * H;
  const goalSet = new Uint8Array(size);
  for (const g of goals) goalSet[g] = 1;
  const live = liveSquares(sub);
  const sortedStart = startBoxes.slice().sort((a, b) => a - b);
  for (const b of sortedStart) if (!live[b]) return null;
  if (sortedStart.every((b) => goalSet[b])) return { pushes: 0, moves: '' };
  const dist = pushDistances(sub);
  const n = sortedStart.length;
  const perms = n <= 5 ? allPerms(n) : null;
  // The estimate: with few boxes, the cheapest one-to-one matching of boxes
  // to goals by push distance; with many, each box's nearest goal summed.
  // Either way a lower bound on the pushes left: one push moves one box one
  // square, and a box needs at least its push distance to reach its goal.
  const heuristic = (bs: number[]): number => {
    if (perms !== null) {
      let best = Infinity;
      for (const p of perms) {
        let s = 0;
        for (let i = 0; i < n; i++) {
          const d = dist[p[i]]![bs[i]]!;
          if (d < 0) {
            s = Infinity;
            break;
          }
          s += d;
        }
        if (s < best) best = s;
      }
      return best;
    }
    let s = 0;
    for (const b of bs) {
      let m = Infinity;
      for (let gi = 0; gi < goals.length; gi++) {
        const d = dist[gi]![b]!;
        if (d >= 0 && d < m) m = d;
      }
      if (m === Infinity) return Infinity;
      s += m;
    }
    return s;
  };
  // A state's key: its region's lowest square and its boxes. Numeric while
  // it stays exact (small rooms), a string otherwise (a whole level).
  const numericKey = size ** (n + 1) < Number.MAX_SAFE_INTEGER;
  const keyOf = (bs: number[], low: number): number | string => {
    if (numericKey) {
      let k = low;
      for (const b of bs) k = k * size + b;
      return k;
    }
    return String.fromCharCode(low, ...bs);
  };
  const occ = new Uint8Array(size);
  const seen = new Int32Array(size);
  // A second flood table for the successors' region lows: the expansion's
  // own region marks live in `seen`, and a low flood must not overwrite them.
  const seenLow = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  let stampLow = 0;
  for (const b of sortedStart) occ[b] = 1;
  const low0 = floodLow(sub, occ, startPlayer, seen, ++stamp, stack);
  for (const b of sortedStart) occ[b] = 0;
  const h0 = heuristic(sortedStart);
  if (h0 === Infinity) return null;
  const sBoxes: number[][] = [sortedStart];
  const sPlayer: number[] = [startPlayer];
  const sG: number[] = [0];
  const sParent: number[] = [-1];
  const sPush: ({ from: number; to: number; dir: number } | null)[] = [null];
  const sKey: (number | string)[] = [keyOf(sortedStart, low0)];
  const best = new Map<number | string, number>([[sKey[0]!, 0]]);
  const heap: HeapEntry[] = [];
  let seq = 0;
  heapPush(heap, [h0, h0, seq++, 0]);
  let expansions = 0;
  while (heap.length > 0) {
    const entry = heapPop(heap);
    const s = entry[3];
    if (best.get(sKey[s]!) !== sG[s]) continue;
    const boxes = sBoxes[s]!;
    if (boxes.every((b) => goalSet[b])) {
      // Walk the parents back, then spell out the moves: walk to each push's
      // square, then the push itself.
      const path: number[] = [];
      for (let t = s; t > 0; t = sParent[t]!) path.push(t);
      path.reverse();
      let moves = '';
      let player = startPlayer;
      let cur = sortedStart;
      const occ2 = new Uint8Array(size);
      for (const t of path) {
        const nb = sBoxes[t]!;
        const push = sPush[t]!;
        const o = DIRS[push.dir]!.dy * W + DIRS[push.dir]!.dx;
        for (const b of cur) occ2[b] = 1;
        const walk = walkTo(sub, occ2, player, push.from - o);
        for (const b of cur) occ2[b] = 0;
        if (walk === null) return null;
        moves += walk + DIRS[push.dir]!.push;
        player = push.from;
        cur = nb;
      }
      const check = applyMoves(sub, sortedStart, startPlayer, moves);
      if (check === null || !check.boxes.every((b) => goalSet[b])) return null;
      return { pushes: path.length, moves };
    }
    expansions++;
    expansionsUsed++;
    if (expansions > cap || expansionsUsed > GLOBAL_EXPANSION_CAP) return null;
    const g = sG[s]!;
    for (const b of boxes) occ[b] = 1;
    const stampHere = ++stamp;
    floodLow(sub, occ, sPlayer[s]!, seen, stampHere, stack);
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      for (let di = 0; di < 4; di++) {
        const o = DIRS[di]!.dy * W + DIRS[di]!.dx;
        const t = b + o;
        if (wall[t] || occ[t] || !live[t]) continue;
        if (seen[b - o] !== stampHere) continue;
        occ[b] = 0;
        occ[t] = 1;
        const frozen = frozenBlock(sub, occ, goalSet, t);
        if (frozen) {
          occ[t] = 0;
          occ[b] = 1;
          continue;
        }
        const nb = boxes.slice();
        nb[bi] = t;
        nb.sort((a, b2) => a - b2);
        const low = floodLow(sub, occ, b, seenLow, ++stampLow, stack);
        const key = keyOf(nb, low);
        const prev = best.get(key);
        if (prev === undefined || prev > g + 1) {
          const h = heuristic(nb);
          if (h !== Infinity) {
            best.set(key, g + 1);
            const idx = sBoxes.length;
            sBoxes.push(nb);
            sPlayer.push(b);
            sG.push(g + 1);
            sParent.push(s);
            sPush.push({ from: b, to: t, dir: di });
            sKey.push(key);
            heapPush(heap, [g + 1 + h, h, seq++, idx]);
          }
        }
        occ[t] = 0;
        occ[b] = 1;
      }
    }
    for (const b of boxes) occ[b] = 0;
  }
  return null;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal, since a push back through a door would need
 * the player on the hallway's far side, which is wall) out of the floor, and
 * each part left that holds a box is a room. Null when the level is no set
 * of rooms: a box starts in the hallway, a goal is cut off, or some part
 * holds a different count of boxes and goals.
 */
function roomsOf(level: Board): Room[] | null {
  const live = liveSquares(level);
  const row = Math.floor(level.player / level.W);
  const cut = new Uint8Array(level.W * level.H);
  for (let x = 0; x < level.W; x++) {
    const i = row * level.W + x;
    if (!level.wall[i] && !live[i]) cut[i] = 1;
  }
  if (level.boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(level.W * level.H).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < part.length; s++) {
    if (level.wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const d of DIRS) {
        const q = squares[i]! + d.dy * level.W + d.dx;
        if (!level.wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares: new Set(squares), goals: [] });
  }
  for (const g of level.goals) {
    if (part[g] < 0) return null;
    rooms[part[g]]!.goals.push(g);
  }
  const withBoxes = rooms.filter((r) => {
    let count = 0;
    for (const b of level.boxes) if (r.squares.has(b)) count++;
    return count > 0;
  });
  for (const r of withBoxes) {
    let count = 0;
    for (const b of level.boxes) if (r.squares.has(b)) count++;
    if (count !== r.goals.length) return null;
  }
  return withBoxes;
}

/** One room as its own board: every box outside it stands as a wall, the player where it stands now. */
function subBoard(level: Board, room: Room, boxes: number[], player: number): Board {
  const wall = level.wall.slice();
  for (const b of boxes) if (!room.squares.has(b)) wall[b] = 1;
  const roomBoxes = boxes.filter((b) => room.squares.has(b)).sort((a, b) => a - b);
  return {
    W: level.W,
    H: level.H,
    wall,
    goals: room.goals.slice().sort((a, b) => a - b),
    boxes: roomBoxes,
    player,
  };
}

/** The whole level solved as one board: the fallback when it is no set of rooms, or a room's search gives up. */
function solveWhole(level: Board): string {
  const res = searchPushOptimal(level, LEVEL_STATE_CAP);
  if (res === null) return '';
  const check = applyMoves(level, level.boxes, level.player, res.moves);
  if (check === null || !check.boxes.every((b) => level.goals.includes(b))) return '';
  return res.moves;
}

/** The level's moves: room by room, each room's optimum, the player walking on from where the last room left it. */
function solveLevel(text: string): string {
  const level = parseLevel(text);
  if (level.player < 0) return '';
  const rooms = roomsOf(level);
  if (rooms === null) return solveWhole(level);
  let boxes = level.boxes.slice();
  let player = level.player;
  let moves = '';
  for (const room of rooms) {
    const sub = subBoard(level, room, boxes, player);
    const res = searchPushOptimal(sub, ROOM_STATE_CAP);
    if (res === null) return solveWhole(level);
    const sim = applyMoves(level, boxes, player, res.moves);
    if (sim === null) return solveWhole(level);
    boxes = sim.boxes;
    player = sim.player;
    moves += res.moves;
    const roomBoxes = boxes.filter((b) => room.squares.has(b));
    if (!roomBoxes.every((b) => room.goals.includes(b))) return solveWhole(level);
  }
  const final = applyMoves(level, level.boxes, level.player, moves);
  if (final === null || !final.boxes.every((b) => level.goals.includes(b))) return solveWhole(level);
  return moves;
}

for (const id of readdirSync(IN_DIR).sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(IN_DIR, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(OUT_DIR, id), { recursive: true });
  writeFileSync(join(OUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
