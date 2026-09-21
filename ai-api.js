/**
 * AI API 接入系统
 *
 * 功能:
 * 1. 管理 AI 配置 (localStorage 持久化): 名称 / baseUrl / apiKey / model
 * 2. 通过 /ai-proxy 端点转发到 OpenAI 兼容的 chat/completions 接口
 * 3. 棋盘序列化: 将局面转为 LLM 可读的文本描述
 * 4. 走法解析: 从 LLM 回复中提取走法
 *
 * 用法:
 *   AIConfig.list()              → 获取所有已保存的 AI 配置
 *   AIConfig.add({...})          → 新增配置, 返回 id
 *   AIConfig.remove(id)          → 删除配置
 *   AIConfig.get(id)             → 获取单个配置
 *
 *   const player = new APIAIPlayer(configId);
 *   const move = await player.getMove(pieces, legalMoves, side);
 *   // move = { fromCol, fromRow, toCol, toRow } | null
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'xiangqi_ai_configs';

  // ---------- API 密钥加密 ----------
  // 简易 XOR + Base64 加密 (防止 localStorage 直接明文泄露)
  // 注意: 纯前端无法做到真正安全, 这里仅作为基础混淆层
  const ENC_KEY = 'xiangqi-v1-enc-key-2026';
  function xorCipher(text, key) {
    let out = '';
    for (let i = 0; i < text.length; i++) {
      out += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return out;
  }
  function encrypt(plain) {
    try { return btoa(unescape(encodeURIComponent(xorCipher(plain, ENC_KEY)))); }
    catch (_) { return plain; }
  }
  function decrypt(cipher) {
    try { return xorCipher(decodeURIComponent(escape(atob(cipher))), ENC_KEY); }
    catch (_) { return cipher; }
  }

  // 棋子中文名 (用于 prompt)
  const PIECE_CN = {
    k: '将', a: '士', e: '象', h: '马', r: '车', c: '炮', p: '卒',
  };
  // 红方对应的中文名
  const PIECE_CN_RED = {
    k: '帅', a: '仕', e: '相', h: '马', r: '车', c: '炮', p: '兵',
  };

  // =====================================================
  // 配置管理
  // =====================================================
  const AIConfig = {
    list() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : [];
      } catch (e) {
        console.error('[AIConfig] list failed:', e);
        return [];
      }
    },

    add(cfg) {
      const list = AIConfig.list();
      const item = {
        id: 'ai_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        name: (cfg.name || '未命名AI').trim(),
        baseUrl: (cfg.baseUrl || 'https://api.openai.com/v1').trim(),
        apiKey: encrypt((cfg.apiKey || '').trim()),  // 加密存储
        model: (cfg.model || 'gpt-4o-mini').trim(),
      };
      list.push(item);
      AIConfig._save(list);
      return item;
    },

    update(id, patch) {
      const list = AIConfig.list();
      const idx = list.findIndex(c => c.id === id);
      if (idx < 0) return null;
      Object.assign(list[idx], patch);
      AIConfig._save(list);
      return list[idx];
    },

    remove(id) {
      const list = AIConfig.list().filter(c => c.id !== id);
      AIConfig._save(list);
    },

    get(id) {
      const c = AIConfig.list().find(c => c.id === id) || null;
      if (c) c.apiKey = decrypt(c.apiKey);  // 返回时解密
      return c;
    },

    _save(list) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
      } catch (e) {
        console.error('[AIConfig] save failed:', e);
      }
    },
  };

  // =====================================================
  // 棋盘序列化 (生成给 LLM 的文本)
  // =====================================================

  // 将棋子列表转为文本棋盘
  // pieces: [{ side, type, col, row }]  side: 'r'|'b', type: 'k'|'a'|...
  function serializeBoard(pieces) {
    // 10 行 x 9 列的网格
    const grid = [];
    for (let r = 0; r < 10; r++) {
      grid.push(new Array(9).fill('·'));
    }
    for (const p of pieces) {
      const cn = p.side === 'r' ? PIECE_CN_RED[p.type] : PIECE_CN[p.type];
      const prefix = p.side === 'r' ? '红' : '黑';
      grid[p.row][p.col] = prefix + cn;
    }
    const lines = [];
    lines.push('  列: 0  1  2  3  4  5  6  7  8');
    lines.push('     ─────────────────────────');
    for (let r = 0; r < 10; r++) {
      const cells = grid[r].map(c => c.padEnd(2, ' ')).join(' ');
      const label = r === 4 ? '楚河' : r === 5 ? '汉界' : '   ';
      lines.push(`行${r} ${label} ${cells}`);
    }
    return lines.join('\n');
  }

  // 将合法走法列表格式化
  function serializeMoves(legalMoves, side) {
    const sideName = side === 'r' ? '红方' : '黑方';
    if (legalMoves.length === 0) return `${sideName} 无合法走法`;
    const lines = [`${sideName}的合法走法 (格式: 列,行 → 列,行):`];
    legalMoves.forEach((m, i) => {
      lines.push(`  ${i + 1}. (${m.fromCol},${m.fromRow}) → (${m.toCol},${m.toRow})`);
    });
    return lines.join('\n');
  }

  // 构造完整 prompt
  function buildPrompt(pieces, legalMoves, side, moveHistory) {
    const sideName = side === 'r' ? '红方' : '黑方';
    const board = serializeBoard(pieces);
    const moves = serializeMoves(legalMoves, side);
    const historyText = moveHistory && moveHistory.length > 0
      ? '\n历史走法: ' + moveHistory.map(m => `(${m.fromCol},${m.fromRow})→(${m.toCol},${m.toRow})`).join(', ')
      : '';

    return `你是一个中国象棋高手。当前轮到${sideName}走棋。

棋盘说明:
- 行0是黑方底线, 行9是红方底线
- 列0-8从左到右
- 红方棋子: 红帅/红仕/红相/红马/红车/红炮/红兵
- 黑方棋子: 黑将/黑士/黑象/黑马/黑车/黑炮/黑卒

当前棋盘:
${board}

${moves}${historyText}

请从上述合法走法中选择一步, 只回复走法编号或坐标, 格式为 "(列,行)→(列,行)", 例如 "(1,7)→(1,6)"。
只回复这一行, 不要回复其他内容。`;
  }

  // =====================================================
  // 走法解析 (从 LLM 回复中提取)
  // =====================================================
  function parseMove(text, legalMoves) {
    if (!text) return null;
    // 尝试匹配 "(1,7)→(1,6)" 或 "(1,7)-(1,6)" 或 "1,7->1,6" 等格式
    const patterns = [
      /\(?\s*(\d+)\s*,\s*(\d+)\s*\)?\s*[→\-→>]+\s*\(?\s*(\d+)\s*,\s*(\d+)\s*\)?/,
      /\(?\s*(\d+)\s*,\s*(\d+)\s*\)?\s*到\s*\(?\s*(\d+)\s*,\s*(\d+)\s*\)?/,
    ];
    for (const pat of patterns) {
      const m = text.match(pat);
      if (m) {
        const fc = parseInt(m[1]), fr = parseInt(m[2]);
        const tc = parseInt(m[3]), tr = parseInt(m[4]);
        // 在合法走法中查找匹配
        const found = legalMoves.find(mv =>
          mv.fromCol === fc && mv.fromRow === fr && mv.toCol === tc && mv.toRow === tr);
        if (found) return found;
      }
    }
    // 尝试匹配编号 (如回复 "3" 表示第3个走法)
    const numMatch = text.match(/^\s*(\d+)\s*$/);
    if (numMatch) {
      const idx = parseInt(numMatch[1]) - 1;
      if (idx >= 0 && idx < legalMoves.length) return legalMoves[idx];
    }
    return null;
  }

  // =====================================================
  // API 调用 (通过 /ai-proxy 转发, 规避 CORS)
  // =====================================================
  // 异常重试: 网络/超时重试 2 次, 429/5xx 退避重试, 4xx 立即失败
  async function callAI(config, messages) {
    const maxRetry = 3;
    let lastErr = null;
    for (let attempt = 1; attempt <= maxRetry; attempt++) {
      try {
        const resp = await fetch('/ai-proxy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            model: config.model,
            messages: messages,
            temperature: 0.7,
            max_tokens: 256,
          }),
        });
        if (!resp.ok) {
          const errText = await resp.text();
          const err = new Error(`proxy HTTP ${resp.status}: ${errText}`);
          err.status = resp.status;
          throw err;
        }
        const result = await resp.json();
        if (!result.ok) {
          const err = new Error(result.error || 'AI proxy returned error');
          err.status = 599;  // 视为服务端错误, 可重试
          throw err;
        }
        // OpenAI 兼容格式: choices[0].message.content
        const content = result.data?.choices?.[0]?.message?.content;
        if (!content) throw new Error('AI response missing content');
        return content.trim();
      } catch (e) {
        lastErr = e;
        const status = e.status || 0;
        // 4xx (除 429 外) 立即失败, 不重试
        if (status >= 400 && status < 500 && status !== 429) {
          throw e;
        }
        // 最后一次失败直接抛出
        if (attempt === maxRetry) {
          e.attempts = attempt;
          throw e;
        }
        // 指数退避: 500ms, 1500ms
        const delay = attempt === 1 ? 500 : 1500;
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw lastErr || new Error('callAI failed');
  }

  // =====================================================
  // APIAIPlayer: 封装一个 API AI 玩家
  // =====================================================
  class APIAIPlayer {
    constructor(configId) {
      this.configId = configId;
      this.config = AIConfig.get(configId);
      if (!this.config) throw new Error('AI config not found: ' + configId);
    }

    /**
     * 请求 AI 选择一步走法
     * @param {Array} pieces  当前棋盘所有棋子
     * @param {Array} legalMoves  合法走法 [{fromCol,fromRow,toCol,toRow}]
     * @param {string} side  'r' 或 'b'
     * @param {Array} moveHistory  历史走法 (可选)
     * @returns {{fromCol,fromRow,toCol,toRow}|null}
     */
    async getMove(pieces, legalMoves, side, moveHistory) {
      if (!legalMoves || legalMoves.length === 0) return null;
      const prompt = buildPrompt(pieces, legalMoves, side, moveHistory);
      const messages = [
        { role: 'system', content: '你是一个中国象棋专家, 擅长下棋并给出合法走法。' },
        { role: 'user', content: prompt },
      ];
      const reply = await callAI(this.config, messages);
      const move = parseMove(reply, legalMoves);
      if (!move) {
        // LLM 给的走法不合法, 回退到随机走法
        console.warn('[APIAIPlayer] 无法解析走法, 随机选择. reply:', reply);
        return legalMoves[Math.floor(Math.random() * legalMoves.length)];
      }
      return move;
    }
  }

  // 暴露到全局
  window.AIConfig = AIConfig;
  window.APIAIPlayer = APIAIPlayer;
  window.__ai_api = { serializeBoard, serializeMoves, buildPrompt, parseMove };
})();
