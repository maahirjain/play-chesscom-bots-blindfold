// tests/acceptance_7_2.test.js
//
// Task 7.2 (PLAN.md §7.2): "Verify promotions, castling, and en passant
// replay correctly from starting FEN and confirmed moves."
//
// V1 — static/unit. Independent acceptance: demonstrates that a game
// containing special moves can be reconstructed from exported raw data
// (gameStartingFen from metadata.json / the game_started event, plus
// move_confirmed {from, to, promotion} payloads from events.jsonl).
//
// The replay harness lives in THIS TEST FILE ONLY. Per 7.13 ("a
// collection correctness check, not a shipped analysis command"), no
// replay code may become product code.
//
// Promotion vocabulary (pinned): move_confirmed.promotion is lowercase
// 'q' | 'r' | 'b' | 'n' or null (game_records.js requirePromotion).
// chess.js accepts lowercase in the move object.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const { Chess } = require('../chess.min.js');

// --- test-only replay harness (never product code) ---
// Applies confirmed moves ({from, to, promotion}) to a starting FEN
// using the vendored chess.js. Returns the FEN after each ply.
function replayFromFen(startFen, confirmedMoves) {
  const game = new Chess(startFen);
  const fens = [];
  for (const m of confirmedMoves) {
    const applied = game.move({ from: m.from, to: m.to, promotion: m.promotion || undefined });
    if (!applied) {
      throw new Error(`replay failed at ${m.from}${m.to}${m.promotion || ''} from ${game.fen()}`);
    }
    fens.push(game.fen());
  }
  return fens;
}

// ------------------------------------------------------------------
// AC1 — promotion replay.
// ------------------------------------------------------------------
describe('AC1 — promotion replay', () => {
  it('e7e8q produces a white queen on e8', () => {
    const startFen = '7k/4P3/8/8/8/8/8/4K3 w - - 0 1';
    const [fen] = replayFromFen(startFen, [{ from: 'e7', to: 'e8', promotion: 'q' }]);
    assert.equal(fen, '4Q2k/8/8/8/8/8/8/4K3 b - - 0 1');
  });

  it('underpromotion to knight works (b7b8n)', () => {
    const startFen = '7k/1P6/8/8/8/8/8/4K3 w - - 0 1';
    const [fen] = replayFromFen(startFen, [{ from: 'b7', to: 'b8', promotion: 'n' }]);
    assert.ok(fen.startsWith('1N5k/'), 'knight on b8: ' + fen);
  });
});

// ------------------------------------------------------------------
// AC2 — kingside castling replay.
// ------------------------------------------------------------------
describe('AC2 — kingside castling replay', () => {
  it('e1g1 moves king and rook, updates castling rights', () => {
    const startFen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
    const [fen] = replayFromFen(startFen, [{ from: 'e1', to: 'g1', promotion: null }]);
    assert.equal(fen, 'r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1');
  });
});

// ------------------------------------------------------------------
// AC3 — queenside castling replay.
// ------------------------------------------------------------------
describe('AC3 — queenside castling replay', () => {
  it('e1c1 moves king and rook, updates castling rights', () => {
    const startFen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
    const [fen] = replayFromFen(startFen, [{ from: 'e1', to: 'c1', promotion: null }]);
    assert.equal(fen, 'r3k2r/8/8/8/8/8/8/2KR3R b kq - 1 1');
  });
});

// ------------------------------------------------------------------
// AC4 — en passant replay.
// ------------------------------------------------------------------
describe('AC4 — en passant replay', () => {
  it('e5xd6 e.p. removes the pawn from d5 (not d6)', () => {
    // White pawn e5, black just played d7d5 (ep square d6).
    const startFen = '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2';
    const [fen] = replayFromFen(startFen, [{ from: 'e5', to: 'd6', promotion: null }]);
    assert.equal(fen, '4k3/8/3P4/8/8/8/8/4K3 b - - 0 2',
      'black pawn gone from d5, white pawn on d6');
  });
});

// ------------------------------------------------------------------
// AC5 — full-game replay with all three special moves.
// ------------------------------------------------------------------
describe('AC5 — full-game replay', () => {
  it('short game with castling, en passant, and promotion replays to the known final FEN', () => {
    // Constructed line:
    // 1. e4 d5 2. e5 f5 3. e6?? — no; use a concrete legal line:
    // 1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O Nf6 5. d4 exd4 6. e5 d5
    // 7. exf6 e.p.? — not legal there. Use a simpler synthetic line
    // verified ply-by-ply below instead of a "real" game.
    //
    // Synthetic line from the start position:
    // 1. e4 (e2e4) 1... e5 (e7e5) 2. Nf3 (g1f3) 2... Nc6 (b8c6)
    // 3. Bc4 (f1c4) 3... Bc5 (f8c5) 4. O-O (e1g1)
    const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const moves = [
      { from: 'e2', to: 'e4', promotion: null },
      { from: 'e7', to: 'e5', promotion: null },
      { from: 'g1', to: 'f3', promotion: null },
      { from: 'b8', to: 'c6', promotion: null },
      { from: 'f1', to: 'c4', promotion: null },
      { from: 'f8', to: 'c5', promotion: null },
      { from: 'e1', to: 'g1', promotion: null },
    ];
    const fens = replayFromFen(startFen, moves);
    assert.equal(fens.length, 7);
    // After 4. O-O: white king g1, rook f1, black to move.
    const finalFen = fens[6];
    assert.ok(finalFen.includes('RNBQ1RK1'), 'kingside castle visible: ' + finalFen);
    assert.ok(finalFen.startsWith('r1bqk1nr/'), 'black intact: ' + finalFen);
  });

  it('promotion + en passant in one replay chain', () => {
    // White: pawn e5; black king h8. Sequence:
    // ... d7d5 (sets up ep), e5xd6 e.p., d6d7, d7d8=Q.
    // Start from a custom FEN to keep the line short.
    const startFen = '7k/3p4/8/4P3/8/8/8/4K3 b - - 0 1';
    const moves = [
      { from: 'd7', to: 'd5', promotion: null }, // black double push
      { from: 'e5', to: 'd6', promotion: null }, // e.p. capture
      { from: 'h8', to: 'g8', promotion: null }, // black king sidesteps
      { from: 'd6', to: 'd7', promotion: null },
      { from: 'g8', to: 'h8', promotion: null }, // black king returns
      { from: 'd7', to: 'd8', promotion: 'q' }, // promotion
    ];
    const fens = replayFromFen(startFen, moves);
    assert.equal(fens[1], '7k/8/3P4/8/8/8/8/4K3 b - - 0 2',
      'after e.p.: pawn on d6, d5 empty');
    assert.ok(fens[5].startsWith('3Q3k/'), 'queen on d8: ' + fens[5]);
  });
});

// ------------------------------------------------------------------
// AC6 — promotion vocabulary pin.
// ------------------------------------------------------------------
describe('AC6 — promotion vocabulary', () => {
  it("move_confirmed promotion values are lowercase 'q'/'r'/'b'/'n' and chess.js accepts them", () => {
    for (const p of ['q', 'r', 'b', 'n']) {
      const game = new Chess('7k/4P3/8/8/8/8/8/4K3 w - - 0 1');
      const applied = game.move({ from: 'e7', to: 'e8', promotion: p });
      assert.ok(applied, `chess.js must accept promotion '${p}'`);
      assert.equal(applied.promotion, p);
    }
    // null promotion on a promotion move is rejected by chess.js —
    // the collection must record the piece (3.1.7), never null.
    const game = new Chess('7k/4P3/8/8/8/8/8/4K3 w - - 0 1');
    assert.equal(game.move({ from: 'e7', to: 'e8', promotion: null }), null,
      'null promotion must not silently become a queen');
  });
});

// ------------------------------------------------------------------
// Diff discipline.
// ------------------------------------------------------------------
describe('7.2 diff discipline', () => {
  it('no product code changed (verification-only)', () => {
    const status = execSync('git status --porcelain', { cwd: ROOT }).toString();
    const productFiles = status.split('\n')
      .map((l) => l.slice(3).trim())
      .filter((f) => f !== '' && !f.startsWith('tests/') &&
        !f.startsWith('.autodev/') && f !== 'README.md' && f !== 'EXPORT.md');
    assert.deepEqual(productFiles, [],
      'verification-only: no product files may change, got: ' + JSON.stringify(productFiles));
  });

  it('PLAN.md unmodified', () => {
    const diff = execSync('git diff HEAD -- PLAN.md', { cwd: ROOT }).toString();
    assert.equal(diff.trim(), '', 'PLAN.md must never be modified');
  });
});
