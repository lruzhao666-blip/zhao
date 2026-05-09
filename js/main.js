/**
 * main.js — 三国志文字版 v10 (v2.5)
 * 对接规范 v2.0：
 *  - 剧情区 / 数据区分离（36个=号分隔）
 *  - [甲][乙][丙] 含 cities_list（城名+守将）
 *  - [战报] 新格式：甲→宛城NPC | 胜 | 伤亡:攻40守180
 *  - cityOwnership 携带 holder 守将字段供地图渲染
 *  - 兼容旧格式
 */

(function () {
  'use strict';

  const API_BASE = 'https://sanguo.pages.dev/api/tables/sanguo_rounds';
  const POLL_MS  = 30000;
  const MAX_ROWS = 100;

  let state = {
    rounds:        [],
    players:       defaultPlayers(),
    pollTimer:     null,
    lastUpdatedAt: 0,
    publishing:    false,
  };

  function defaultPlayers() {
    return [
      { name:'城主甲', city:'', gold:null, food:null, troop:null, morale:null, cities:null, generals:[], cities_list:[], situation_note:'', suggestions:[] },
      { name:'城主乙', city:'', gold:null, food:null, troop:null, morale:null, cities:null, generals:[], cities_list:[], situation_note:'', suggestions:[] },
      { name:'城主丙', city:'', gold:null, food:null, troop:null, morale:null, cities:null, generals:[], cities_list:[], situation_note:'', suggestions:[] },
    ];
  }

  // ══════════════════════════════════════════
  //  初始化
  // ══════════════════════════════════════════
  function init() {
    bindNav();
    bindGMPanel();
    initParticles();
    loadFromCloud();
  }

  // ══════════════════════════════════════════
  //  云端 API
  // ══════════════════════════════════════════
  // fetch 加超时包装，避免请求无响应时永久卡住
  function fetchWithTimeout(url, options = {}, ms = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return fetch(url, { ...options, signal: controller.signal })
      .finally(() => clearTimeout(timer));
  }

  async function loadFromCloud() {
    updateSyncStatus('loading');
    try {
      await fetchAllRounds();
      renderAll();
      startPolling();
      updateSyncStatus('online');
    } catch (e) {
      console.error('[SG] 加载失败:', e);
      updateSyncStatus('error');
    }
  }

  async function fetchAllRounds() {
    const res  = await fetchWithTimeout(`${API_BASE}?limit=${MAX_ROWS}&sort=round`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const rows = json.data || [];
    state.rounds = rows.map(rowToRound).filter(Boolean);
    state.rounds.sort((a, b) => a.round - b.round);
    rebuildPlayers();
    if (rows.length) {
      state.lastUpdatedAt = Math.max(...rows.map(r => r.updated_at || 0));
    }
  }

  async function pollForUpdates() {
    try {
      const res  = await fetchWithTimeout(`${API_BASE}?limit=1&sort=updated_at`, {}, 6000);
      if (!res.ok) return;
      const json = await res.json();
      const rows = json.data || [];
      const latest = rows.length ? (rows[0].updated_at || 0) : 0;
      if (latest > state.lastUpdatedAt) {
        updateSyncStatus('updating');
        await fetchAllRounds();
        renderAll();
        showToast('🔄 战局已更新！');
        updateSyncStatus('online');
      }
    } catch (e) { /* 静默失败 */ }
  }

  async function publishRound(rd) {
    const payload = {
      round:               rd.round,
      round_title:         '',
      raw_content:         rd.rawContent,
      raw_digest:          rd.parsed.rawDigest      || '',
      digest:              rd.parsed.digest         || '',
      players_json:        JSON.stringify(rd.parsed.players       || []),
      battles_json:        JSON.stringify(rd.parsed.battles       || []),
      changes_json:        JSON.stringify(rd.parsed.changes        || []),
      livelihood_json:     JSON.stringify([]),   // v2.0 已废弃，保留字段兼容旧数据
      city_ownership_json: JSON.stringify(rd.parsed.cityOwnership || {}),
    };
    const existId = await findRoundId(rd.round);
    const url     = existId ? `${API_BASE}/${existId}` : API_BASE;
    const method  = existId ? 'PUT' : 'POST';
    const res = await fetchWithTimeout(url, {
      method, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, 12000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function deleteRoundById(apiId) {
    const res = await fetchWithTimeout(`${API_BASE}/${apiId}`, { method: 'DELETE' }, 8000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  async function findRoundId(roundNum) {
    try {
      const res  = await fetchWithTimeout(`${API_BASE}?limit=${MAX_ROWS}`, {}, 8000);
      const json = await res.json();
      const found = (json.data || []).find(r => r.round === roundNum);
      return found ? found.id : null;
    } catch (e) { return null; }
  }

  async function getAllApiIds() {
    try {
      const res  = await fetchWithTimeout(`${API_BASE}?limit=${MAX_ROWS}`, {}, 8000);
      const json = await res.json();
      return (json.data || []).map(r => ({ id: r.id, round: r.round }));
    } catch (e) { return []; }
  }

  function rowToRound(row) {
    try {
      return {
        round:      row.round,
        roundTitle: row.round_title || '',
        parsed: {
          round:         row.round,
          rawDigest:     row.raw_digest      || row.raw_content || '',
          digest:        row.digest          || '',
          players:       safeJson(row.players_json,          []),
          battles:       safeJson(row.battles_json,          []),
          changes:       safeJson(row.changes_json,          []),
          cityOwnership: safeJson(row.city_ownership_json,  {}),
          // 兼容旧数据
          livelihood:    safeJson(row.livelihood_json,       []),
          situation:     row.situation  || '',
          events:        safeJson(row.events_json, []),
          narration:     row.narration  || '',
        },
        rawContent: row.raw_content || '',
        _apiId:     row.id,
      };
    } catch (e) { return null; }
  }

  function safeJson(str, fallback) {
    try { return str ? JSON.parse(str) : fallback; } catch (e) { return fallback; }
  }

  function startPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(pollForUpdates, POLL_MS);
  }

  // ══════════════════════════════════════════
  //  导航
  // ══════════════════════════════════════════
  function bindNav() {
    document.querySelectorAll('.nav-btn').forEach(btn =>
      btn.addEventListener('click', () => switchTab(btn.dataset.tab))
    );
  }

  function switchTab(name) {
    document.querySelectorAll('.nav-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach(p =>
      p.classList.toggle('active', p.id === `tab-${name}`));
  }

  // ══════════════════════════════════════════
  //  GM 面板
  // ══════════════════════════════════════════
  function bindGMPanel() {
    document.getElementById('btn-preview').addEventListener('click', onPreview);
    document.getElementById('btn-publish').addEventListener('click', onPublish);
    document.getElementById('btn-clear-all').addEventListener('click', onClearAll);
    document.getElementById('btn-undo').addEventListener('click', onUndo);
  }

  function onPreview() {
    const raw = document.getElementById('gm-content').value.trim();
    if (!raw) { showToast('⚠️ 请先粘贴内容'); return; }
    const parsed = SGParser.parse(raw);
    showParsePreview(parsed);
  }

  async function onPublish() {
    if (state.publishing) return;
    const raw = document.getElementById('gm-content').value.trim();
    if (!raw) { showToast('⚠️ 内容不能为空'); return; }

    // 回合号 = 当前最大回合 + 1（自动递增）
    const nextRound = state.rounds.length
      ? state.rounds[state.rounds.length - 1].round + 1
      : 1;

    const parsed = SGParser.parse(raw);
    parsed.round = nextRound;

    state.publishing = true;
    const btn = document.getElementById('btn-publish');
    btn.disabled = true; btn.textContent = '⏳ 发布中…';

    try {
      const rd = { round: nextRound, roundTitle: '', parsed, rawContent: raw };
      await publishRound(rd);
      await fetchAllRounds();
      renderAll();
      switchTab('arena');

      document.getElementById('gm-content').value = '';
      document.getElementById('parse-preview').classList.add('hidden');

      updateUndoBtn();
      showToast(`✅ 第 ${nextRound} 回合已发布！`);
    } catch (e) {
      console.error('[SG] 发布失败:', e);
      showToast('❌ 发布失败，请检查网络');
    } finally {
      state.publishing = false;
      btn.disabled = false; btn.textContent = '🚀 发布回合';
    }
  }

  async function onUndo() {
    if (!state.rounds.length) return;
    const last = state.rounds[state.rounds.length - 1];
    if (!confirm(`确认撤回第 ${last.round} 回合？`)) return;

    const btn = document.getElementById('btn-undo');
    btn.disabled = true; btn.textContent = '⏳ 撤回中…';
    try {
      const apiId = last._apiId || await findRoundId(last.round);
      if (apiId) await deleteRoundById(apiId);
      state.rounds.pop();
      rebuildPlayers();
      renderAll();
      updateUndoBtn();
      showToast(`↩️ 第 ${last.round} 回合已撤回`);
    } catch (e) {
      showToast('❌ 撤回失败，请重试');
    } finally {
      btn.disabled = false;
      updateUndoBtn();
    }
  }

  async function onClearAll() {
    if (!confirm('确认清空所有回合记录？云端数据将一并删除，不可撤销。')) return;
    showToast('⏳ 清空中…');
    try {
      const ids = await getAllApiIds();
      await Promise.all(ids.map(r => fetch(`${API_BASE}/${r.id}`, { method: 'DELETE' })));
      state.rounds = []; state.players = defaultPlayers();
      state.lastUpdatedAt = 0;
      renderAll();
      updateUndoBtn();
      showToast('🗑️ 所有记录已清空');
    } catch (e) { showToast('❌ 清空失败，请重试'); }
  }

  function updateUndoBtn() {
    const btn = document.getElementById('btn-undo');
    if (!btn) return;
    btn.disabled = state.rounds.length === 0;
    btn.textContent = state.rounds.length
      ? `↩️ 撤回第 ${state.rounds[state.rounds.length - 1].round} 回合`
      : '↩️ 撤回上一步';
  }

  // ══════════════════════════════════════════
  //  玩家状态重建
  // ══════════════════════════════════════════
  function rebuildPlayers() {
    state.players = defaultPlayers();
    state.rounds.forEach(rd => mergePlayerState(rd.parsed));
  }

  function mergePlayerState(parsed) {
    // v2.0：players 数组按 slot 顺序排列（甲乙丙 → idx 0/1/2）
    // 兼容旧格式：livelihood 优先（旧数据路径）
    const legacySrc = (parsed.livelihood && parsed.livelihood.length)
      ? parsed.livelihood : null;

    (parsed.players || []).forEach((pp, i) => {
      if (i >= 3) return;
      const sp = state.players[i];

      // 名称
      if (pp.name) sp.name = pp.name;

      // 主城（取第一座城）
      const firstCity = (pp.cities_list && pp.cities_list.length)
        ? pp.cities_list[0].name
        : (pp.city || null);
      if (firstCity) sp.city = firstCity;

      // 资源：v2.0 字段名 food/grain 都接受，troop/soldiers 都接受
      const gold   = pp.gold   ?? null;
      const food   = pp.food   ?? pp.grain    ?? null;
      const troop  = pp.troop  ?? pp.soldiers ?? null;
      const morale = pp.morale ?? null;
      const cities = pp.cities ?? pp.city_count ?? null;

      if (gold   != null) sp.gold   = gold;
      if (food   != null) sp.food   = food;
      if (troop  != null) sp.troop  = troop;
      if (morale != null) sp.morale = morale;
      if (cities != null) sp.cities = cities;

      // 武将
      if (pp.generals && pp.generals.length) sp.generals = pp.generals;

      // cities_list（含守将，供地图使用）
      if (pp.cities_list && pp.cities_list.length) sp.cities_list = pp.cities_list;

      // ownedCities（兼容旧字段）
      if (pp.ownedCities && pp.ownedCities.length) sp.ownedCities = pp.ownedCities;

      if (pp.situation_note) sp.situation_note = pp.situation_note;
      if (pp.suggestions && pp.suggestions.length) sp.suggestions = pp.suggestions;
    });

    // 旧格式：livelihood 补丁（仅补资源，不覆盖武将/城池）
    if (legacySrc) {
      legacySrc.forEach((pp, i) => {
        if (i >= 3) return;
        const sp = state.players[i];
        if (pp.gold   != null) sp.gold   = pp.gold;
        if (pp.food   != null) sp.food   = pp.food;
        if (pp.troop  != null) sp.troop  = pp.troop;
        if (pp.morale != null) sp.morale = pp.morale;
        if (pp.cities != null) sp.cities = pp.cities;
      });
    }
  }

  // ══════════════════════════════════════════
  //  渲染总入口
  // ══════════════════════════════════════════
  function renderAll() {
    const hasData = state.rounds.length > 0;
    const emptyEl = document.getElementById('arena-empty');
    const bodyEl  = document.getElementById('arena-body');
    if (emptyEl) emptyEl.style.display = hasData ? 'none' : '';
    if (bodyEl)  bodyEl.classList.toggle('hidden', !hasData);

    if (hasData) {
      const latest = state.rounds[state.rounds.length - 1];
      renderRoundBar(latest);
      renderDigest(latest);
      renderPlayerCards();
      renderBattlesBlock(latest.parsed.battles || []);
      renderMap();
      renderChangesDetail();
      renderHistorySection();
    }
    updateFooter();
    updateUndoBtn();
  }

  // ── 势力地图 ──
  function renderMap() {
    const latest       = state.rounds.length ? state.rounds[state.rounds.length - 1] : null;
    const latestParsed = latest ? latest.parsed : null;

    let cityMap;
    if (latestParsed && latestParsed.cityOwnership && Object.keys(latestParsed.cityOwnership).length > 0) {
      // v2.0/v2.5：解析器直接给出含 holder + troops 的完整 cityOwnership
      cityMap = {};
      Object.entries(latestParsed.cityOwnership).forEach(([k, ow]) => {
        cityMap[k] = Object.assign({}, ow);
      });
      // 同步最新玩家名（解析时 playerName 可能用 slot 代替真名）
      state.players.forEach((p, i) => {
        Object.values(cityMap).forEach(ow => {
          if (ow.playerIdx === i && p.name) ow.playerName = p.name;
        });
      });
    } else {
      // 旧格式降级
      const latestRaw = latest ? (latest.rawContent || latestParsed?.rawDigest || '') : '';
      cityMap = SGMap.parseCityOwnership(state.players, latestRaw);
    }

    SGMap.update(state.players, cityMap);
    _renderMapLegend(cityMap);
  }

  function _renderMapLegend(cityMap) {
    const el = document.getElementById('sgmap-legend');
    if (!el) return;
    const PC = SGMap.P_COLOR;
    // 用传入的 cityMap（含 DATA 块数据），没有则重新算
    const cm = cityMap || SGMap.parseCityOwnership(state.players, '');
    let html = state.players.map((p, i) => {
      const cnt = Object.values(cm).filter(o => o.playerIdx === i).length;
      return `<span class="sgmap-legend-item">
        <span class="sgmap-legend-dot"
          style="background:${PC[i].stroke};box-shadow:0 0 4px ${PC[i].glow}66"></span>
        <span style="color:${PC[i].glow};font-weight:700">${esc(p.name || '城主' + '甲乙丙'[i])}</span>
        <span style="color:var(--text-dim);font-size:.65rem"> ${cnt}城</span>
      </span>`;
    }).join('');
    const npcCnt = Object.values(cm).filter(o => o.owner === 'npc').length;
    html += `<span class="sgmap-legend-item">
      <span class="sgmap-legend-dot" style="background:#9a7c3e;box-shadow:0 0 4px #c09050"></span>
      <span style="color:#c09050;font-weight:700">NPC</span>
      <span style="color:var(--text-dim);font-size:.65rem"> ${npcCnt}城</span>
    </span>`;
    el.innerHTML = html;
  }

  // ── 回合标题条 ──
  function renderRoundBar(rd) {
    setTxt('rb-num', rd.round);
    const countEl = document.getElementById('rb-round-count');
    if (countEl) countEl.textContent = `共 ${state.rounds.length} 回合`;
  }

  // ══════════════════════════════════════════
  //  战局动态：直接展示原文（rawDigest）
  //  对文本做基础格式化：段落换行、关键词高亮
  // ══════════════════════════════════════════
  function renderDigest(rd) {
    const p      = rd.parsed;
    const block  = document.getElementById('block-digest');
    const body   = document.getElementById('digest-body');
    const tagsEl = document.getElementById('digest-tags');
    if (!block || !body) return;

    // rawDigest 优先，兼容旧数据用 situation + events 拼合
    const rawText = p.rawDigest || buildLegacyDigest(p);
    if (!rawText || !rawText.trim()) {
      block.classList.add('hidden');
      return;
    }
    block.classList.remove('hidden');

    // 标签行：仅显示一个简洁标签
    if (tagsEl) tagsEl.innerHTML = `<span class="digest-tag tag-situation">📋 AI 原文</span>`;

    // 将原文渲染为带高亮的预格式段落
    body.innerHTML = `<div class="digest-raw">${highlightRaw(rawText)}</div>`;


  }

  /**
   * 将原始文本转为带高亮的 HTML（智能排版版）
   *  - 分隔线（═══ / ───）→ 视觉分割
   *  - 一级章节标题（🌍 天下大势 / ⚡ 风云突变 / 📢 主持人语 / 🔥 战斗结算 等）→ 醒目标题
   *  - 玩家行 👤【...】→ 玩家分组锚点
   *  - 列表项（•、-、①②③、1.）→ 列表样式
   *  - 注记行（📍 当前局势：…）→ 注记块
   *  - 普通行 → 段落
   *  - 连续普通文本会被合并到同一段落，便于长段阅读
   */
  /**
   * 预处理：把原文中的「🎯 行动建议」块整体提取，
   * 渲染成 HTML 后用占位符替换，返回 { text, placeholders }
   * 这样后续逐行循环完全不会碰到 ①②③ 行，彻底避免 NUMBULLET_RE 抢先匹配。
   */
  function _preRenderActionBlocks(text) {
    const placeholders = {};
    let pid = 0;

    // 匹配：🎯 行动建议 开头，一直到「空行之后不再是选项/名字/等待行」为止
    // 策略：逐行扫描，遇到 🎯 行动建议 就开始收集，直到遇到真正的终止条件
    const lines = text.split('\n');
    const out = [];
    let i = 0;

    const ICONS = ['①','②','③','④','⑤','⑥'];

    // 判断是否是选项行：① xxx
    const isOpt  = l => /^\s*[①②③④⑤⑥]\s*.+/.test(l);
    // 判断是否是单行格式：「名: ① xxx ② xxx」
    const isSingleLine = l => /^[^:：①②③④⑤⑥\s][^:：]{0,12}[：:]\s*.*[①②③④⑤⑥]/.test(l.trim());
    // 判断是否是纯玩家名行（短、无特殊符号）
    const isPName = l => {
      const t = l.trim();
      return t.length >= 1 && t.length <= 10
        && !/[：:①②③④⑤⑥]/.test(t)
        && !/^[\s\u3000]/.test(t)
        && !/^[📍🔖💡⏳🎯🌍⚡📢🔥📜🎴🌐⚔️🏯🌅🌙•·▪▸▶◆◇■□=─═—]/.test(t);
    };
    // 判断是否是等待行
    const isWait = l => /^⏳/.test(l.trim());
    // GM 标注剥除
    const stripGM = l => l.trim().replace(/^[【\[][^】\]\n]{1,12}[】\]]\s*/, '').trim();

    // 渲染一组 actionLines + waitLine → HTML字符串
    const renderBlock = (actionLines, waitLine) => {
      let ab = '<div class="raw-action-block">';
      ab += '<div class="rab-title">🎯 行动建议</div>';
      if (actionLines.length) {
        ab += '<div class="rab-players">';
        actionLines.forEach(al => {
          ab += '<div class="rab-player-row">';
          ab += `<div class="rab-pname">${esc(al.playerLabel)}</div>`;
          ab += '<div class="rab-opts">';
          al.opts.forEach((opt, oi) => {
            const isCustom = /自定义/.test(opt);
            ab += `<div class="rab-opt${isCustom ? ' rab-opt--custom' : ''}">`
                + `<span class="rab-opt-num">${ICONS[oi]||''}</span>`
                + `<span class="rab-opt-txt">${esc(opt)}</span>`
                + '</div>';
          });
          ab += '</div></div>';
        });
        ab += '</div>';
      }
      if (waitLine) ab += `<div class="rab-wait">${esc(waitLine)}</div>`;
      ab += '</div>';
      return ab;
    };

    while (i < lines.length) {
      const raw = lines[i];
      const stripped = stripGM(raw);

      // 遇到 🎯 行动建议 → 开始收集整块
      if (/^🎯\s*行动建议/.test(stripped)) {
        const actionLines = [];
        let waitLine = '';
        let pendingPlayer = null;
        let pendingOpts   = [];

        const flushP = () => {
          if (pendingPlayer !== null && pendingOpts.length) {
            actionLines.push({ playerLabel: pendingPlayer, opts: pendingOpts });
          }
          pendingPlayer = null;
          pendingOpts   = [];
        };

        i++;
        // 允许跳过行动建议块内部的空行（玩家之间可能有空行）
        // 终止条件：连续2个空行，或遇到非行动相关行
        let emptyCount = 0;
        while (i < lines.length) {
          const r2  = lines[i];
          const s2  = stripGM(r2);

          // ⏳ 等待行：不管前面有多少空行都要捕获进来
          if (isWait(s2)) { flushP(); waitLine = s2; i++; break; }

          if (!s2) {
            emptyCount++;
            // 超过1个连续空行 → 块结束
            if (emptyCount > 1) { flushP(); break; }
            i++; continue;
          }
          emptyCount = 0;

          // 单行格式：「名: ① xxx ② xxx」
          if (isSingleLine(s2)) {
            flushP();
            const cm = s2.match(/^([^:：①②③④⑤⑥\s][^:：]{0,12})[：:]\s*(.+)$/);
            if (cm) {
              const pLabel = cm[1].trim();
              const rest   = cm[2].trim();
              const opts   = [];
              const re     = /[①②③④⑤⑥]\s*([^①②③④⑤⑥]+)/g;
              let m;
              while ((m = re.exec(rest)) !== null) opts.push(m[1].trim().replace(/[,，]+$/, ''));
              actionLines.push({ playerLabel: pLabel, opts });
            }
            i++; continue;
          }

          // 纯选项行：① xxx
          if (isOpt(s2)) {
            const optTxt = s2.trim().replace(/^[①②③④⑤⑥]\s*/, '').replace(/[,，]+$/, '');
            pendingOpts.push(optTxt);
            i++; continue;
          }

          // 纯玩家名行
          if (isPName(s2)) {
            flushP();
            pendingPlayer = s2;
            i++; continue;
          }

          // 其他行 → 块结束
          flushP();
          break;
        }
        flushP();

        // 生成占位符
        const key = `%%ACTION_BLOCK_${pid++}%%`;
        placeholders[key] = renderBlock(actionLines, waitLine);
        out.push(key);
        continue;
      }

      out.push(raw);
      i++;
    }

    return { text: out.join('\n'), placeholders };
  }

  function highlightRaw(rawText) {
    if (!rawText) return '';

    // ── 第一步：预处理，把所有「🎯 行动建议」块整体替换成占位符
    // 这样后续逐行循环完全不会碰到 ①②③ 行，彻底避免 NUMBULLET_RE 抢先匹配
    const { text, placeholders } = _preRenderActionBlocks(rawText);

    const SECTION_RE   = /^(🌍|⚡|📢|🔥|📜|🎴|🌐|⚔️|🏯|🌅|🌙)\s*[【\[]?\s*[\u4e00-\u9fa5]{2,}/;
    const PLAYER_RE    = /^👤\s*[【\[]/;
    const NOTE_RE      = /^[📍🔖💡]/;
    const BATTLE_RE    = /^🎲/;
    const BULLET_RE    = /^[•·▪▸▶◆◇■□]\s+/;
    const NUMBULLET_RE = /^(?:[①②③④⑤⑥⑦⑧⑨⑩]|[1-9]\.|[1-9]、)\s*/;
    // GM 内部标注过滤规则
    const GM_LABEL_PREFIX_RE = /^[【\[][^】\]\n]{1,12}[】\]]\s*/;

    const lines = text.split('\n').map(l => l.replace(/\s+$/, ''));
    const out = [];
    let paraBuf = [];

    const flushPara = () => {
      if (!paraBuf.length) return;
      out.push(`<p class="raw-para">${paraBuf.map(highlight).join('<br>')}</p>`);
      paraBuf = [];
    };

    for (let i = 0; i < lines.length; i++) {
      const t = lines[i];

      // 空行 → 段落分隔
      if (!t.trim()) {
        flushPara();
        continue;
      }

      // 占位符 → 直接输出对应 HTML
      if (t.trim() in placeholders) {
        flushPara();
        out.push(placeholders[t.trim()]);
        continue;
      }

      // GM 内部标注处理
      let tLine = t;
      if (GM_LABEL_PREFIX_RE.test(tLine.trim())) {
        tLine = tLine.trim().replace(GM_LABEL_PREFIX_RE, '').trim();
        if (!tLine) continue;
      }

      // 分隔线
      if (/^[═─=\-—]{4,}/.test(tLine)) {
        flushPara();
        out.push('<div class="raw-divider"></div>');
        continue;
      }

      // 章节标题
      if (SECTION_RE.test(tLine)) {
        flushPara();
        out.push(`<h4 class="raw-section">${highlight(tLine)}</h4>`);
        continue;
      }

      // 玩家行
      if (PLAYER_RE.test(tLine)) {
        flushPara();
        out.push(`<div class="raw-player">${highlight(tLine)}</div>`);
        continue;
      }

      // 战斗骰子行
      if (BATTLE_RE.test(tLine)) {
        flushPara();
        out.push(`<div class="raw-battle">${highlight(tLine)}</div>`);
        continue;
      }

      // ⏳ 等待行（无论是否在 action-block 内都统一渲染）
      if (/^⏳/.test(tLine)) {
        flushPara();
        out.push(`<div class="raw-wait">${highlight(tLine)}</div>`);
        continue;
      }

      // 注记行
      if (NOTE_RE.test(tLine)) {
        flushPara();
        out.push(`<div class="raw-note">${highlight(tLine)}</div>`);
        continue;
      }

      // 列表项
      if (BULLET_RE.test(tLine) || NUMBULLET_RE.test(tLine)) {
        flushPara();
        out.push(`<div class="raw-bullet">${highlight(tLine)}</div>`);
        continue;
      }

      // 普通行 → 累加进当前段落
      paraBuf.push(tLine);
    }
    flushPara();

    return out.join('');
  }

  /** 兼容旧数据（没有 rawDigest）：拼合 situation + events + narration */
  function buildLegacyDigest(p) {
    const parts = [];
    if (p.situation) parts.push(p.situation);
    if (p.events && p.events.length) {
      parts.push('', '⚡ 风云突变');
      p.events.forEach(ev => {
        parts.push(`📜 ${ev.name}`);
        if (ev.effect) parts.push(`影响：${ev.effect}`);
      });
    }
    if (p.narration) parts.push('', '📢 主持人语', p.narration);
    return parts.join('\n');
  }

  // ══════════════════════════════════════════
  //  文本处理（已移除关键词高亮，仅保留转义）
  //  注意：章节标题（raw-section）的高亮样式由 CSS 控制，此处不影响
  // ══════════════════════════════════════════
  function highlight(text) {
    if (!text) return '';
    return esc(text);
  }

  // ══════════════════════════════════════════
  //  战斗结算
  // ══════════════════════════════════════════
  function renderBattlesBlock(battles) {
    const block = document.getElementById('block-battles');
    const list  = document.getElementById('battles-list');
    if (!block || !list) return;
    if (!battles || !battles.length) { block.classList.add('hidden'); return; }
    block.classList.remove('hidden');
    list.innerHTML = '<div class="battle-list">' +
      battles.map(b => buildBattleCard(b)).join('') +
      '</div>';
  }

  function buildBattleCard(b) {
    // 兼容 v2.0（attacker/defender/result/attacker_loss/defender_loss）
    // 和旧格式（player/dice/resultTxt/narrative/success）
    const isV2    = b.attacker !== undefined;
    const success = isV2 ? b.result === '胜' : (b.success ?? true);
    const isDraw  = isV2 && b.result === '平';
    const cls     = success ? 'success' : (isDraw ? 'draw' : 'fail');
    const resultLabel = isV2
      ? ({ '胜':'胜利', '平':'平局', '负':'失败' }[b.result] || b.result)
      : (success ? '成功' : '失败');
    const resultIcon = success ? '⚔️ 胜' : (isDraw ? '🔶 平' : '💀 败');

    if (isV2) {
      // ── v2.0 重构卡片 ──
      const atkLoss = b.attacker_loss ?? 0;
      const defLoss = b.defender_loss ?? 0;
      return `<div class="battle-card ${cls}">
        <div class="bc-sides">
          <div class="bc-side bc-atk">
            <span class="bc-role">攻方</span>
            <span class="bc-name">${esc(b.attacker)}</span>
            ${atkLoss > 0 ? `<span class="bc-loss loss-atk">-${atkLoss}</span>` : ''}
          </div>
          <div class="bc-center">
            <span class="bc-result-badge ${cls}">${resultIcon}</span>
          </div>
          <div class="bc-side bc-def">
            <span class="bc-role">守方</span>
            <span class="bc-name">${esc(b.defender)}</span>
            ${defLoss > 0 ? `<span class="bc-loss loss-def">-${defLoss}</span>` : ''}
          </div>
        </div>
      </div>`;
    } else {
      // ── 旧格式兼容 ──
      const icon = success ? '✅' : '❌';
      let html = `<div class="battle-card ${cls}">
        <div class="bc-legacy">
          ${b.player ? `<span class="bc-name">${esc(b.player)}</span>` : ''}
          <span class="bc-result-badge ${cls}">${icon} ${resultLabel}</span>
          ${b.dice ? `<span class="bc-dice">🎲 ${esc(b.dice)}</span>` : ''}
        </div>`;
      const desc = b.resultTxt || b.narrative || '';
      if (desc) html += `<div class="bc-desc">${esc(desc.slice(0, 100))}</div>`;
      html += `</div>`;
      return html;
    }
  }

  // ══════════════════════════════════════════
  //  玩家势力卡 + 行动选项
  // ══════════════════════════════════════════
  function renderPlayerCards() {
    const latestPlayers = state.rounds.length
      ? (state.rounds[state.rounds.length - 1].parsed.players || [])
      : [];

    state.players.forEach((p, i) => {
      setTxt(`pname-${i}`, p.name || `城主${['甲','乙','丙'][i]}`);

      const cityEl = document.getElementById(`pcity-${i}`);
      if (cityEl) {
        cityEl.textContent   = p.city || '';
        cityEl.style.display = p.city ? '' : 'none';
      }

      setTxt(`pgold-${i}`,   p.gold   != null ? p.gold   : '—');
      setTxt(`pfood-${i}`,   p.food   != null ? p.food   : '—');
      setTxt(`ptroop-${i}`,  p.troop  != null ? p.troop  : '—');
      setTxt(`pmorale-${i}`, p.morale != null ? p.morale : '—');
      setTxt(`pcities-${i}`, p.cities != null ? p.cities : '—');

      const bar = document.getElementById(`mbar-${i}`);
      if (bar) {
        const pct = Math.max(0, Math.min(100, p.morale ?? 60));
        bar.style.width   = `${pct}%`;
        bar.style.opacity = pct < 40 ? '.65' : pct > 80 ? '1' : '.85';
      }

      const badgeEl = document.getElementById(`pc-badges-${i}`);
      if (badgeEl) {
        const m = p.morale;
        let bhtml = '';
        if (m != null) {
          if (m <= 0)       bhtml = `<span class="status-badge sb-danger">⚠️ 叛乱风险</span>`;
          else if (m < 40)  bhtml = `<span class="status-badge sb-warn">❗ 民心低落</span>`;
          else if (m >= 80) bhtml = `<span class="status-badge sb-alive">✨ 万民拥戴</span>`;
        }
        badgeEl.innerHTML = bhtml;
      }

      renderGenList(i, p.generals);

      const noteEl = document.getElementById(`pc-note-${i}`);
      if (noteEl) {
        if (p.situation_note && p.situation_note.trim()) {
          noteEl.textContent = '📍 ' + p.situation_note;
          noteEl.classList.remove('hidden');
        } else {
          noteEl.classList.add('hidden');
        }
      }

    });
  }

  function renderGenList(idx, generals) {
    const listEl = document.getElementById(`gen-list-${idx}`);
    if (!listEl) return;
    if (!generals || !generals.length) {
      listEl.innerHTML = '<span class="gen-empty">——</span>';
      return;
    }
    listEl.innerHTML = generals.map(g => buildGenTag(g)).join('');
  }

  // ── 武将状态颜色（按钮颜色完全由状态决定，不区分稀有度）
  var GEN_STATUS_STYLES = {
    healthy:{ bg:'rgba(0,50,0,.30)',    bd:'rgba(0,160,70,.45)',   c:'#7ddd7d',  bc:'rgba(0,160,70,.22)'  },
    tired:  { bg:'rgba(70,50,0,.30)',   bd:'rgba(200,155,0,.45)',  c:'#d4b040',  bc:'rgba(200,155,0,.18)' },
    injured:{ bg:'rgba(70,0,0,.30)',    bd:'rgba(200,40,0,.45)',   c:'#e07070',  bc:'rgba(200,40,0,.18)'  },
    sick:   { bg:'rgba(42,0,60,.30)',   bd:'rgba(150,0,190,.45)',  c:'#cc80ee',  bc:'rgba(150,0,190,.18)' },
    dead:   { bg:'rgba(18,18,18,.42)',  bd:'rgba(60,60,60,.35)',   c:'#686868',  bc:'rgba(60,60,60,.15)'  }
  };

  function genStatusKey(s) {
    if (!s) return 'healthy';
    if (/疲劳|疲/.test(s))    return 'tired';
    if (/受伤|伤/.test(s))    return 'injured';
    if (/患病|病/.test(s))    return 'sick';
    if (/阵亡|亡|死/.test(s)) return 'dead';
    return 'healthy';
  }

  function buildGenTag(g) {
    var statusKey = genStatusKey(g.status);
    var sc        = GEN_STATUS_STYLES[statusKey] || GEN_STATUS_STYLES.healthy;
    var isDead    = statusKey === 'dead';

    // tooltip 悬停提示
    var titleTip = esc(g.name) + ' · ' + esc(g.status || '健康');

    // ── 容器样式（完全由状态色决定）──
    var wrapStyle = 'display:inline-flex!important;align-items:center!important;'
      + 'border-radius:5px;padding:2px 8px 2px 7px;'
      + 'font-size:.74rem;font-family:inherit;transition:transform .15s;cursor:default;'
      + 'border:1px solid ' + sc.bd + '!important;'
      + 'background:' + sc.bg + '!important;'
      + (isDead ? 'text-decoration:line-through;opacity:.5;' : '');

    var nameStyle = 'font-weight:700;color:' + sc.c + '!important;letter-spacing:.02em;';

    var divStyle = 'display:inline-block;width:1px;height:.9em;margin:0 5px;'
      + 'background:' + sc.bd + ';flex-shrink:0;opacity:.6;';

    var statusStyle = 'font-size:.6rem;color:' + sc.c + '!important;opacity:.85;white-space:nowrap;';

    // 状态文字映射
    var STATUS_SHORT = { healthy:'健康', tired:'疲劳', injured:'受伤', sick:'患病', dead:'阵亡' };
    var statusShort = STATUS_SHORT[statusKey] || (g.status || '健康');

    // 结构：[名字] | [状态]
    return '<span class="gen-tag" data-status="' + statusKey
      + '" style="' + wrapStyle + '" title="' + titleTip + '">'
      + '<span style="' + nameStyle + '">' + esc(g.name) + '</span>'
      + '<span style="' + divStyle + '"></span>'
      + '<span style="' + statusStyle + '">' + esc(statusShort) + '</span>'
      + '</span>';
  }



  // ══════════════════════════════════════════
  //  📊 本回合收支详情  v2.0
  //  三栏玩家卡 + 底部 NPC 天下动态全景
  // ══════════════════════════════════════════
  function renderChangesDetail() {
    const el = document.getElementById('block-changes-detail');
    if (!el) return;

    const latest = state.rounds.length ? state.rounds[state.rounds.length - 1] : null;
    if (!latest) { el.classList.add('hidden'); return; }

    // ── 从 rawContent 实时重解析（保证使用最新解析器逻辑）──
    let changes = latest.parsed.changes || [];
    if (latest.rawContent) {
      try {
        const fp = window.SGParser.parse(latest.rawContent);
        if (fp.changes && fp.changes.length) changes = fp.changes;
      } catch(e) {}
    }

    if (!changes.length) { el.classList.add('hidden'); return; }

    el.classList.remove('hidden');

    const sub = document.getElementById('changes-detail-sub');
    if (sub) sub.textContent = `第 ${latest.round} 回合`;

    const row = document.getElementById('changes-cards-row');
    if (!row) return;

    // ── 配置 & 工具函数 ──
    const SLOT_CFG = [
      { slot:'甲', idx:0 },
      { slot:'乙', idx:1 },
      { slot:'丙', idx:2 },
    ];
    const RES_ICON = { 金:'💰', 粮:'🌾', 兵:'🛡️', 民心:'❤️' };
    const sign   = v => v > 0 ? '+' : '';
    const valCls = v => v < 0 ? 'neg' : v > 0 ? 'pos' : 'zero';

    // ── 资源 pills 固定顺序：金→粮→兵→民心 ──
    const RES_ORDER = ['金', '粮', '兵', '民心'];

    // ── 1. 资源总变化行 ──
    const renderRes = (res) => {
      if (!res || !Object.keys(res).length) return '';
      const pills = RES_ORDER.filter(k => k in res).map(k => {
        const v = res[k];
        return `<span class="cd-res-pill">
          <span class="pill-icon">${RES_ICON[k]||''}</span>
          <span class="pill-name">${k}</span>
          <span class="pill-val ${valCls(v)}">${sign(v)}${v}</span>
        </span>`;
      }).join('');
      if (!pills) return '';
      return `<div class="cd-res-row">${pills}</div>`;
    };

    // ── 2. 收支明细表（分项顺序固定）──
    // 每个资源内部分项顺序：产出→维护→季度→明账→府库→贸易→事件→其他
    const BD_ITEM_ORDER = ['产出','维护','季度','明账','府库','贸易','事件'];
    const sortBdItems = (items) => {
      const indexed = items.map(it => {
        const idx = BD_ITEM_ORDER.indexOf(it.label);
        return { it, idx: idx === -1 ? 999 : idx };
      });
      indexed.sort((a, b) => a.idx - b.idx);
      return indexed.map(x => x.it);
    };

    // troopChanges → 按城名聚合为 Map，供「兵」行内嵌使用
    const buildTroopMap = (troopChanges) => {
      const m = {};
      for (const tc of (troopChanges || [])) {
        m[tc.cityName] = tc.entries || [];
      }
      return m;
    };

    const renderBreakdown = (bd, troopChanges) => {
      if (!bd) return '';
      const cats = RES_ORDER.filter(k => k in bd);
      if (!cats.length) return '';
      // 兵种变动数据：按城聚合
      const troopMap = buildTroopMap(troopChanges);
      const hasTroops = Object.keys(troopMap).length > 0;

      // 若 breakdown 没有「兵」但有 troopChanges，补一个虚拟「兵」行
      const allCats = [...cats];
      if (hasTroops && !allCats.includes('兵')) allCats.push('兵');

      const rows = allCats.map(cat => {
        const d = bd[cat] || { items: [], total: null };
        if ((!d.items || !d.items.length) && (d.total === 0 || d.total === null)) {
          // 「兵」行即使 breakdown 为空，只要有 troopChanges 也要渲染
          if (cat !== '兵' || !hasTroops) return '';
        }
        const chips = sortBdItems(d.items || []).map(it =>
          `<span class="bd-chip">
            <span class="bd-chip-lbl">${esc(it.label)}</span>
            <span class="bd-chip-val ${valCls(it.val)}">${sign(it.val)}${it.val}</span>
          </span>`
        ).join('');
        const tc = d.total != null ? valCls(d.total) : '';
        const tv = d.total != null ? `<span class="bd-total ${tc}">${sign(d.total)}${d.total}</span>` : '';

        // 「兵」行：在 chips 后追加兵种细项（套 bd-troop-block 二级展开）
        let troopHtml = '';
        if (cat === '兵' && hasTroops) {
          const troopRows = Object.entries(troopMap).map(([city, entries]) => {
            const typeChips = entries.map(e =>
              `<span class="troop-chip ${valCls(e.val)}">${e.type}${sign(e.val)}${e.val}</span>`
            ).join('');
            return `<div class="bd-troop-row">
              <span class="bd-troop-city">${esc(city)}</span>
              <span class="bd-troop-chips">${typeChips}</span>
            </div>`;
          }).join('');
          troopHtml = `<div class="bd-troop-block">${troopRows}</div>`;
        }

        return `<tr class="cd-bd-tr${cat === '兵' && hasTroops ? ' cd-bd-tr--troop' : ''}">
          <td class="cd-bd-cat">${RES_ICON[cat]||''}${cat}</td>
          <td class="cd-bd-items">${chips}${troopHtml}</td>
          <td class="cd-bd-total-cell">${tv}</td>
        </tr>`;
      }).filter(Boolean).join('');

      if (!rows) return '';
      return `<div class="cd-section">
        <div class="cd-sec-label">收支明细</div>
        <table class="cd-bd-table"><tbody>${rows}</tbody></table>
      </div>`;
    };

    // ── 3. 季度结算 ──
    const renderSeasonal = (seasonal) => {
      if (!seasonal) return '';
      if (typeof seasonal === 'string') {
        return `<div class="cd-section">
          <div class="cd-sec-label">季度结算</div>
          <div class="cd-season-row"><span style="font-size:.74rem;color:var(--text-sub)">${esc(seasonal)}</span></div>
        </div>`;
      }
      if (!Array.isArray(seasonal) || !seasonal.length) return '';
      const chips = seasonal.map(s =>
        `<span class="season-chip">
          <span class="sc-icon">${RES_ICON[s.res]||''}</span>
          <span class="sc-name">${s.res}</span>
          <span class="sc-val ${valCls(s.val)}">${sign(s.val)}${s.val}</span>
        </span>`
      ).join('');
      return `<div class="cd-section">
        <div class="cd-sec-label">季度结算</div>
        <div class="cd-season-row">${chips}</div>
      </div>`;
    };

    // ── 4. 府库调度 ──
    const renderDark = (darkItems) => {
      if (!darkItems || !darkItems.length) return '';
      const rows = darkItems.map(d => {
        if (typeof d === 'string') {
          return `<div class="dark-item">
            <span class="dark-icon">🕳</span>
            <span class="dark-desc">${esc(d.slice(0,8))}</span>
          </div>`;
        }
        // desc 截断至 8 字，数字右对齐
        const shortDesc = d.desc ? d.desc.slice(0,8) : '';
        const resHtml = (d.entries || []).map(e =>
          `<span class="dark-chip ${valCls(e.val)}">${RES_ICON[e.res]||''}${e.res}${sign(e.val)}${e.val}</span>`
        ).join('');
        return `<div class="dark-item">
          <span class="dark-icon">🕳</span>
          <span class="dark-desc">${esc(shortDesc)}</span>
          <span class="dark-res-wrap">${resHtml}</span>
        </div>`;
      }).join('');
      return `<div class="cd-section cd-section--dark">
        <div class="cd-sec-label">府库调度</div>
        ${rows}
      </div>`;
    };

    // ── 5. 兵种变动（与其他 section 同调，不加特殊高亮）──
    const renderTroops = (troopChanges) => {
      if (!troopChanges || !troopChanges.length) return '';
      const sections = troopChanges.map(tc => {
        const chips = (tc.entries && tc.entries.length)
          ? tc.entries.map(e =>
              `<span class="troop-chip ${valCls(e.val)}">${e.type}${sign(e.val)}${e.val}</span>`
            ).join('')
          : `<span class="troop-chip zero">${esc(tc.spec)}</span>`;
        // 标题：「兵种变动」左侧标签 + 城名右跟
        return `<div class="cd-section">
          <div class="cd-sec-label">兵种变动 <span class="troop-city-tag">${esc(tc.cityName)}</span></div>
          <div class="troop-chips-row">${chips}</div>
        </div>`;
      }).join('');
      return sections;
    };

    // ── 6. 情报（拆两栏：战报回响 / 麾下动态）──
    // NPC状态△ 开头的条目属于天下动态，不渲染在情报卡内
    const BATTLE_KW  = /攻|守|战|胜|败|退|围|破|伐|夺|援|突|击|袭|劫|降|灭/;
    const GENERAL_KW = /武将|将|健康|疲劳|受伤|患病|阵亡|征|招募|招降|离/;
    const NPC_KW     = /^NPC状态△|^NPC\s*[^\s]+状态△|^野外△/;
    const renderIntel = (intel) => {
      if (!intel || !intel.length) return '';
      const battleItems  = [];
      const generalItems = [];
      const otherItems   = [];
      for (const s of intel) {
        if (NPC_KW.test(s))           continue;          // ★ NPC事件跳过，不进情报卡
        if (BATTLE_KW.test(s))        battleItems.push(s);
        else if (GENERAL_KW.test(s))  generalItems.push(s);
        else                          otherItems.push(s);
      }
      // 「其他」归入麾下动态
      const genAll = [...generalItems, ...otherItems];
      const makeLi = arr => arr.map(s => `<li class="intel-item">${esc(s)}</li>`).join('');
      const colBattle  = battleItems.length
        ? `<div class="intel-col">
            <div class="intel-col-hd">⚔️ 战报回响</div>
            <ul class="intel-list">${makeLi(battleItems)}</ul>
           </div>` : '';
      const colGeneral = genAll.length
        ? `<div class="intel-col">
            <div class="intel-col-hd">🎖️ 麾下动态</div>
            <ul class="intel-list">${makeLi(genAll)}</ul>
           </div>` : '';
      if (!colBattle && !colGeneral) return '';
      return `<div class="cd-section cd-section--intel">
        <div class="cd-sec-label">情报动向</div>
        <div class="intel-cols">${colBattle}${colGeneral}</div>
      </div>`;
    };

    // ── 三栏卡片 ──
    const cardsHtml = SLOT_CFG.map(cfg => {
      const ch    = changes.find(c => c.slot === cfg.slot);
      const pName = (state.players[cfg.idx] && state.players[cfg.idx].name) || `城主${cfg.slot}`;
      const ci    = cfg.idx;

      if (!ch) {
        return `<div class="cd-card cd-card-${ci}">
          <div class="cd-header cd-header-${ci}">
            <div class="cd-strip cd-strip-${ci}"></div>
            <span class="cd-name">${esc(pName)}</span>
          </div>
          <p class="cd-empty">本回合无变动记录</p>
        </div>`;
      }

      // ── 收支校验警告 ──
      const warningsHtml = (ch.warnings && ch.warnings.length)
        ? `<div class="cd-section cd-section--warn">
            <div class="cd-sec-label">⚠ 数据校验</div>
            ${ch.warnings.map(w => `<div class="cd-warn-item">${esc(w)}</div>`).join('')}
           </div>`
        : '';

      return `<div class="cd-card cd-card-${ci}">
        <div class="cd-header cd-header-${ci}">
          <div class="cd-strip cd-strip-${ci}"></div>
          <span class="cd-name">${esc(pName)}</span>
        </div>
        ${renderRes(ch.resources)}
        ${renderBreakdown(ch.breakdown)}
        ${renderSeasonal(ch.seasonal)}
        ${renderDark(ch.darkItems)}
        ${renderIntel(ch.intel)}
        ${warningsHtml}
      </div>`;
    }).join('');

    // ── NPC 天下动态 ──
    const npcEvents = changes.__npc || [];
    // ── NPC 天下动态（旧格式）──
    let npcHtml = '';
    if (npcEvents.length) {
      const npcItems = npcEvents.map(ev => {
        const icon = ev.type === 'wild' ? '🌿' : '🏯';
        return `<div class="npc-event-item">
          <span class="npc-city">${icon} ${esc(ev.city)}</span>
          <span class="npc-desc">${esc(ev.desc)}</span>
        </div>`;
      }).join('');
      npcHtml = `<div class="npc-events-row">
        <div class="npc-events-hd">天下动态</div>
        <div class="npc-events-grid">${npcItems}</div>
      </div>`;
    }

    // ── v3 新格式：事件列表（按主公聚合展示）──
    const v3Events = (latest.parsed.events || []);
    let v3EventsHtml = '';
    if (v3Events.length) {
      // 按主公分组
      const byLord = {};
      v3Events.forEach(ev => {
        const k = ev.lord || '全局';
        if (!byLord[k]) byLord[k] = [];
        byLord[k].push(ev);
      });
      const cols = Object.entries(byLord).map(([lord, evs]) => {
        const items = evs.map(ev => {
          const placeTag = ev.place
            ? `<span class="v3-ev-place">📍${esc(ev.place)}</span>` : '';
          return `<div class="v3-ev-item">${placeTag}<span class="v3-ev-content">${esc(ev.content)}</span></div>`;
        }).join('');
        return `<div class="v3-ev-col">
          <div class="v3-ev-lord">${esc(lord)}</div>
          ${items}
        </div>`;
      }).join('');
      v3EventsHtml = `<div class="npc-events-row v3-events-row">
        <div class="npc-events-hd">本回合事件</div>
        <div class="v3-ev-grid">${cols}</div>
      </div>`;
    }

    // ── v3 新格式：错误提示 ──
    const v3Errors = (latest.parsed.errors || []);
    let v3ErrorsHtml = '';
    if (v3Errors.length) {
      const errItems = v3Errors.map(e =>
        `<div class="v3-err-item">
          <span class="v3-err-type">${esc(e.type)}</span>
          <span class="v3-err-raw">${esc(e.raw)}</span>
          ${e.problem ? `<span class="v3-err-problem">⚠ ${esc(e.problem)}</span>` : ''}
          ${e.fix ? `<span class="v3-err-fix">→ ${esc(e.fix)}</span>` : ''}
        </div>`
      ).join('');
      v3ErrorsHtml = `<div class="npc-events-row v3-errors-row">
        <div class="npc-events-hd">⚠ 数据错误</div>
        <div>${errItems}</div>
      </div>`;
    }

    row.innerHTML = cardsHtml + npcHtml + v3EventsHtml + v3ErrorsHtml;
  }


  // ══════════════════════════════════════════
  //  历史回合
  // ══════════════════════════════════════════
  function renderHistorySection() {
    const badge   = document.getElementById('history-badge');
    const tabBar  = document.getElementById('history-tab-bar');
    const content = document.getElementById('history-content');
    if (!tabBar || !content) return;

    if (badge) badge.textContent = state.rounds.length;

    if (!state.rounds.length) {
      tabBar.innerHTML  = '';
      content.innerHTML = '<p style="font-size:.78rem;color:var(--text-dim);padding:8px 0">暂无记录</p>';
      return;
    }

    tabBar.innerHTML = state.rounds.map(rd =>
      `<button class="hround-btn" onclick="window.__showHistoryRound(${rd.round})">
        第${rd.round}回合
      </button>`
    ).join('');

    const latest = state.rounds[state.rounds.length - 1];
    content.innerHTML = buildHistoryRoundHTML(latest);
    const btns = tabBar.querySelectorAll('.hround-btn');
    if (btns.length) btns[btns.length - 1].classList.add('active');
  }

  window.__showHistoryRound = function (roundNum) {
    const rd = state.rounds.find(r => r.round === roundNum);
    if (!rd) return;
    const content = document.getElementById('history-content');
    if (content) content.innerHTML = buildHistoryRoundHTML(rd);
    document.querySelectorAll('.hround-btn').forEach(b => {
      b.classList.toggle('active', b.textContent.trim().startsWith(`第${roundNum}回合`));
    });
  };

  function buildHistoryRoundHTML(rd) {
    const p = rd.parsed;
    let html = `<div class="history-round-block">`;

    // 标题（只显示回合号）
    html += `<div class="h-round-title">
      <span class="h-rt-tag">第</span>
      <span class="h-rt-num">${rd.round}</span>
      <span class="h-rt-tag">回合</span>
    </div>`;

    // 战局动态：原文展示
    const rawText = p.rawDigest || buildLegacyDigest(p);
    if (rawText && rawText.trim()) {
      html += `<div class="info-block block-digest" style="margin:0 0 10px">
        <div class="ib-header">
          <span class="ib-icon ib-icon--text">动态</span>
          <span class="ib-title">战局动态</span>
          <span class="digest-tags"><span class="digest-tag tag-situation">AI 原文</span></span>
        </div>
        <div class="ib-body digest-body">
          <div class="digest-raw">${highlightRaw(rawText)}</div>
        </div>
      </div>`;
    }

    // 各方态势（资源快览）
    if (p.players && p.players.length) {
      const P_COLORS = ['var(--p0-color)','var(--p1-color)','var(--p2-color)'];
      html += `<div class="info-block hist-players-block" style="margin:0 0 10px">
        <div class="ib-header"><span class="ib-icon ib-icon--text">态势</span><span class="ib-title">各方态势</span></div>
        <div class="ib-body hist-players-grid">`;
      p.players.forEach((pl, i) => {
        html += `<div class="hist-player-card" style="border-left:3px solid ${P_COLORS[i]||'var(--border-red)'}">
          <div class="hpc-name">
            <span>${esc(pl.name || '城主')}</span>
            ${pl.city ? `<span class="hpc-city">${esc(pl.city)}</span>` : ''}
          </div>`;
        const chips = buildResChips(pl);
        if (chips) html += `<div class="hpc-res">${chips}</div>`;
        if (pl.generals && pl.generals.length) {
          html += `<div class="hpc-generals">` +
            pl.generals.map(g => buildGenTag(g)).join('') +
          `</div>`;
        }
        if (pl.situation_note) html += `<div class="hpc-note">${esc(pl.situation_note)}</div>`;
        html += `</div>`;
      });
      html += `</div></div>`;
    }

    // 战斗结算
    if (p.battles && p.battles.length) {
      html += `<div class="info-block block-battles" style="margin:0 0 10px">
        <div class="ib-header"><span class="ib-icon ib-icon--text">战斗</span><span class="ib-title">战斗结算</span></div>
        <div class="ib-body"><div class="battle-list">` +
        p.battles.map(b => buildBattleCard(b)).join('') +
        `</div></div></div>`;
    }

    html += `</div>`;
    return html;
  }

  function buildResChips(p) {
    return [
      p.gold   != null ? `<span class="res-chip res-chip--gold">金<b>${p.gold}</b></span>`   : '',
      p.food   != null ? `<span class="res-chip res-chip--food">粮<b>${p.food}</b></span>`   : '',
      p.troop  != null ? `<span class="res-chip res-chip--troop">兵<b>${p.troop}</b></span>` : '',
      p.morale != null ? `<span class="res-chip res-chip--morale">心<b>${p.morale}</b></span>` : '',
      p.cities != null ? `<span class="res-chip res-chip--city">城<b>${p.cities}</b></span>` : '',
    ].filter(Boolean).join('');
  }

  // ══════════════════════════════════════════
  //  解析预览
  // ══════════════════════════════════════════
  function showParsePreview(parsed) {
    const box = document.getElementById('parse-preview');
    const res = document.getElementById('parse-result');
    if (!box || !res) return;
    const lines = parsed ? SGParser.summarize(parsed) : ['❌ 无法解析，请检查格式'];
    // 显示下一回合号提示
    const nextRound = state.rounds.length
      ? state.rounds[state.rounds.length - 1].round + 1
      : 1;
    const header = `<div class="pp-item"><strong>🎴 发布后将成为：</strong><span class="pp-ok">第 ${nextRound} 回合</span></div>`;
    res.innerHTML = header + lines.map(l => `<div class="pp-item">${l}</div>`).join('');
    box.classList.remove('hidden');
  }

  // ══════════════════════════════════════════
  //  页脚 / 同步状态
  // ══════════════════════════════════════════
  function updateFooter() {
    const el = document.getElementById('footer-info');
    if (!el) return;
    if (!state.rounds.length) { el.textContent = '尚未开局'; return; }
    const last = state.rounds[state.rounds.length - 1];
    el.textContent = `共 ${state.rounds.length} 回合 · 当前第 ${last.round} 回合`;
  }

  function updateSyncStatus(s) {
    const el = document.getElementById('sync-status');
    if (!el) return;
    const map = {
      loading:  ['☁️ 连接云端中…',                                                         '#3dbe6c'],
      online:   [`☁️ 云端已连接 · ${state.rounds.length} 个回合 · 每30秒自动刷新`,        '#7dce7d'],
      updating: ['🔄 正在同步新内容…',                                                     '#3dbe6c'],
      error:    ['⚠️ 云端连接失败，请刷新页面',                                            '#e74c3c'],
    };
    const [txt, color] = map[s] || map.online;
    el.textContent = txt;
    el.style.color  = color;
  }

  // ══════════════════════════════════════════
  //  Toast
  // ══════════════════════════════════════════
  function showToast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    el.classList.add('show');
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.classList.add('hidden'), 320);
    }, 2800);
  }

  // ══════════════════════════════════════════
  //  粒子特效
  // ══════════════════════════════════════════
  function initParticles() {
    const canvas = document.getElementById('particles-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let W = canvas.width  = window.innerWidth;
    let H = canvas.height = window.innerHeight;
    window.addEventListener('resize', () => {
      W = canvas.width  = window.innerWidth;
      H = canvas.height = window.innerHeight;
    });
    const P = [], N = 48;
    for (let i = 0; i < N; i++) P.push(mkP(true));
    function mkP(rand) {
      return {
        x:  Math.random() * W,
        y:  rand ? Math.random() * H : H + 10,
        r:  Math.random() * 2 + 0.4,
        vx: (Math.random() - .5) * .5,
        vy: -(Math.random() * .8 + .3),
        a:  Math.random() * .6 + .2,
        d:  Math.random() * .003 + .001,
        h:  Math.random() < .6 ? 0 : 35,
      };
    }
    (function draw() {
      ctx.clearRect(0, 0, W, H);
      P.forEach((p, i) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${p.h},90%,55%,${p.a})`;
        ctx.fill();
        p.x += p.vx; p.y += p.vy; p.a -= p.d;
        if (p.a <= 0 || p.y < -10) P[i] = mkP(false);
      });
      requestAnimationFrame(draw);
    })();
  }

  // ══════════════════════════════════════════
  //  工具函数
  // ══════════════════════════════════════════
  function esc(s) {
    if (!s) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
      // 注意：不在这里替换 \n，由 highlightRaw 按行处理
  }

  function setTxt(id, v) {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  }

  document.addEventListener('DOMContentLoaded', init);
})();
