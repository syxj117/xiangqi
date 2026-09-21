/* =========================================================
 * 中国象棋 - 游戏逻辑
 * 棋盘坐标：col 0..8 (横向 9 列), row 0..9 (纵向 10 行)
 * row=0 在顶部(黑方), row=9 在底部(红方)
 * 楚河汉界位于 row=4 与 row=5 之间
 * ========================================================= */

(() => {
  'use strict';

  // ---------- 轻量日志 ----------
  // 同时输出到浏览器控制台与服务器端 logs/ 目录 (POST /log)
  // 失败时静默降级, 不影响游戏运行
  const LOG_ENDPOINT = '/log';
  const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
  let logMinLevel = 20;

  function sendLog(level, event, data) {
    try {
      const payload = JSON.stringify({ level, event, data });
      // beacon 优先 (页面卸载也能发), 否则用 fetch
      if (navigator.sendBeacon) {
        const blob = new Blob([payload], { type: 'application/json' });
        navigator.sendBeacon(LOG_ENDPOINT, blob);
      } else {
        fetch(LOG_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          keepalive: true,
        }).catch(() => {});
      }
    } catch (_) { /* 静默 */ }
  }

  function log(level, event, data) {
    const lvl = LOG_LEVELS[level] || 20;
    if (lvl < logMinLevel) return;
    // 控制台
    const args = [`[${level}] ${event}`];
    if (data !== undefined) args.push(data);
    try {
      const fn = level === 'error' ? console.error
        : level === 'warn' ? console.warn
        : level === 'debug' ? console.debug
        : console.log;
      fn.apply(console, args);
    } catch (_) {}
    // 服务端
    sendLog(level, event, data);
  }

  const logger = {
    debug: (e, d) => log('debug', e, d),
    info:  (e, d) => log('info', e, d),
    warn:  (e, d) => log('warn', e, d),
    error: (e, d, err) => {
      if (err && err instanceof Error) {
        log('error', e, { message: err.message, stack: err.stack, ...d });
      } else {
        log('error', e, d);
      }
    },
  };

  // 全局兜底: 捕获未处理异常
  window.addEventListener('error', (ev) => {
    logger.error('window_error', null, ev.error || { message: ev.message, filename: ev.filename, line: ev.lineno });
  });
  window.addEventListener('unhandledrejection', (ev) => {
    logger.error('unhandled_promise', null, ev.reason);
  });

  // ---------- 常量 ----------
  const COLS = 9;
  const ROWS = 10;
  const RED = 'r';
  const BLACK = 'b';

  // 棋子类型
  const T = {
    KING: 'k',     // 将/帅
    ADVISOR: 'a',  // 士/仕
    ELEPHANT: 'e', // 象/相
    HORSE: 'h',    // 马
    ROOK: 'r',     // 车
    CANNON: 'c',   // 炮
    PAWN: 'p',     // 兵/卒
  };

  // 棋子显示文字
  const TEXT = {
    r: { k: '帅', a: '仕', e: '相', h: '马', r: '车', c: '炮', p: '兵' },
    b: { k: '将', a: '士', e: '象', h: '马', r: '车', c: '炮', p: '卒' },
  };

  // ---------- 初始布局 ----------
  // 每个棋子: { side, type, col, row }
  function createInitialPieces() {
    const pieces = [];
    // 黑方在上 (row 0~4)
    const back = [T.ROOK, T.HORSE, T.ELEPHANT, T.ADVISOR, T.KING, T.ADVISOR, T.ELEPHANT, T.HORSE, T.ROOK];
    back.forEach((type, col) => pieces.push({ side: BLACK, type, col, row: 0 }));
    pieces.push({ side: BLACK, type: T.CANNON, col: 1, row: 2 });
    pieces.push({ side: BLACK, type: T.CANNON, col: 7, row: 2 });
    [0, 2, 4, 6, 8].forEach(col => pieces.push({ side: BLACK, type: T.PAWN, col, row: 3 }));

    // 红方在下 (row 5~9)
    back.forEach((type, col) => pieces.push({ side: RED, type, col, row: 9 }));
    pieces.push({ side: RED, type: T.CANNON, col: 1, row: 7 });
    pieces.push({ side: RED, type: T.CANNON, col: 7, row: 7 });
    [0, 2, 4, 6, 8].forEach(col => pieces.push({ side: RED, type: T.PAWN, col, row: 6 }));

    return pieces;
  }

  // ---------- 游戏状态 ----------
  const state = {
    pieces: createInitialPieces(),
    turn: RED,            // 当前回合
    selected: null,      // 选中的棋子
    legalMoves: [],      // 选中棋子的合法走法 [{col,row}]
    history: [],          // 走子历史 (用于悔棋)
    flipped: false,      // 是否翻转视角
    winner: null,        // 胜方
    redPlayer: 'human',  // 红方玩家: 'human' | 'builtin' | configId
    blackPlayer: 'human',// 黑方玩家: 'human' | 'builtin' | configId
    aiThinking: false,   // AI 是否正在思考
    aiToken: 0,          // AI 回调世代号, 用于作废过期回调
    moveHistory: [],      // 走法记录 [{fromCol,fromRow,toCol,toRow,side}] 供 AI 上下文
  };

  // ---------- DOM ----------
  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');
  const statusEl = document.getElementById('status');
  const btnUndo = document.getElementById('btn-undo');
  const btnRestart = document.getElementById('btn-restart');
  const btnFlip = document.getElementById('btn-flip');
  const btnSettings = document.getElementById('btn-settings');
  const aiThinkingEl = document.getElementById('ai-thinking');
  const settingsOverlay = document.getElementById('settings-overlay');
  const btnCloseSettings = document.getElementById('btn-close-settings');
  const selectRed = document.getElementById('select-red');
  const selectBlack = document.getElementById('select-black');
  const btnAddAI = document.getElementById('btn-add-ai');
  const aiListEl = document.getElementById('ai-list');
  const cfgName = document.getElementById('cfg-name');
  const cfgBaseUrl = document.getElementById('cfg-baseurl');
  const cfgApiKey = document.getElementById('cfg-apikey');
  const cfgModel = document.getElementById('cfg-model');

  // ---------- 渲染参数 ----------
  let layout = {
    cell: 40,            // 单元格像素
    padding: 24,         // 棋盘内边距
    pieceRadius: 17,    // 棋子半径
    width: 0,
    height: 0,
  };

  // 根据屏幕尺寸自适应布局
  function computeLayout() {
    const wrap = canvas.parentElement;
    const availW = wrap.clientWidth - 16;
    const availH = wrap.clientHeight - 16;

    // 9 列 8 格宽度，10 行 9 格高度
    const cellByW = availW / 8;
    const cellByH = availH / 9;
    const cell = Math.max(20, Math.floor(Math.min(cellByW, cellByH)));
    const padding = Math.round(cell * 0.6);

    layout.cell = cell;
    layout.padding = padding;
    layout.pieceRadius = Math.round(cell * 0.42);
    layout.width = padding * 2 + cell * 8;
    layout.height = padding * 2 + cell * 9;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = layout.width * dpr;
    canvas.height = layout.height * dpr;
    canvas.style.width = layout.width + 'px';
    canvas.style.height = layout.height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // 棋盘坐标 -> 画布像素坐标 (考虑视角翻转)
  function cellToPixel(col, row) {
    const c = state.flipped ? COLS - 1 - col : col;
    const r = state.flipped ? ROWS - 1 - row : row;
    return {
      x: layout.padding + c * layout.cell,
      y: layout.padding + r * layout.cell,
    };
  }

  // 画布像素 -> 棋盘坐标
  function pixelToCell(x, y) {
    const c = Math.round((x - layout.padding) / layout.cell);
    const r = Math.round((y - layout.padding) / layout.cell);
    if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return null;
    return state.flipped
      ? { col: COLS - 1 - c, row: ROWS - 1 - r }
      : { col: c, row: r };
  }

  // ---------- 棋盘工具 ----------
  function pieceAt(col, row) {
    return state.pieces.find(p => p.col === col && p.row === row) || null;
  }

  function inBoard(col, row) {
    return col >= 0 && col < COLS && row >= 0 && row < ROWS;
  }

  function inPalace(side, col, row) {
    if (col < 3 || col > 5) return false;
    return side === RED ? (row >= 7 && row <= 9) : (row >= 0 && row <= 2);
  }

  function onOwnSide(side, row) {
    return side === RED ? row >= 5 : row <= 4;
  }

  // 统计两点之间(不含端点)的棋子数
  function countBetween(col1, row1, col2, row2) {
    const dc = Math.sign(col2 - col1);
    const dr = Math.sign(row2 - row1);
    let c = col1 + dc, r = row1 + dr;
    let n = 0;
    while (c !== col2 || r !== row2) {
      if (pieceAt(c, r)) n++;
      c += dc; r += dr;
    }
    return n;
  }

  // ---------- 各棋子移动规则 ----------
  // 返回该棋子在该局势下可走的位置数组 [{col,row}]
  function getMoves(piece) {
    const { side, type, col, row } = piece;
    switch (type) {
      case T.KING: return kingMoves(side, col, row);
      case T.ADVISOR: return advisorMoves(side, col, row);
      case T.ELEPHANT: return elephantMoves(side, col, row);
      case T.HORSE: return horseMoves(col, row);
      case T.ROOK: return rookMoves(col, row);
      case T.CANNON: return cannonMoves(col, row);
      case T.PAWN: return pawnMoves(side, col, row);
      default: return [];
    }
  }

  function kingMoves(side, col, row) {
    const moves = [];
    const deltas = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dc, dr] of deltas) {
      const nc = col + dc, nr = row + dr;
      // 帅/将只能在己方九宫格内一格直走
      if (!inPalace(side, nc, nr)) continue;
      const target = pieceAt(nc, nr);
      if (target && target.side === side) continue;
      // 走过去后不能与对方将照面(同列直线无子相对)
      if (wouldKingsFace(side, nc, nr)) continue;
      moves.push({ col: nc, row: nr });
    }
    return moves;
  }

  // 判断: 假设己方将走到 (col,row) 后, 是否会与对方将"照面"
  // (两将在同一列, 且中间无任何棋子)
  function wouldKingsFace(side, col, row) {
    const enemyKing = state.pieces.find(p => p.type === T.KING && p.side !== side);
    if (!enemyKing) return false;
    if (enemyKing.col !== col) return false;
    // 计算两将之间(不含两端)的棋子数, 此时己方将已"虚拟移到"目标位置,
    // 故需要排除己方将的原始位置影响: 直接用 pieceAt 统计区间
    return countBetween(col, row, enemyKing.col, enemyKing.row) === 0;
  }

  function advisorMoves(side, col, row) {
    const moves = [];
    // 士/仕只能在己方九宫格内斜走一格, 不能离开九宫
    const deltas = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (const [dc, dr] of deltas) {
      const nc = col + dc, nr = row + dr;
      // 必须仍在己方九宫格内
      if (!inPalace(side, nc, nr)) continue;
      const target = pieceAt(nc, nr);
      if (target && target.side === side) continue;
      moves.push({ col: nc, row: nr });
    }
    return moves;
  }

  function elephantMoves(side, col, row) {
    const moves = [];
    // 相/象走"田"字格 (斜向两格), 不能过河, 且田字中心(象眼)不能有子
    const deltas = [[2, 2], [2, -2], [-2, 2], [-2, -2]];
    for (const [dc, dr] of deltas) {
      const nc = col + dc, nr = row + dr;
      if (!inBoard(nc, nr)) continue;
      // 不能过河: 目标位置必须仍在己方半场
      if (!onOwnSide(side, nr)) continue;
      // 蹩象眼: 田字中心(用整数中点)不能有子
      const eyeCol = col + dc / 2;
      const eyeRow = row + dr / 2;
      if (pieceAt(eyeCol, eyeRow)) continue;
      const target = pieceAt(nc, nr);
      if (target && target.side === side) continue;
      moves.push({ col: nc, row: nr });
    }
    return moves;
  }

  function horseMoves(col, row) {
    const moves = [];
    // [dc, dr, 蹩腿位置 dc, dr]
    const candidates = [
      [1, 2, 0, 1], [-1, 2, 0, 1],
      [1, -2, 0, -1], [-1, -2, 0, -1],
      [2, 1, 1, 0], [2, -1, 1, 0],
      [-2, 1, -1, 0], [-2, -1, -1, 0],
    ];
    for (const [dc, dr, lc, lr] of candidates) {
      const nc = col + dc, nr = row + dr;
      if (!inBoard(nc, nr)) continue;
      if (pieceAt(col + lc, row + lr)) continue; // 蹩马腿
      const target = pieceAt(nc, nr);
      if (target && target.side === pieceAt(col, row).side) continue;
      moves.push({ col: nc, row: nr });
    }
    return moves;
  }

  function rookMoves(col, row) {
    const moves = [];
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const self = pieceAt(col, row);
    for (const [dc, dr] of dirs) {
      let c = col + dc, r = row + dr;
      while (inBoard(c, r)) {
        const target = pieceAt(c, r);
        if (!target) {
          moves.push({ col: c, row: r });
        } else {
          if (target.side !== self.side) moves.push({ col: c, row: r });
          break;
        }
        c += dc; r += dr;
      }
    }
    return moves;
  }

  function cannonMoves(col, row) {
    const moves = [];
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const self = pieceAt(col, row);
    for (const [dc, dr] of dirs) {
      let c = col + dc, r = row + dr;
      // 阶段1: 移动(无子)
      while (inBoard(c, r) && !pieceAt(c, r)) {
        moves.push({ col: c, row: r });
        c += dc; r += dr;
      }
      // 阶段2: 越过炮架吃子
      if (inBoard(c, r)) {
        c += dc; r += dr;
        while (inBoard(c, r)) {
          const target = pieceAt(c, r);
          if (target) {
            if (target.side !== self.side) moves.push({ col: c, row: r });
            break;
          }
          c += dc; r += dr;
        }
      }
    }
    return moves;
  }

  function pawnMoves(side, col, row) {
    const moves = [];
    // 兵/卒:
    //   - 未过河: 只能向前走一格 (不能后退, 不能左右)
    //   - 过河后: 只能向前或左右走一格 (仍不能后退)
    // 红方在下方 (row 大), 向前 = row 减小; 黑方在上方 (row 小), 向前 = row 增大
    const forward = side === RED ? -1 : 1;
    const crossed = side === RED ? row <= 4 : row >= 5; // 是否已过河进入对方半场

    // 1) 向前一格 (始终允许, 只要不出界且不撞己方棋子)
    const fr = row + forward;
    if (inBoard(col, fr)) {
      const t = pieceAt(col, fr);
      if (!t || t.side !== side) moves.push({ col, row: fr });
    }

    // 2) 过河后可左右走一格 (注意: 这里只允许左右, 不允许后退, 故 row 不变)
    if (crossed) {
      for (const dc of [-1, 1]) {
        const nc = col + dc;
        if (!inBoard(nc, row)) continue;
        const t = pieceAt(nc, row);
        if (!t || t.side !== side) moves.push({ col: nc, row });
      }
    }
    return moves;
  }

  // ---------- 走子合法性(过滤送将) ----------
  // 走子后己方将不能被对方吃, 否则非法
  function isLegalMove(piece, toCol, toRow) {
    const fromCol = piece.col, fromRow = piece.row;
    const captured = pieceAt(toCol, toRow);

    // 模拟走子
    if (captured) {
      const idx = state.pieces.indexOf(captured);
      state.pieces.splice(idx, 1);
    }
    piece.col = toCol; piece.row = toRow;

    const safe = !isKingInCheck(piece.side);

    // 还原
    piece.col = fromCol; piece.row = fromRow;
    if (captured) state.pieces.push(captured);

    return safe;
  }

  function getLegalMoves(piece) {
    return getMoves(piece).filter(m => isLegalMove(piece, m.col, m.row));
  }

  // 判断 side 的将是否被将军
  function isKingInCheck(side) {
    const king = state.pieces.find(p => p.type === T.KING && p.side === side);
    if (!king) return true;
    for (const p of state.pieces) {
      if (p.side === side) continue;
      const ms = getMoves(p);
      if (ms.some(m => m.col === king.col && m.row === king.row)) return true;
    }
    return false;
  }

  // =========================================================
  // AI 对手 (执黑方)
  // 策略: Minimax + Alpha-Beta 剪枝, 局部局面评估
  // 评估 = 我方子力价值 + 位置加分 - 对方子力价值 + 将军奖励
  // 为避免阻塞 UI, 用 setTimeout 异步触发
  // =========================================================

  // 棋子基础价值 (黑/红对称, 取绝对值)
  const PIECE_VALUE = {
    [T.KING]: 10000,
    [T.ROOK]: 600,
    [T.CANNON]: 350,
    [T.HORSE]: 300,
    [T.ADVISOR]: 200,
    [T.ELEPHANT]: 200,
    [T.PAWN]: 100,
  };

  // 兵/卒过河后的位置奖励表 (按 col 0..8, row 0..9)
  // 红兵越靠近黑方底线(row 越小)价值越高; 黑卒对称
  // 这里用一个简化的位置表: 兵卒过河前进有奖励
  function pawnBonus(side, col, row) {
    if (side === RED) {
      // 红兵: 未过河 row=6/7 奖励低, 过河后越往前(row 越小)越高
      if (row <= 4) return 50 + (4 - row) * 20; // 过河后每前进一步 +20
      return 0;
    } else {
      // 黑卒: 过河后越往前(row 越大)越高
      if (row >= 5) return 50 + (row - 5) * 20;
      return 0;
    }
  }

  // 车马炮的简易位置奖励: 靠近中线 + 出动奖励
  function positionBonus(piece) {
    const { type, side, col, row } = piece;
    // 中线奖励 (col 接近 4)
    const centerBonus = (4 - Math.abs(col - 4)) * 2;
    if (type === T.PAWN) return pawnBonus(side, col, row) + centerBonus;
    if (type === T.ROOK || type === T.CANNON) {
      // 出动奖励: 不在初始行
      const onBackRank = side === RED ? row === 9 : row === 0;
      return centerBonus + (onBackRank ? 0 : 8);
    }
    if (type === T.HORSE) {
      const onBackRank = side === RED ? row === 9 : row === 0;
      return centerBonus + (onBackRank ? 0 : 5);
    }
    return centerBonus;
  }

  // 局面评估: 从 side 视角, 返回正值表示 side 占优
  function evaluate(side) {
    let score = 0;
    for (const p of state.pieces) {
      const v = PIECE_VALUE[p.type] + positionBonus(p);
      if (p.side === side) score += v;
      else score -= v;
    }
    // 缺将判负
    const myKing = state.pieces.some(p => p.type === T.KING && p.side === side);
    const enemyKing = state.pieces.some(p => p.type === T.KING && p.side !== side);
    if (!myKing) return -100000;
    if (!enemyKing) return 100000;
    // 将军奖励: 若对方被将军, 加分
    if (isKingInCheck(side === RED ? BLACK : RED)) score += 80;
    if (isKingInCheck(side)) score -= 80;
    return score;
  }

  // 生成某一方所有合法走法 [{piece, toCol, toRow}]
  function generateMoves(side) {
    const moves = [];
    for (const p of state.pieces) {
      if (p.side !== side) continue;
      const ms = getLegalMoves(p);
      for (const m of ms) moves.push({ piece: p, toCol: m.col, toRow: m.row });
    }
    return moves;
  }

  // 在 state 上执行/撤销一个走法 (轻量, 不走 history 栈, 用于 AI 搜索)
  function applyMove(piece, toCol, toRow) {
    const captured = pieceAt(toCol, toRow);
    const fromCol = piece.col, fromRow = piece.row;
    if (captured) {
      const idx = state.pieces.indexOf(captured);
      state.pieces.splice(idx, 1);
    }
    piece.col = toCol; piece.row = toRow;
    return { piece, fromCol, fromRow, toCol, toRow, captured };
  }

  function revertMove(rec) {
    rec.piece.col = rec.fromCol;
    rec.piece.row = rec.fromRow;
    if (rec.captured) state.pieces.push(rec.captured);
  }

  // Minimax + Alpha-Beta
  // depth: 剩余搜索深度; maximizingSide: 当前轮到的方
  // 返回 { score, move } 从 aiSide 视角的分数
  function minimax(depth, alpha, beta, maximizingSide, aiSide) {
    if (depth === 0 || state.winner) {
      return { score: evaluate(aiSide), move: null };
    }
    const moves = generateMoves(maximizingSide);
    if (moves.length === 0) {
      // 无路可走视为劣势
      return { score: maximizingSide === aiSide ? -90000 : 90000, move: null };
    }
    // 简易走法排序: 优先吃子走法, 提升剪枝效率
    moves.sort((a, b) => {
      const va = pieceAt(a.toCol, a.toRow) ? PIECE_VALUE[pieceAt(a.toCol, a.toRow).type] : 0;
      const vb = pieceAt(b.toCol, b.toRow) ? PIECE_VALUE[pieceAt(b.toCol, b.toRow).type] : 0;
      return vb - va;
    });

    let bestMove = moves[0];
    if (maximizingSide === aiSide) {
      let best = -Infinity;
      for (const mv of moves) {
        const rec = applyMove(mv.piece, mv.toCol, mv.toRow);
        // 检查是否吃将
        const won = !state.pieces.some(p => p.type === T.KING && p.side !== maximizingSide);
        const res = won ? { score: 100000 + depth, move: mv } : minimax(depth - 1, alpha, beta, maximizingSide === RED ? BLACK : RED, aiSide);
        revertMove(rec);
        if (res.score > best) { best = res.score; bestMove = mv; }
        if (best > alpha) alpha = best;
        if (beta <= alpha) break;
      }
      return { score: best, move: bestMove };
    } else {
      let best = Infinity;
      for (const mv of moves) {
        const rec = applyMove(mv.piece, mv.toCol, mv.toRow);
        const won = !state.pieces.some(p => p.type === T.KING && p.side !== maximizingSide);
        const res = won ? { score: -100000 - depth, move: mv } : minimax(depth - 1, alpha, beta, maximizingSide === RED ? BLACK : RED, aiSide);
        revertMove(rec);
        if (res.score < best) { best = res.score; bestMove = mv; }
        if (best < beta) beta = best;
        if (beta <= alpha) break;
      }
      return { score: best, move: bestMove };
    }
  }

  // AI 思考入口: 返回最佳走法, 含少量随机性避免每局完全相同
  function aiThink() {
    const aiSide = BLACK;
    const depth = 3;
    const moves = generateMoves(aiSide);
    if (moves.length === 0) return null;
    // 找到所有最高分走法, 从中随机选一 (top-k 池池)
    const scored = [];
    let alpha = -Infinity, beta = Infinity;
    for (const mv of moves) {
      const rec = applyMove(mv.piece, mv.toCol, mv.toRow);
      const won = !state.pieces.some(p => p.type === T.KING && p.side !== aiSide);
      const res = won ? { score: 100000 } : minimax(depth - 1, alpha, beta, aiSide === RED ? BLACK : RED, aiSide);
      revertMove(rec);
      scored.push({ move: mv, score: res.score });
      if (res.score > alpha) alpha = res.score;
    }
    scored.sort((a, b) => b.score - a.score);
    // top-3 内随机 (如果分数接近)
    const topScore = scored[0].score;
    const pool = scored.filter(s => s.score >= topScore - 15);
    const pick = pool[Math.floor(Math.random() * pool.length)];
    return pick.move;
  }

  // ---------- 走子 ----------
  function makeMove(piece, toCol, toRow) {
    const captured = pieceAt(toCol, toRow);
    const record = {
      pieceRef: piece,
      fromCol: piece.col,
      fromRow: piece.row,
      toCol,
      toRow,
      captured,
      side: state.turn,
    };
    if (captured) {
      const idx = state.pieces.indexOf(captured);
      state.pieces.splice(idx, 1);
      if (captured.type === T.KING) {
        state.winner = state.turn;
      }
    }
    piece.col = toCol; piece.row = toRow;
    state.history.push(record);
    // 记录走法供 AI 上下文
    state.moveHistory.push({ fromCol: record.fromCol, fromRow: record.fromRow, toCol, toRow, side: record.side });
    logger.info('move', {
      side: record.side,
      piece: piece.type,
      from: [record.fromCol, record.fromRow],
      to: [toCol, toRow],
      captured: captured ? { type: captured.type, side: captured.side } : null,
    });
    if (state.winner) {
      logger.info('win', { winner: state.winner });
    }
    state.turn = state.turn === RED ? BLACK : RED;
  }

  function undo() {
    if (state.history.length === 0) return false;
    const last = state.history.pop();
    last.pieceRef.col = last.fromCol;
    last.pieceRef.row = last.fromRow;
    if (last.captured) state.pieces.push(last.captured);
    state.turn = last.side;
    state.winner = null;
    // 同步移除走法记录
    state.moveHistory.pop();
    logger.info('undo', { remaining: state.history.length, restored_side: last.side });
    return true;
  }

  function restart() {
    state.pieces = createInitialPieces();
    state.turn = RED;
    state.selected = null;
    state.legalMoves = [];
    state.history = [];
    state.moveHistory = [];
    state.winner = null;
    state.aiThinking = false;
    state.aiToken++;           // 作废正在排队的 AI 回调
    aiThinkingEl.hidden = true;
    logger.info('restart', { red: state.redPlayer, black: state.blackPlayer });
    draw();
    updateStatus();
    // 重启后若红方是 AI, 自动开始
    if (state.redPlayer !== 'human') {
      setTimeout(maybeAITurn, 300);
    }
  }

  // ---------- 渲染 ----------
  function draw() {
    const { width, height, cell, padding } = layout;
    ctx.clearRect(0, 0, width, height);

    // 背景
    ctx.fillStyle = '#f0c987';
    ctx.fillRect(0, 0, width, height);

    // 网格线
    ctx.strokeStyle = '#5b3a1a';
    ctx.lineWidth = 1.2;
    // 横线 (10条)
    for (let r = 0; r < ROWS; r++) {
      const y = padding + r * cell;
      ctx.beginPath();
      ctx.moveTo(padding, y);
      ctx.lineTo(padding + cell * 8, y);
      ctx.stroke();
    }
    // 竖线 (9条) - 中间被楚河汉界断开
    for (let c = 0; c < COLS; c++) {
      const x = padding + c * cell;
      if (c === 0 || c === COLS - 1) {
        // 边线连通
        ctx.beginPath();
        ctx.moveTo(x, padding);
        ctx.lineTo(x, padding + cell * 9);
        ctx.stroke();
      } else {
        // 中间断开
        ctx.beginPath();
        ctx.moveTo(x, padding);
        ctx.lineTo(x, padding + cell * 4);
        ctx.moveTo(x, padding + cell * 5);
        ctx.lineTo(x, padding + cell * 9);
        ctx.stroke();
      }
    }

    // 九宫格斜线
    drawPalaceCross(RED);
    drawPalaceCross(BLACK);

    // 楚河汉界
    ctx.fillStyle = '#6b4423';
    ctx.font = `${Math.round(cell * 0.55)}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const midY = padding + cell * 4.5;
    ctx.fillText('楚 河', padding + cell * 2, midY);
    ctx.fillText('汉 界', padding + cell * 6, midY);

    // 炮位 / 兵位 的小十字标记
    drawPositionMarks();

    // 选中标记 + 合法走法
    if (state.selected) {
      const { x, y } = cellToPixel(state.selected.col, state.selected.row);
      ctx.strokeStyle = 'rgba(247, 202, 75, 0.95)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(x, y, layout.pieceRadius + 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const m of state.legalMoves) {
      const { x, y } = cellToPixel(m.col, m.row);
      const target = pieceAt(m.col, m.row);
      if (target) {
        // 可吃子: 红圈
        ctx.strokeStyle = 'rgba(54, 179, 126, 0.95)';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(x, y, layout.pieceRadius + 4, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = 'rgba(54, 179, 126, 0.6)';
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 棋子
    for (const p of state.pieces) drawPiece(p);
  }

  function drawPalaceCross(side) {
    const rows = side === RED ? [7, 9] : [0, 2];
    const cols = [3, 5];
    ctx.strokeStyle = '#5b3a1a';
    ctx.lineWidth = 1.2;
    // 左上-右下
    const a = cellToPixel(cols[0], rows[0]);
    const b = cellToPixel(cols[1], rows[1]);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    // 右上-左下
    const c = cellToPixel(cols[1], rows[0]);
    const d = cellToPixel(cols[0], rows[1]);
    ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.stroke();
  }

  function drawPositionMarks() {
    // 标记炮位和兵位的小十字
    const marks = [
      // 黑炮
      { col: 1, row: 2 }, { col: 7, row: 2 },
      // 红炮
      { col: 1, row: 7 }, { col: 7, row: 7 },
      // 黑卒
      { col: 0, row: 3 }, { col: 2, row: 3 }, { col: 4, row: 3 }, { col: 6, row: 3 }, { col: 8, row: 3 },
      // 红兵
      { col: 0, row: 6 }, { col: 2, row: 6 }, { col: 4, row: 6 }, { col: 6, row: 6 }, { col: 8, row: 6 },
    ];
    ctx.strokeStyle = '#5b3a1a';
    ctx.lineWidth = 1;
    const len = layout.cell * 0.12;
    const gap = layout.cell * 0.08;
    for (const m of marks) {
      const { x, y } = cellToPixel(m.col, m.row);
      // 四个角的小十字
      const corners = [
        [-1, -1], [1, -1], [-1, 1], [1, 1],
      ];
      for (const [sx, sy] of corners) {
        // 跳过靠边的位置(避免画出界)
        if (m.col === 0 && sx < 0) continue;
        if (m.col === COLS - 1 && sx > 0) continue;
        ctx.beginPath();
        ctx.moveTo(x + sx * gap, y + sy * gap);
        ctx.lineTo(x + sx * (gap + len), y + sy * gap);
        ctx.moveTo(x + sx * gap, y + sy * gap);
        ctx.lineTo(x + sx * gap, y + sy * (gap + len));
        ctx.stroke();
      }
    }
  }

  function drawPiece(p) {
    const { x, y } = cellToPixel(p.col, p.row);
    const r = layout.pieceRadius;
    const isRed = p.side === RED;

    // 棋子背景
    const grad = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.2, x, y, r);
    grad.addColorStop(0, '#fff8e7');
    grad.addColorStop(1, '#e6c98f');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    // 外圈
    ctx.strokeStyle = isRed ? '#a8201f' : '#1f1f1f';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 内圈
    ctx.strokeStyle = isRed ? 'rgba(168, 32, 31, 0.5)' : 'rgba(31, 31, 31, 0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.82, 0, Math.PI * 2);
    ctx.stroke();

    // 文字
    ctx.fillStyle = isRed ? '#d63031' : '#1f1f1f';
    ctx.font = `bold ${Math.round(r * 1.05)}px "PingFang SC", "Microsoft YaHei", serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(TEXT[p.side][p.type], x, y + 1);
  }

  // ---------- 交互 ----------
  // 判断当前回合的玩家是否为 AI (内置或 API)
  function currentPlayerIsAI() {
    const player = state.turn === RED ? state.redPlayer : state.blackPlayer;
    return player !== 'human';
  }

  function handleTap(col, row) {
    if (state.winner) return;
    // AI 回合不允许人类点击
    if (currentPlayerIsAI()) return;
    if (state.aiThinking) return;
    const target = pieceAt(col, row);

    if (state.selected) {
      // 已选中: 尝试走到目标
      const move = state.legalMoves.find(m => m.col === col && m.row === row);
      if (move) {
        makeMove(state.selected, col, row);
        state.selected = null;
        state.legalMoves = [];
        draw();
        updateStatus();
        maybeAITurn();
        return;
      }
      // 点到自家其它棋子: 切换选中
      if (target && target.side === state.turn) {
        selectPiece(target);
        return;
      }
      // 其它情况: 取消选中
      logger.info('deselect', { from: [state.selected.col, state.selected.row], click: [col, row] });
      state.selected = null;
      state.legalMoves = [];
      draw();
      return;
    }

    // 未选中
    if (target && target.side === state.turn) {
      selectPiece(target);
    } else if (target) {
      logger.warn('select_wrong_side', { clicked_side: target.side, turn: state.turn });
    }
  }

  // 若当前回合是 AI, 异步触发 AI 走子
  // 用 aiToken 世代号: restart/undo 等会递增 token, 使过期的 AI 回调自动失效
  function maybeAITurn() {
    if (state.winner) return;
    if (!currentPlayerIsAI()) return;
    state.aiThinking = true;
    aiThinkingEl.hidden = false;
    const token = state.aiToken;
    const player = state.turn === RED ? state.redPlayer : state.blackPlayer;
    const side = state.turn;
    // AI vs AI 时给一点延迟, 方便观察
    const delay = (state.redPlayer !== 'human' && state.blackPlayer !== 'human') ? 600 : 50;
    setTimeout(async () => {
      // 若期间发生了 restart/undo, 此回调作废
      if (token !== state.aiToken) return;
      try {
        let mv = null;
        if (player === 'builtin') {
          // 内置 minimax AI
          mv = aiThink();
        } else {
          // API AI
          mv = await apiThink(player, side);
        }
        if (mv) {
          const piece = mv.piece || pieceAt(mv.fromCol, mv.fromRow);
          if (piece) {
            const fromCol = piece.col, fromRow = piece.row;
            makeMove(piece, mv.toCol, mv.toRow);
            logger.info('ai_move', {
              player: player,
              side: side,
              piece: piece.type,
              from: [fromCol, fromRow],
              to: [mv.toCol, mv.toRow],
            });
          }
        }
      } catch (e) {
        logger.error('ai_think_failed', { player: player }, e);
      } finally {
        state.aiThinking = false;
        aiThinkingEl.hidden = true;
        draw();
        updateStatus();
        // AI vs AI: 若对方也是 AI 且游戏未结束, 连锁触发
        if (!state.winner && currentPlayerIsAI()) {
          maybeAITurn();
        }
      }
    }, delay);
  }

  // API AI 思考: 返回 { piece, toCol, toRow } 或 { fromCol, fromRow, toCol, toRow }
  async function apiThink(configId, side) {
    if (!window.APIAIPlayer) throw new Error('ai-api.js 未加载');
    const player = new APIAIPlayer(configId);
    // 生成当前方所有合法走法 [{fromCol,fromRow,toCol,toRow}]
    const allMoves = [];
    for (const p of state.pieces) {
      if (p.side !== side) continue;
      const ms = getLegalMoves(p);
      for (const m of ms) allMoves.push({ fromCol: p.col, fromRow: p.row, toCol: m.col, toRow: m.row });
    }
    if (allMoves.length === 0) return null;
    const move = await player.getMove(state.pieces, allMoves, side, state.moveHistory);
    if (!move) return null;
    const piece = pieceAt(move.fromCol, move.fromRow);
    return { piece, toCol: move.toCol, toRow: move.toRow };
  }

  function selectPiece(piece) {
    state.selected = piece;
    state.legalMoves = getLegalMoves(piece);
    logger.info('select', {
      side: piece.side, piece: piece.type,
      col: piece.col, row: piece.row,
      legal: state.legalMoves.length,
    });
    draw();
  }

  function updateStatus() {
    if (state.winner) {
      statusEl.textContent = `${state.winner === RED ? '红方' : '黑方'}胜!`;
      statusEl.style.color = '#f6c453';
      return;
    }
    const sideText = state.turn === RED ? '红方' : '黑方';
    const player = state.turn === RED ? state.redPlayer : state.blackPlayer;
    if (state.aiThinking) {
      const aiName = player === 'builtin' ? '内置AI' : (window.AIConfig?.get(player)?.name || 'AI');
      statusEl.textContent = `${aiName}(${sideText})思考中…`;
      statusEl.style.color = '#f6c453';
      return;
    }
    if (isKingInCheck(state.turn)) {
      statusEl.textContent = `${sideText}被将军, 请应将!`;
      statusEl.style.color = '#ff6b6b';
      logger.warn('check', { side: state.turn });
    } else {
      const who = player === 'human' ? sideText : (player === 'builtin' ? '内置AI' : (window.AIConfig?.get(player)?.name || 'AI'));
      statusEl.textContent = `${who}走棋`;
      statusEl.style.color = '#f4e9d8';
    }
  }

  // 事件: 同时支持 touch 与 click
  function onPointer(e) {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const point = e.touches ? e.touches[0] : e;
    const x = (point.clientX - rect.left) * (layout.width / rect.width);
    const y = (point.clientY - rect.top) * (layout.height / rect.height);
    const cell = pixelToCell(x, y);
    if (cell) handleTap(cell.col, cell.row);
  }

  canvas.addEventListener('click', onPointer, { passive: false });
  canvas.addEventListener('touchstart', onPointer, { passive: false });

  btnUndo.addEventListener('click', () => {
    if (state.winner) return;
    if (state.aiThinking) return;
    // 若对方是 AI, 连悔两步 (AI + 当前), 回到可操作状态
    undo();
    const nextPlayer = state.turn === RED ? state.redPlayer : state.blackPlayer;
    const prevPlayer = state.turn === RED ? state.blackPlayer : state.redPlayer;
    if (prevPlayer !== 'human' && nextPlayer === 'human' && state.history.length > 0) {
      undo();
    }
    state.aiToken++;           // 作废可能正在排队的 AI 回调
    state.selected = null;
    state.legalMoves = [];
    draw();
    updateStatus();
  });

  btnRestart.addEventListener('click', restart);

  btnFlip.addEventListener('click', () => {
    if (state.aiThinking) return;
    state.flipped = !state.flipped;
    state.selected = null;
    state.legalMoves = [];
    logger.info('flip', { flipped: state.flipped });
    draw();
  });

  // ---------- AI 设置面板 ----------
  function refreshPlayerSelects() {
    const configs = window.AIConfig ? AIConfig.list() : [];
    const opts = ['<option value="human">人类</option>', '<option value="builtin">内置AI</option>'];
    for (const c of configs) {
      opts.push(`<option value="${c.id}">${c.name}</option>`);
    }
    const html = opts.join('');
    selectRed.innerHTML = html;
    selectBlack.innerHTML = html;
    selectRed.value = state.redPlayer;
    selectBlack.value = state.blackPlayer;
  }

  function refreshAIList() {
    const configs = window.AIConfig ? AIConfig.list() : [];
    if (configs.length === 0) {
      aiListEl.innerHTML = '<p class="modal__empty">暂无 AI 配置，请在上方添加。</p>';
      return;
    }
    aiListEl.innerHTML = configs.map(c => `
      <div class="modal__ai-item">
        <div class="modal__ai-info">
          <div class="modal__ai-name">${c.name}</div>
          <div class="modal__ai-meta">${c.model} · ${c.baseUrl}</div>
        </div>
        <button class="modal__ai-del" data-id="${c.id}" type="button">删除</button>
      </div>
    `).join('');
  }

  function openSettings() {
    refreshPlayerSelects();
    refreshAIList();
    settingsOverlay.hidden = false;
  }

  function closeSettings() {
    settingsOverlay.hidden = true;
  }

  btnSettings.addEventListener('click', openSettings);
  btnCloseSettings.addEventListener('click', closeSettings);
  settingsOverlay.addEventListener('click', (e) => {
    if (e.target === settingsOverlay) closeSettings();
  });

  selectRed.addEventListener('change', () => {
    state.redPlayer = selectRed.value;
    state.aiToken++;
    logger.info('player_change', { side: 'r', player: state.redPlayer });
    state.selected = null;
    state.legalMoves = [];
    draw();
    updateStatus();
    if (state.turn === RED && state.redPlayer !== 'human' && !state.winner) {
      maybeAITurn();
    }
  });

  selectBlack.addEventListener('change', () => {
    state.blackPlayer = selectBlack.value;
    state.aiToken++;
    logger.info('player_change', { side: 'b', player: state.blackPlayer });
    state.selected = null;
    state.legalMoves = [];
    draw();
    updateStatus();
    if (state.turn === BLACK && state.blackPlayer !== 'human' && !state.winner) {
      maybeAITurn();
    }
  });

  btnAddAI.addEventListener('click', () => {
    const name = cfgName.value.trim();
    const baseUrl = cfgBaseUrl.value.trim();
    const apiKey = cfgApiKey.value.trim();
    const model = cfgModel.value.trim();
    if (!name || !baseUrl || !apiKey || !model) {
      alert('请填写所有字段');
      return;
    }
    const item = AIConfig.add({ name, baseUrl, apiKey, model });
    logger.info('ai_add', { id: item.id, name, model });
    cfgName.value = '';
    cfgBaseUrl.value = '';
    cfgApiKey.value = '';
    cfgModel.value = '';
    refreshAIList();
    refreshPlayerSelects();
  });

  aiListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.modal__ai-del');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    AIConfig.remove(id);
    logger.info('ai_remove', { id });
    // 若当前选中的玩家被删除, 回退到 human
    if (state.redPlayer === id) state.redPlayer = 'human';
    if (state.blackPlayer === id) state.blackPlayer = 'human';
    refreshAIList();
    refreshPlayerSelects();
    draw();
    updateStatus();
  });

  window.addEventListener('resize', () => {
    computeLayout();
    draw();
  });

  // ---------- 启动 ----------
  try {
    computeLayout();
    draw();
    updateStatus();
    logger.info('game_start', {
      pieces: state.pieces.length,
      flipped: state.flipped,
      red: state.redPlayer,
      black: state.blackPlayer,
    });
  } catch (e) {
    logger.error('init_failed', null, e);
  }
})();
