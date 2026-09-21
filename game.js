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
    mode: 'play',         // 'play' 对战 | 'edit' 编辑
    editSide: RED,        // 编辑模式当前选中的方
    editType: T.KING,     // 编辑模式当前选中的棋子类型
    dragging: null,       // 拖拽中的棋子 { piece, fromCol, fromRow, x, y }
    aiLevel: 3,           // 内置 AI 难度 1-4
    aiSpeed: 1,           // AI 互弈播放倍速: 0.5/1/2/4
    replayPaused: false,  // AI 互弈是否暂停
    replayStep: false,    // AI 互弈单步信号 (一次性 true)
    thinkingProgress: 0,   // AI 思考进度 0-100
    skin: 'classic',      // 棋盘皮肤: classic/wood/jade/ink
    timeLimit: 0,         // 每方限时(秒), 0=不限
    redTime: 0, blackTime: 0,  // 双方剩余时间(秒)
    timerHandle: null,    // 计时器
  };

  // ---------- DOM ----------
  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');
  const statusEl = document.getElementById('status');
  const btnUndo = document.getElementById('btn-undo');
  const btnRestart = document.getElementById('btn-restart');
  const btnFlip = document.getElementById('btn-flip');
  const btn2p = document.getElementById('btn-2p');
  const btnSettings = document.getElementById('btn-settings');
  const aiThinkingEl = document.getElementById('ai-thinking');
  const settingsOverlay = document.getElementById('settings-overlay');
  const btnCloseSettings = document.getElementById('btn-close-settings');
  const selectRed = document.getElementById('select-red');
  const selectBlack = document.getElementById('select-black');
  const selectLevel = document.getElementById('select-level');
  const selectSkin = document.getElementById('select-skin');
  const selectTime = document.getElementById('select-time');
  const btnAddAI = document.getElementById('btn-add-ai');
  const aiListEl = document.getElementById('ai-list');
  const replayBar = document.getElementById('replay-bar');
  const btnReplayPause = document.getElementById('btn-replay-pause');
  const btnReplayStep = document.getElementById('btn-replay-step');
  const replaySpeed = document.getElementById('replay-speed');
  const thinkingProgressEl = document.getElementById('thinking-progress');
  const cfgName = document.getElementById('cfg-name');
  const cfgBaseUrl = document.getElementById('cfg-baseurl');
  const cfgApiKey = document.getElementById('cfg-apikey');
  const cfgModel = document.getElementById('cfg-model');
  const btnEditMode = document.getElementById('btn-edit-mode');
  const editorEl = document.getElementById('editor');
  const editorRedEl = document.getElementById('editor-red');
  const editorBlackEl = document.getElementById('editor-black');
  const editorTipEl = document.getElementById('editor-tip');
  const tipPlayEl = document.getElementById('tip-play');
  const btnEditClear = document.getElementById('btn-edit-clear');
  const btnEditDefault = document.getElementById('btn-edit-default');
  const btnEditStart = document.getElementById('btn-edit-start');

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

  // ---------- 编辑模式: 棋子放置约束 ----------
  // 中国象棋标准开局位置规则:
  //   帅/将: 必须在己方九宫格内 (col 3-5, 红方 row 7-9 / 黑方 row 0-2)
  //   仕/士: 只能在九宫内 5 个位置 (中心 + 四角), 因为士只能斜走,
  //          不能放在 2/4/6/8 这些边中点 (col 3/5 row 边值 或 col 4 row 中值)
  //     红仕: (4,7)(4,8)(4,9)(3,8)(5,8) -> 即中心(4,8)+四角
  //     黑士: (4,0)(4,1)(4,2)(3,1)(5,1) -> 即中心(4,1)+四角
  //   相/象: 必须在本方半场, 且只能放在 7 个固定"田字"落点上
  //     红相落点: (2,9)(2,5)(6,9)(6,5)(0,7)(4,7)(8,7)
  //     黑象落点: (2,0)(2,4)(6,0)(6,4)(0,2)(4,2)(8,2)
  //   其它棋子(马/车/炮/兵/卒): 棋盘任意位置均可
  const ELEPHANT_POINTS = {
    [RED]: [[2, 9], [2, 5], [6, 9], [6, 5], [0, 7], [4, 7], [8, 7]],
    [BLACK]: [[2, 0], [2, 4], [6, 0], [6, 4], [0, 2], [4, 2], [8, 2]],
  };

  // 仕/士的合法落点: 九宫四角（共 4 个）
  // 红方九宫: col 3-5, row 7-9，9 格按行优先编号 1-9：
  //   1(3,7) 2(4,7) 3(5,7)
  //   4(3,8) 5(4,8) 6(5,8)
  //   7(3,9) 8(4,9) 9(5,9)
  // 合法落点: 1/3/7/9 即四角（按用户要求，中心5号位不可放士）
  const ADVISOR_POINTS = {
    [RED]: [[3, 7], [5, 7], [3, 9], [5, 9]],
    [BLACK]: [[3, 0], [5, 0], [3, 2], [5, 2]],
  };

  // 各棋子类型的最大数量（每方）：兵/卒 5 个，车/马/炮 2 个，帅/士/相 1 个
  const PIECE_MAX_COUNT = {
    [T.KING]: 1, [T.ADVISOR]: 2, [T.ELEPHANT]: 2,
    [T.HORSE]: 2, [T.ROOK]: 2, [T.CANNON]: 2, [T.PAWN]: 5,
  };

  // 棋子位置合法性原因（用于编辑模式提示）
  function canPlacePiece(side, type, col, row) {
    if (!inBoard(col, row)) return false;
    if (type === T.KING) return inPalace(side, col, row);
    if (type === T.ADVISOR) {
      return ADVISOR_POINTS[side].some(([c, r]) => c === col && r === row);
    }
    if (type === T.ELEPHANT) {
      return ELEPHANT_POINTS[side].some(([c, r]) => c === col && r === row);
    }
    return true;
  }

  // 校验编辑模式放置：含位置 + 同色多帅 + 同色同类棋子数量上限
  // 返回 { ok: boolean, reason?: string }
  function validateEditPlace(pieces, side, type, col, row) {
    if (pieceAtEx(pieces, col, row)) {
      return { ok: false, reason: '该位置已有棋子，请先移除' };
    }
    if (!canPlacePiece(side, type, col, row)) {
      if (type === T.KING) return { ok: false, reason: '帅/将必须放在己方九宫格内' };
      if (type === T.ADVISOR) return { ok: false, reason: '士/仕只能放在九宫四角及中心（共 5 个落点）' };
      if (type === T.ELEPHANT) return { ok: false, reason: '相/象只能放在本方半场的 7 个田字落点' };
      return { ok: false, reason: '不能放在这里' };
    }
    const sameSideKing = pieces.filter(p => p.side === side && p.type === T.KING);
    if (type === T.KING && sameSideKing.length >= 1) {
      return { ok: false, reason: (side === RED ? '红方' : '黑方') + '已有一个帅/将，不能再放' };
    }
    const sameTypeCount = pieces.filter(p => p.side === side && p.type === type).length;
    const max = PIECE_MAX_COUNT[type];
    if (sameTypeCount >= max) {
      const cnName = side === RED
        ? { k:'帅', a:'仕', e:'相', h:'马', r:'车', c:'炮', p:'兵' }[type]
        : { k:'将', a:'士', e:'象', h:'马', r:'车', c:'炮', p:'卒' }[type];
      return { ok: false, reason: (side === RED ? '红方' : '黑方') + cnName + '最多 ' + max + ' 个（已达上限）' };
    }
    return { ok: true };
  }

  // 在指定棋子集合中按坐标查子（不依赖全局 pieceAt，便于校验时使用临时数组）
  function pieceAtEx(pieces, col, row) {
    return pieces.find(p => p.col === col && p.row === row);
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
  // AI 难度分级: depth 控制搜索深度, randomness 控制随机度
  // level: 1=入门(depth=1, 高随机) 2=初级(depth=2) 3=中级(depth=3, 现行) 4=高级(depth=4, 严格)
  const AI_LEVELS = {
    1: { depth: 1, randomness: 60, label: '入门' },
    2: { depth: 2, randomness: 30, label: '初级' },
    3: { depth: 3, randomness: 15, label: '中级' },
    4: { depth: 4, randomness: 0,  label: '高级' },
  };
  function aiThink() {
    const aiSide = state.turn;  // 按当前回合决定 AI 方
    const levelCfg = AI_LEVELS[state.aiLevel] || AI_LEVELS[3];
    const depth = levelCfg.depth;
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
    // top-k 内随机 (难度越低, 随机池越宽)
    const topScore = scored[0].score;
    const pool = scored.filter(s => s.score >= topScore - levelCfg.randomness);
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
    // 将死/和棋判定: 新回合方若无任何合法走法, 则结束
    if (!state.winner) {
      const hasMove = state.pieces.some(p => p.side === state.turn && getLegalMoves(p).length > 0);
      if (!hasMove) {
        const inCheck = isKingInCheck(state.turn);
        if (inCheck) {
          // 被将军且无路可应 -> 将死, 上一步走子方胜
          state.winner = state.turn === RED ? BLACK : RED;
          logger.info('checkmate', { loser: state.turn, winner: state.winner });
        } else {
          // 未被将军但无路可走 -> 困毙, 和棋
          state.winner = 'draw';
          logger.info('stalemate', { side: state.turn });
        }
      }
    }
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

    // 背景 (按皮肤)
    const SKINS = {
      classic: { bg: '#f0c987', line: '#5b3a1a', red: '#d63031', black: '#1f1f1f', pieceBg1: '#fff8e7', pieceBg2: '#e6c98f' },
      wood:    { bg: '#d4a276', line: '#4a2c0d', red: '#a8201f', black: '#0d0d0d', pieceBg1: '#f5d7a8', pieceBg2: '#c08552' },
      jade:    { bg: '#a8d8b9', line: '#1d3a2c', red: '#c0392b', black: '#1a1a1a', pieceBg1: '#e8f5ec', pieceBg2: '#7ab892' },
      ink:     { bg: '#e8e3d8', line: '#2c2c2c', red: '#8b0000', black: '#000000', pieceBg1: '#f5f2e8', pieceBg2: '#b8b2a3' },
    };
    const skin = SKINS[state.skin] || SKINS.classic;
    state._skin = skin;
    ctx.fillStyle = skin.bg;
    ctx.fillRect(0, 0, width, height);

    // 网格线
    ctx.strokeStyle = skin.line;
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

    // 编辑模式: 高亮当前选中棋子的可放置位置
    if (state.mode === 'edit') {
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          // 编辑模式高亮: 仅显示当前选中棋子还可放置的位置 (位置合法 + 未超数量上限 + 该格无子)
          const placeable = validateEditPlace(state.pieces, state.editSide, state.editType, c, r);
          const hasPiece = !!pieceAt(c, r);
          if (!placeable.ok && !hasPiece) continue;
          const { x, y } = cellToPixel(c, r);
          // 已有棋子位置: 不再高亮放置提示 (避免误导), 仅在选中可移除时显示红虚圈
          if (hasPiece) {
            ctx.strokeStyle = 'rgba(255, 107, 107, 0.8)';
            ctx.lineWidth = 1.8;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.arc(x, y, layout.pieceRadius + 5, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);
          } else {
            // 空位: 绿色实心高亮 (醒目)
            ctx.fillStyle = 'rgba(54, 179, 126, 0.45)';
            ctx.beginPath();
            ctx.arc(x, y, layout.pieceRadius * 0.9, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = 'rgba(54, 179, 126, 1)';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(x, y, layout.pieceRadius * 0.9, 0, Math.PI * 2);
            ctx.stroke();
            // 中心圆点进一步突出
            ctx.fillStyle = 'rgba(54, 179, 126, 1)';
            ctx.beginPath();
            ctx.arc(x, y, layout.pieceRadius * 0.18, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }

    // 棋子 (拖拽中的棋子不画原位, 留到悬浮层绘制)
    for (const p of state.pieces) {
      if (state.dragging && state.dragging.piece === p) continue;
      drawPiece(p);
    }

    // 拖拽中的棋子: 跟随手指/鼠标
    if (state.dragging) {
      const { x, y, piece } = state.dragging;
      // 半透明描影
      ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
      ctx.beginPath();
      ctx.arc(x + 2, y + 3, layout.pieceRadius, 0, Math.PI * 2);
      ctx.fill();
      // 悬浮棋子
      drawPieceAt(piece, x, y);
    }
  }

  function drawPalaceCross(side) {
    const rows = side === RED ? [7, 9] : [0, 2];
    const cols = [3, 5];
    ctx.strokeStyle = (state._skin || {}).line || '#5b3a1a';
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
    drawPieceAt(p, x, y);
  }

  // 在指定像素位置绘制棋子 (拖拽悬浮 + 常规均用)
  function drawPieceAt(p, x, y) {
    const r = layout.pieceRadius;
    const isRed = p.side === RED;
    const skin = state._skin || { red: '#d63031', black: '#1f1f1f', pieceBg1: '#fff8e7', pieceBg2: '#e6c98f' };

    // 棋子背景
    const grad = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.2, x, y, r);
    grad.addColorStop(0, skin.pieceBg1);
    grad.addColorStop(1, skin.pieceBg2);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    // 外圈
    ctx.strokeStyle = isRed ? skin.red : skin.black;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 内圈
    const innerColor = isRed ? skin.red : skin.black;
    ctx.strokeStyle = innerColor;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.82, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // 文字
    ctx.fillStyle = isRed ? skin.red : skin.black;
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
    if (state.mode === 'edit') return handleEditTap(col, row);
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
  // AI vs AI 时: 受 replayPaused/replayStep/aiSpeed 控制
  function maybeAITurn() {
    if (state.winner) return;
    if (!currentPlayerIsAI()) return;
    if (state.aiThinking) return;  // 防止重入

    // AI vs AI 模式: 检查暂停/单步
    const isAiVsAi = state.redPlayer !== 'human' && state.blackPlayer !== 'human';
    if (isAiVsAi) {
      if (state.replayPaused && !state.replayStep) {
        // 暂停中: 等待恢复, 不触发
        return;
      }
      // 单步信号消费后清零
      if (state.replayStep) state.replayStep = false;
    }

    state.aiThinking = true;
    aiThinkingEl.hidden = false;
    state.thinkingProgress = 0;
    if (thinkingProgressEl) thinkingProgressEl.hidden = false;
    const token = state.aiToken;
    const player = state.turn === RED ? state.redPlayer : state.blackPlayer;
    const side = state.turn;
    // AI vs AI: 按倍速算延迟; 人 vs AI: 短延迟
    const baseDelay = isAiVsAi ? Math.round(600 / state.aiSpeed) : 50;
    const thinkDuration = isAiVsAi ? Math.max(200, baseDelay * 0.8) : 300;

    // 思考进度动画 (60ms 步进)
    let progressTimer = setInterval(() => {
      if (token !== state.aiToken) { clearInterval(progressTimer); return; }
      state.thinkingProgress = Math.min(95, state.thinkingProgress + (100 / (thinkDuration / 60)));
      updateThinkingProgress();
    }, 60);

    setTimeout(async () => {
      clearInterval(progressTimer);
      // 若期间发生了 restart/undo, 此回调作废
      if (token !== state.aiToken) return;
      try {
        let mv = null;
        if (player === 'builtin') {
          // 内置 minimax AI
          mv = aiThink();
        } else {
          // API AI (callAI 内部含异常重试)
          mv = await apiThink(player, side);
        }
        if (mv) {
          const piece = mv.piece || pieceAt(mv.fromCol, mv.fromRow);
          if (piece) {
            const fromCol = piece.col, fromRow = piece.row;
            const captured = pieceAt(mv.toCol, mv.toRow);
            makeMove(piece, mv.toCol, mv.toRow);
            // 反馈
            if (captured) { playSound('capture'); vibrate([15, 30, 15]); }
            else { playSound('move'); vibrate(10); }
            if (state.winner === 'draw') { playSound('check'); vibrate([50, 50, 50]); }
            else if (state.winner) { playSound('check'); vibrate([50, 50, 50]); }
            else if (isKingInCheck(state.turn)) { playSound('check'); vibrate([30, 30, 30]); }
            logger.info('ai_move', {
              player: player,
              side: side,
              piece: piece.type,
              from: [fromCol, fromRow],
              to: [mv.toCol, mv.toRow],
              level: player === 'builtin' ? state.aiLevel : undefined,
            });
          }
        }
      } catch (e) {
        logger.error('ai_think_failed', { player: player, msg: e.message });
        // API AI 失败兜底: 用内置 AI 替代
        if (player !== 'builtin') {
          logger.warn('ai_fallback_builtin', { player: player });
          try {
            const mv = aiThink();
            if (mv) {
              const piece = mv.piece || pieceAt(mv.fromCol, mv.fromRow);
              if (piece) {
                makeMove(piece, mv.toCol, mv.toRow);
                playSound('move'); vibrate(10);
                logger.info('ai_move', { player: 'fallback', side, piece: piece.type, from: [piece.col, piece.row], to: [mv.toCol, mv.toRow] });
              }
            }
          } catch (e2) {
            logger.error('ai_fallback_failed', { msg: e2.message });
          }
        }
      } finally {
        state.aiThinking = false;
        state.thinkingProgress = 100;
        updateThinkingProgress();
        aiThinkingEl.hidden = true;
        if (thinkingProgressEl) setTimeout(() => { thinkingProgressEl.hidden = true; }, 200);
        draw();
        updateStatus();
        // AI vs AI: 若对方也是 AI 且游戏未结束, 连锁触发
        if (!state.winner && currentPlayerIsAI()) {
          maybeAITurn();
        }
      }
    }, baseDelay);
  }

  function updateThinkingProgress() {
    const bar = document.getElementById('thinking-bar');
    if (bar) bar.style.width = state.thinkingProgress + '%';
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

  // ---------- 移动端反馈: 振动 + 音效 ----------
  // 轻量 WebAudio 走子音效 (无需音频文件)
  let audioCtx = null;
  function getAudio() {
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (_) { audioCtx = null; }
    }
    return audioCtx;
  }
  // type: 'select' | 'move' | 'capture' | 'illegal' | 'check'
  function playSound(type) {
    const ctx = getAudio();
    if (!ctx) return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      // 不同事件用不同频率/波形
      const presets = {
        select:   { freq: 660, type: 'sine',     dur: 0.06, vol: 0.10 },
        move:     { freq: 440, type: 'triangle', dur: 0.08, vol: 0.12 },
        capture:  { freq: 220, type: 'sawtooth',dur: 0.12, vol: 0.15 },
        illegal:  { freq: 180, type: 'square',  dur: 0.15, vol: 0.10 },
        check:    { freq: 880, type: 'sine',    dur: 0.20, vol: 0.15 },
      };
      const p = presets[type] || presets.move;
      osc.type = p.type;
      osc.frequency.value = p.freq;
      gain.gain.value = p.vol;
      gain.gain.setValueAtTime(p.vol, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + p.dur);
      osc.start();
      osc.stop(ctx.currentTime + p.dur);
    } catch (_) {}
  }
  // 触控振动 (仅部分浏览器支持, 失败静默)
  function vibrate(pattern) {
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (_) {}
  }

  // ---------- 拖拽走棋 ----------
  // state.dragging: { piece, fromCol, fromRow, x, y } 或 null
  // touchstart 选中己方棋子 -> 可拖动到合法位置释放
  function getEventPoint(e) {
    const rect = canvas.getBoundingClientRect();
    const point = e.touches ? e.touches[0] : e;
    const x = (point.clientX - rect.left) * (layout.width / rect.width);
    const y = (point.clientY - rect.top) * (layout.height / rect.height);
    return { x, y, clientX: point.clientX, clientY: point.clientY };
  }

  function onPointerDown(e) {
    if (state.mode === 'edit') {
      // 编辑模式仍走点击逻辑
      e.preventDefault();
      const p = getEventPoint(e);
      const cell = pixelToCell(p.x, p.y);
      if (cell) handleEditTap(cell.col, cell.row);
      return;
    }
    if (state.winner || state.aiThinking || currentPlayerIsAI()) return;
    e.preventDefault();
    const p = getEventPoint(e);
    const cell = pixelToCell(p.x, p.y);
    if (!cell) return;
    const target = pieceAt(cell.col, cell.row);
    // 若已选中且点的是合法走法 -> 直接走
    if (state.selected) {
      const move = state.legalMoves.find(m => m.col === cell.col && m.row === cell.row);
      if (move) {
        doMove(state.selected, cell.col, cell.row);
        return;
      }
      // 切换选中
      if (target && target.side === state.turn) {
        selectPiece(target);
        playSound('select'); vibrate(10);
        // 开始拖拽
        state.dragging = { piece: target, fromCol: target.col, fromRow: target.row, x: p.x, y: p.y };
        return;
      }
      // 取消选中
      state.selected = null;
      state.legalMoves = [];
      draw();
      return;
    }
    // 未选中: 选中己方棋子并开始拖拽
    if (target && target.side === state.turn) {
      selectPiece(target);
      playSound('select'); vibrate(10);
      state.dragging = { piece: target, fromCol: target.col, fromRow: target.row, x: p.x, y: p.y };
    } else if (target) {
      playSound('illegal'); vibrate(20);
      logger.warn('select_wrong_side', { clicked_side: target.side, turn: state.turn });
    }
  }

  function onPointerMove(e) {
    if (!state.dragging) return;
    e.preventDefault();
    const p = getEventPoint(e);
    state.dragging.x = p.x;
    state.dragging.y = p.y;
    draw();
  }

  function onPointerUp(e) {
    if (!state.dragging) return;
    e.preventDefault();
    const p = getEventPoint(e);
    const cell = pixelToCell(p.x, p.y);
    const drag = state.dragging;
    state.dragging = null;
    if (!cell) { draw(); return; }
    // 释放位置在合法走法里 -> 走子
    const move = state.legalMoves.find(m => m.col === cell.col && m.row === cell.row);
    if (move) {
      doMove(drag.piece, cell.col, cell.row);
    } else {
      // 释放位置非法: 仅保持选中状态, 不动
      playSound('illegal'); vibrate(20);
      draw();
    }
  }

  // 执行走子 (统一入口, 含反馈)
  function doMove(piece, toCol, toRow) {
    const captured = pieceAt(toCol, toRow);
    makeMove(piece, toCol, toRow);
    state.selected = null;
    state.legalMoves = [];
    if (captured) { playSound('capture'); vibrate([15, 30, 15]); }
    else { playSound('move'); vibrate(10); }
    if (state.winner) { playSound('check'); vibrate([50, 50, 50]); }
    else if (isKingInCheck(state.turn)) { playSound('check'); vibrate([30, 30, 30]); }
    draw();
    updateStatus();
    maybeAITurn();
  }

  // =========================================================
  // 编辑模式 (模拟功能)
  // 在空棋盘上自由放置/移除棋子, 特殊棋子有位置约束
  // =========================================================
  function handleEditTap(col, row) {
    const target = pieceAt(col, row);
    if (target) {
      // 该位置已有棋子: 移除
      const idx = state.pieces.indexOf(target);
      state.pieces.splice(idx, 1);
      logger.info('edit_remove', { side: target.side, type: target.type, col, row });
      draw();
      return;
    }
    // 空位置: 尝试放置当前选中的棋子
    const side = state.editSide, type = state.editType;
    // 全位置合法性校验: 位置 + 同色多帅 + 同色同类棋子数量上限
    const result = validateEditPlace(state.pieces, side, type, col, row);
    if (!result.ok) {
      editorTipEl.textContent = `❌ ${result.reason}`;
      editorTipEl.style.color = '#ff6b6b';
      setTimeout(() => { editorTipEl.textContent = '点棋子选中，再点空格放置；点已有棋子可移除。特殊棋子（帅/士/相）会自动限制可放位置。'; editorTipEl.style.color = ''; }, 1800);
      logger.warn('edit_place_denied', { side, type, col, row, reason: result.reason });
      return;
    }
    state.pieces.push({ side, type, col, row });
    logger.info('edit_place', { side, type, col, row });
    draw();
  }

  // 渲染编辑模式棋子选择条
  function renderEditorChips() {
    const order = [T.KING, T.ADVISOR, T.ELEPHANT, T.HORSE, T.ROOK, T.CANNON, T.PAWN];
    const buildChips = (side, container) => {
      container.innerHTML = '';
      for (const t of order) {
        const chip = document.createElement('div');
        chip.className = `editor__chip editor__chip--${side === RED ? 'red' : 'black'}`;
        if (state.editSide === side && state.editType === t) chip.classList.add('is-selected');
        chip.textContent = TEXT[side][t];
        chip.addEventListener('click', () => {
          state.editSide = side;
          state.editType = t;
          renderEditorChips();
        });
        container.appendChild(chip);
      }
    };
    buildChips(RED, editorRedEl);
    buildChips(BLACK, editorBlackEl);
  }

  function enterEditMode() {
    state.mode = 'edit';
    state.aiToken++;
    state.aiThinking = false;
    aiThinkingEl.hidden = true;
    state.selected = null;
    state.legalMoves = [];
    state.history = [];
    state.moveHistory = [];
    state.winner = null;
    state.turn = RED;
    // 切换 body 类: CSS 自动隐藏所有 [data-play-only] 元素
    document.body.classList.add('is-edit-mode');
    btnEditMode.classList.add('is-active');
    btnEditMode.textContent = '退出编辑';
    editorEl.hidden = false;
    statusEl.textContent = '编辑模式 - 自由布置棋子';
    statusEl.style.color = '#f6c453';
    renderEditorChips();
    draw();
    logger.info('edit_enter', { pieces: state.pieces.length });
  }

  function exitEditMode(startPlay) {
    state.mode = 'play';
    document.body.classList.remove('is-edit-mode');
    btnEditMode.classList.remove('is-active');
    btnEditMode.textContent = '模拟编辑';
    editorEl.hidden = true;
    if (startPlay) {
      // 用当前编辑的局面开始对弈
      state.turn = RED;
      state.selected = null;
      state.legalMoves = [];
      state.history = [];
      state.moveHistory = [];
      state.winner = null;
      logger.info('edit_start_play', { pieces: state.pieces.length });
    }
    draw();
    updateStatus();
  }

  btnEditMode.addEventListener('click', () => {
    if (state.mode === 'play') enterEditMode();
    else exitEditMode(false);
  });

  btnEditClear.addEventListener('click', () => {
    state.pieces = [];
    draw();
    logger.info('edit_clear', {});
  });

  btnEditDefault.addEventListener('click', () => {
    state.pieces = createInitialPieces();
    draw();
    logger.info('edit_default', { pieces: state.pieces.length });
  });

  btnEditStart.addEventListener('click', () => {
    // 必须双方都有帅才能开始
    const hasRedKing = state.pieces.some(p => p.side === RED && p.type === T.KING);
    const hasBlackKing = state.pieces.some(p => p.side === BLACK && p.type === T.KING);
    if (!hasRedKing || !hasBlackKing) {
      editorTipEl.textContent = '❌ 双方必须各有一个帅/将才能开始对弈';
      editorTipEl.style.color = '#ff6b6b';
      setTimeout(() => { editorTipEl.textContent = '点棋子选中，再点空格放置；点已有棋子可移除。特殊棋子（帅/士/相）会自动限制可放位置。'; editorTipEl.style.color = ''; }, 2500);
      return;
    }
    exitEditMode(true);
    // 若红方是 AI, 自动开局
    if (state.redPlayer !== 'human') setTimeout(maybeAITurn, 300);
  });

  function updateStatus() {
    if (state.winner) {
      if (state.winner === 'draw') {
        statusEl.textContent = '和棋!';
        statusEl.style.color = '#f6c453';
      } else {
        statusEl.textContent = `${state.winner === RED ? '红方' : '黑方'}胜!`;
        statusEl.style.color = '#f6c453';
      }
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
    updateScoreBoard();
    updateTimers();
  }

  // 局面评分: 显示双方优劣势 (红方视角, 正=红优)
  function updateScoreBoard() {
    const el = document.getElementById('score-board');
    if (!el) return;
    const score = evaluate(RED);
    const abs = Math.abs(score);
    const prefix = score > 0 ? '红+' : (score < 0 ? '黑+' : '均');
    const text = abs > 50000 ? (score > 0 ? '红方占优' : '黑方占优')
      : `${prefix}${Math.min(9999, abs)}`;
    el.textContent = `局面: ${text}`;
    el.style.color = score > 0 ? '#ff7675' : (score < 0 ? '#dfe6e9' : '#f4e9d8');
  }

  // 限时对弈: 显示双方剩余时间
  function updateTimers() {
    const redEl = document.getElementById('time-red');
    const blackEl = document.getElementById('time-black');
    if (state.timeLimit === 0) {
      if (redEl) redEl.textContent = '';
      if (blackEl) blackEl.textContent = '';
      return;
    }
    if (redEl) redEl.textContent = formatTime(state.redTime);
    if (blackEl) blackEl.textContent = formatTime(state.blackTime);
  }
  function formatTime(sec) {
    if (sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' + s : s}`;
  }
  function startTimer() {
    if (state.timerHandle) clearInterval(state.timerHandle);
    if (state.timeLimit === 0) return;
    state.redTime = state.timeLimit;
    state.blackTime = state.timeLimit;
    state.timerHandle = setInterval(() => {
      if (state.winner) { clearInterval(state.timerHandle); return; }
      if (state.turn === RED) state.redTime -= 1;
      else state.blackTime -= 1;
      // 超时判负
      if (state.redTime <= 0) { state.winner = BLACK; onTimeOut(); }
      else if (state.blackTime <= 0) { state.winner = RED; onTimeOut(); }
      updateTimers();
    }, 1000);
  }
  function onTimeOut() {
    if (state.timerHandle) clearInterval(state.timerHandle);
    playSound('check'); vibrate([50, 50, 50]);
    logger.info('timeout', { winner: state.winner });
    draw();
    updateStatus();
  }

  // 事件: 同时支持触控与鼠标 (含拖拽)
  canvas.addEventListener('mousedown', onPointerDown);
  canvas.addEventListener('mousemove', onPointerMove);
  window.addEventListener('mouseup', onPointerUp);
  canvas.addEventListener('touchstart', onPointerDown, { passive: false });
  canvas.addEventListener('touchmove', onPointerMove, { passive: false });
  canvas.addEventListener('touchend', onPointerUp, { passive: false });
  canvas.addEventListener('touchcancel', onPointerUp, { passive: false });

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

  // AI vs AI 时显示 replay 控制条; 人 vs AI 或双人时隐藏
  function updateReplayBar() {
    const isAiVsAi = state.redPlayer !== 'human' && state.blackPlayer !== 'human';
    if (replayBar) replayBar.hidden = !isAiVsAi;
  }
  function restartWithReplay() {
    restart();
    updateReplayBar();
    if (state.timeLimit > 0) startTimer();
  }

  selectRed.addEventListener('change', () => {
    state.redPlayer = selectRed.value;
    state.aiToken++;
    logger.info('player_change', { side: 'r', player: state.redPlayer });
    state.selected = null;
    state.legalMoves = [];
    updateReplayBar();
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
    updateReplayBar();
    draw();
    updateStatus();
    if (state.turn === BLACK && state.blackPlayer !== 'human' && !state.winner) {
      maybeAITurn();
    }
  });

  // 难度
  selectLevel.addEventListener('change', () => {
    state.aiLevel = parseInt(selectLevel.value, 10) || 3;
    logger.info('ai_level', { level: state.aiLevel });
  });
  // 皮肤
  selectSkin.addEventListener('change', () => {
    state.skin = selectSkin.value;
    logger.info('skin_change', { skin: state.skin });
    draw();
  });
  // 限时
  selectTime.addEventListener('change', () => {
    state.timeLimit = parseInt(selectTime.value, 10) || 0;
    logger.info('time_limit', { limit: state.timeLimit });
    if (state.timeLimit > 0) startTimer();
    else if (state.timerHandle) { clearInterval(state.timerHandle); state.timerHandle = null; }
    updateTimers();
  });

  // AI 互弈控制: 暂停/单步/倍速
  btnReplayPause.addEventListener('click', () => {
    state.replayPaused = !state.replayPaused;
    btnReplayPause.textContent = state.replayPaused ? '继续' : '暂停';
    logger.info('replay_pause', { paused: state.replayPaused });
    if (!state.replayPaused && !state.aiThinking && currentPlayerIsAI() && !state.winner) {
      maybeAITurn();
    }
  });
  btnReplayStep.addEventListener('click', () => {
    state.replayStep = true;
    state.replayPaused = true;
    btnReplayPause.textContent = '继续';
    logger.info('replay_step', {});
    if (!state.aiThinking && currentPlayerIsAI() && !state.winner) {
      maybeAITurn();
    }
  });
  replaySpeed.addEventListener('change', () => {
    state.aiSpeed = parseFloat(replaySpeed.value) || 1;
    logger.info('replay_speed', { speed: state.aiSpeed });
  });

  // 本地双人快捷按钮
  btn2p.addEventListener('click', () => {
    state.redPlayer = 'human';
    state.blackPlayer = 'human';
    selectRed.value = 'human';
    selectBlack.value = 'human';
    state.aiToken++;
    updateReplayBar();
    restart();
    logger.info('mode_2p', {});
  });

  // restart 按钮改为带 replay + timer 处理
  btnRestart.removeEventListener('click', restart);
  btnRestart.addEventListener('click', restartWithReplay);

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
    // 同步设置面板初始值
    if (selectLevel) selectLevel.value = String(state.aiLevel);
    if (selectSkin) selectSkin.value = state.skin;
    if (selectTime) selectTime.value = String(state.timeLimit);
    updateReplayBar();
    draw();
    updateStatus();
    logger.info('game_start', {
      pieces: state.pieces.length,
      flipped: state.flipped,
      red: state.redPlayer,
      black: state.blackPlayer,
      aiLevel: state.aiLevel,
      skin: state.skin,
    });
  } catch (e) {
    logger.error('init_failed', null, e);
  }

  // === 临时调试出口 ===
  window.__xiangqi_debug = {
    canPlacePiece, validateEditPlace, ADVISOR_POINTS, PIECE_MAX_COUNT,
    get state() { return state; },
    get T() { return T; },
  };
  // === /临时调试出口 ===
})();
