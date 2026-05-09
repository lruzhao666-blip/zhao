/**
 * parser.js — 三国志文字版 · AI内容解析器 v10
 *
 * 支持三种格式：
 *  A. 简化新格式 v3（本文档规范）：
 *     文本中含【结构化数据】区，每行用 △|字段=值|字段=值 管道格式
 *     标签类型：回合△ / 主公△ / 驻军△ / 收支△ / 事件△ / 错误△
 *
 *  B. 旧双段格式 v2.5：
 *     ``` ... ════(36个=)════ ... ```
 *     数据区用 [回合][甲][乙][丙][变动] 等方括号字段块
 *
 *  C. 降级：最旧格式（👤[...] emoji块）
 */

window.SGParser = (function () {
  'use strict';

  const SEP = '='.repeat(36);

  // 兵种顺序（显示用）
  const TROOP_TYPES = ['步', '弓', '骑', '水', '蛮'];

  // ─────────────────────────────────────────
  //  主入口
  // ─────────────────────────────────────────
  function parse(rawText) {
    if (!rawText || !rawText.trim()) return _empty();

    // ── 格式 A：简化新格式 v3 ──
    // 特征：含「【结构化数据】」标记，或每行有「△|」管道格式
    if (/【结构化数据】/.test(rawText) || /[△▽]\|/.test(rawText)) {
      return _parseSimplified(rawText);
    }

    // ── 格式 B：旧双段格式 v2.5 ──
    // 1. 提取代码块（三反引号）
    const codeM = rawText.match(/```[\w]*\n?([\s\S]*?)```/);
    const codeBlock = codeM ? codeM[1] : rawText;

    // 2. 按分隔线切分
    const sepIdx = codeBlock.indexOf(SEP);
    let storyZone, dataZone;
    if (sepIdx !== -1) {
      storyZone = codeBlock.slice(0, sepIdx).trim();
      dataZone  = codeBlock.slice(sepIdx + SEP.length).trim();
    } else {
      storyZone = codeBlock.trim();
      dataZone  = '';
    }

    const result = _empty();
    result.rawDigest = storyZone;

    if (dataZone) {
      _parseDataZone(dataZone, result);
    } else {
      _parseLegacy(storyZone, result);
    }

    return result;
  }

  // ═══════════════════════════════════════════════
  //  格式 A 解析器：简化新格式 v3
  //  输入示例：
  //    回合△|回合=54|阶段=回合末|下一回合=55
  //    主公△|名称=高|金=1416|粮=179|兵=3125|民心=100|城池数=7
  //    驻军△|城名=吴郡|武将=朱治,周瑜|金=1416|粮=179|兵=3125|民心=100|状态=正常
  //    收支△|主公=高|金=-50|粮=+200|兵=0|民心=+2|原因=广陵粮契谈判
  //    事件△|主公=高|地点=吴郡|内容=周瑜正式入幕...
  //    错误△|类型=显示错误|原文=...|问题=...|修正=...
  // ═══════════════════════════════════════════════
  function _parseSimplified(rawText) {
    const result = _empty();

    // 提取【结构化数据】区（到下一个【...】或文末）
    const structM = rawText.match(/【结构化数据】([\s\S]*?)(?=【[^】]+】|$)/);
    const structZone = structM ? structM[1] : rawText;

    // 剧情区（结构化数据之前的部分）
    const storyZone = structM
      ? rawText.slice(0, rawText.indexOf('【结构化数据】')).trim()
      : '';
    result.rawDigest = storyZone;

    // 逐行解析
    const lines = structZone.split('\n').map(l => l.trim()).filter(Boolean);

    // 临时存储，按主公名聚合
    const playerMap   = {};   // 名称 → player 对象
    const garrisonArr = [];   // 驻军行
    const changeMap   = {};   // 主公名 → change 对象
    const eventArr    = [];   // 事件行
    const errorArr    = [];   // 错误行

    for (const line of lines) {
      // 跳过纯注释行和标题行
      if (/^【/.test(line) || /^\/\//.test(line)) continue;

      // 解析类型△|字段=值|...
      const typeM = line.match(/^([^△\s]+)△\s*\|?(.*)/);
      if (!typeM) continue;

      const type   = typeM[1].trim();   // 回合 / 主公 / 驻军 / 收支 / 事件 / 错误
      const rest   = typeM[2].trim();
      const fields = _parsePipeFields(rest);

      switch (type) {
        case '回合':
          result.round     = parseInt(fields['回合']) || result.round;
          result.roundInfo = {
            round:     parseInt(fields['回合'])     || null,
            phase:     fields['阶段']               || '',
            nextRound: parseInt(fields['下一回合']) || null,
          };
          break;

        case '主公': {
          const name = fields['名称'] || fields['主公'] || '';
          if (!name) break;
          if (!playerMap[name]) playerMap[name] = _emptyPlayer(name);
          const p = playerMap[name];
          if (fields['金']     != null) p.gold   = parseInt(fields['金'])   || 0;
          if (fields['粮']     != null) p.food   = parseInt(fields['粮'])   || 0;
          if (fields['兵']     != null) p.troop  = parseInt(fields['兵'])   || 0;
          if (fields['民心']   != null) p.morale = parseInt(fields['民心']) || 0;
          if (fields['城池数'] != null) p.cities = parseInt(fields['城池数']) || 0;
          break;
        }

        case '驻军': {
          const cityName  = fields['城名'] || '';
          const holderRaw = fields['武将'] || '无';
          const holders   = holderRaw === '无' ? [] : holderRaw.split(',').map(s => s.trim());
          const g = {
            cityName,
            holder:  holders.join('/') || '无',
            gold:    parseInt(fields['金'])   || 0,
            food:    parseInt(fields['粮'])   || 0,
            troop:   parseInt(fields['兵'])   || 0,
            morale:  parseInt(fields['民心']) || 0,
            status:  fields['状态'] || '正常',
            // 将领列表（供城池弹窗用）
            generals: holders.map(h => ({ name: h, status: '健康' })),
          };
          garrisonArr.push(g);

          // 同步到 cities_list：找该城归属的主公
          // （主公行之后才能确定归属，延迟关联）
          if (cityName) {
            if (!result._pendingCities) result._pendingCities = {};
            result._pendingCities[cityName] = g;
          }
          break;
        }

        case '收支': {
          const lord = fields['主公'] || '';
          if (!changeMap[lord]) changeMap[lord] = _emptyChange(lord);
          const ch = changeMap[lord];
          if (fields['金']   != null) ch.resources['金']   = parseInt(fields['金'])   || 0;
          if (fields['粮']   != null) ch.resources['粮']   = parseInt(fields['粮'])   || 0;
          if (fields['兵']   != null) ch.resources['兵']   = parseInt(fields['兵'])   || 0;
          if (fields['民心'] != null) ch.resources['民心'] = parseInt(fields['民心']) || 0;
          if (fields['原因']) {
            ch.intel.push(fields['原因']);
          }
          break;
        }

        case '事件': {
          const lord    = fields['主公'] || '';
          const place   = fields['地点'] || '';
          const content = fields['内容'] || '';
          if (content) {
            eventArr.push({ lord, place, content });
            // 同时追加到对应主公的 intel
            if (lord) {
              if (!changeMap[lord]) changeMap[lord] = _emptyChange(lord);
              changeMap[lord].intel.push(content);
            }
          }
          break;
        }

        case '错误': {
          errorArr.push({
            type:    fields['类型']  || '未知',
            raw:     fields['原文']  || '',
            problem: fields['问题']  || '',
            fix:     fields['修正']  || '',
          });
          break;
        }
      }
    }

    // ── 后处理：playerMap → result.players ──
    const slotNames = ['甲', '乙', '丙'];
    let slotIdx = 0;
    for (const [name, p] of Object.entries(playerMap)) {
      p.slot = slotNames[slotIdx] || `玩家${slotIdx + 1}`;
      slotIdx++;
      // 关联驻军城池 → cities_list
      p.cities_list = garrisonArr
        .filter(g => _isCityOfPlayer(g, name, playerMap))
        .map(g => ({
          name:    g.cityName,
          holder:  g.holder,
          troops:  {},   // 新格式无兵种细分，仅有总兵力
          troop:   g.troop,
        }));
      p.ownedCities = p.cities_list.map(c => c.name);
      if (p.cities_list.length > 0) p.city = p.cities_list[0].name;
      result.players.push(p);
    }

    // ── 后处理：garrison ──
    result.garrison = garrisonArr.map(g => ({
      cityName: g.cityName,
      generals: g.generals,
    }));

    // ── 后处理：changes（附 slot）──
    result.changes = Object.entries(changeMap).map(([lord, ch]) => {
      // 找对应 player 的 slot
      const player = result.players.find(p => p.name === lord);
      ch.slot = player ? player.slot : lord;
      return ch;
    });

    // ── 后处理：events 挂到 result ──
    result.events  = eventArr;
    result.errors  = errorArr;

    // ── cityOwnership（地图用）──
    result.cityOwnership = _buildCityOwnershipFromGarrison(
      result.players, garrisonArr
    );

    // 清理临时字段
    delete result._pendingCities;

    return result;
  }

  // ── 辅助：解析管道字段 "城名=吴郡|武将=朱治,周瑜|..." → { 城名:'吴郡', 武将:'朱治,周瑜' } ──
  function _parsePipeFields(str) {
    const fields = {};
    if (!str) return fields;
    str.split('|').forEach(seg => {
      const eq = seg.indexOf('=');
      if (eq === -1) return;
      const key = seg.slice(0, eq).trim();
      const val = seg.slice(eq + 1).trim();
      if (key) fields[key] = val;
    });
    return fields;
  }

  // ── 辅助：空 player 对象 ──
  function _emptyPlayer(name) {
    return {
      slot: '', name,
      city: '', gold: null, food: null, troop: null, morale: null, cities: null,
      generals: [], cities_list: [], ownedCities: [],
      situation_note: '', suggestions: [],
    };
  }

  // ── 辅助：空 change 对象 ──
  function _emptyChange(lord) {
    return {
      slot: lord, raw: '',
      resources: {}, cities: [], guards: [], troopChanges: [],
      breakdown: {}, darkItems: [], seasonal: [], intel: [], warnings: [],
    };
  }

  // ── 辅助：城市是否属于某主公 ──
  // 新格式无城市-主公归属行，暂时按驻军顺序均分；
  // 若主公行含城池数，可按数量切分
  function _isCityOfPlayer(garrison, lordName, playerMap) {
    // 简化策略：所有驻军城池都暂不绑定主公（主公行缺少城池列表时）
    // 调用方会自行按 garrisonArr 全部列出
    return false;
  }

  // ── 辅助：从驻军数据构建 cityOwnership ──
  function _buildCityOwnershipFromGarrison(players, garrisonArr) {
    const result = {};
    // 先从 players.cities_list 建立归属
    players.forEach((p, idx) => {
      (p.cities_list || []).forEach((c, ci) => {
        result[c.name] = {
          owner:      `p${idx}`,
          playerIdx:  idx,
          playerName: p.name,
          holder:     c.holder || '无',
          troops:     c.troops || {},
          isMulti:    ci > 0,
        };
      });
    });
    // 再补充未归属的驻军城池（标记为 npc 或 unknown）
    garrisonArr.forEach(g => {
      if (!result[g.cityName]) {
        result[g.cityName] = {
          owner:      'npc',
          playerIdx:  -1,
          playerName: '',
          holder:     g.holder || '无',
          troops:     {},
          isMulti:    false,
        };
      }
    });
    return result;
  }

  function _empty() {
    return {
      round:         null,
      digest:        '',
      rawDigest:     '',
      players:       [],     // [{slot,name,gold,food,troop,morale,cities,cities_list,generals,troops}]
      npcCities:     [],     // [{name,holder,troops}]
      battles:       [],
      changes:       [],
      garrison:      [],
      cityOwnership: {},
      roundInfo:     {},
      events:        [],     // v3 新格式：事件列表 [{lord,place,content}]
      errors:        [],     // v3 新格式：错误列表 [{type,raw,problem,fix}]
    };
  }

  // ─────────────────────────────────────────
  //  数据区解析
  // ─────────────────────────────────────────
  function _parseDataZone(text, result) {
    const blocks = _splitBlocks(text);

    // [回合]
    if (blocks['回合']) {
      const m = blocks['回合'].match(/第\s*(\d+)\s*回合/);
      if (m) result.round = parseInt(m[1]);
    }

    // [速递]
    if (blocks['速递']) {
      result.digest = blocks['速递'].trim();
    }

    // [甲][乙][丙]
    const SLOTS = ['甲', '乙', '丙'];
    SLOTS.forEach((slot) => {
      if (blocks[slot]) {
        const p = _parsePlayerBlock(slot, blocks[slot]);
        result.players.push(p);
      }
    });

    // [NPC]
    if (blocks['NPC'] || blocks['npc']) {
      const npcRaw = blocks['NPC'] || blocks['npc'] || '';
      result.npcCities = _parseCityList(npcRaw.replace(/^城池[:：]?\s*/i, ''));
    }

    // [战报]
    if (blocks['战报']) {
      result.battles = _parseBattles(blocks['战报']);
    }

    // [变动]
    if (blocks['变动']) {
      result.changes = _parseChanges(blocks['变动']);
      // 从变动中更新兵力到 cityOwnership（延迟：先建好 cityOwnership 后处理）
    }

    // [驻城]
    if (blocks['驻城']) {
      result.garrison = _parseGarrisonBlock(blocks['驻城']);
    }

    // 构建 cityOwnership
    result.cityOwnership = _buildCityOwnership(result.players, result.npcCities);

    // 应用 兵种△ 变动
    if (blocks['变动']) {
      _applyTroopChanges(blocks['变动'], result.cityOwnership);
    }
  }

  // ─────────────────────────────────────────
  //  按字段名切块
  // ─────────────────────────────────────────
  function _splitBlocks(text) {
    const lines  = text.split('\n');
    const blocks = {};
    let curKey  = null;
    let curBuf  = [];

    for (const line of lines) {
      const m = line.match(/^[\[【]([^\]】\n]{1,10})[\]】]/);
      if (m) {
        const key = m[1].trim();
        if (['回合','速递','甲','乙','丙','NPC','npc','战报','变动','驻城'].includes(key)) {
          if (curKey !== null) blocks[curKey] = curBuf.join('\n');
          curKey = key;
          const rest = line.replace(/^[\[【][^\]】\n]{1,10}[\]】]\s*/, '').trim();
          curBuf = rest ? [rest] : [];
          continue;
        }
      }
      if (curKey !== null) curBuf.push(line);
    }
    if (curKey !== null) blocks[curKey] = curBuf.join('\n');
    return blocks;
  }

  // ─────────────────────────────────────────
  //  解析单个玩家块 [甲]/[乙]/[丙]
  // ─────────────────────────────────────────
  function _parsePlayerBlock(slot, raw) {
    const p = {
      slot,
      name:           '',
      city:           '',
      gold:           null,
      food:           null,
      troop:          null,
      morale:         null,
      cities:         null,
      generals:       [],
      cities_list:    [],   // [{name, holder, troops:{步:n,弓:n,...}}]
      ownedCities:    [],
      situation_note: '',
      suggestions:    [],
    };

    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);

    for (const line of lines) {
      // 名号
      if (/^名号[:：]/.test(line)) {
        p.name = line.replace(/^名号[:：]\s*/, '').trim();
        continue;
      }
      // 资源行
      const resM = line.match(/金[:：](\d+)\s+粮[:：](\d+)\s+兵[:：](\d+)\s+民心[:：](\d+)\s+城[:：](\d+)/);
      if (resM) {
        p.gold   = parseInt(resM[1]);
        p.food   = parseInt(resM[2]);
        p.troop  = parseInt(resM[3]);
        p.morale = parseInt(resM[4]);
        p.cities = parseInt(resM[5]);
        continue;
      }
      // 城池行（v2.5 新格式兼容）
      if (/^城池[:：]/.test(line)) {
        const cityRaw = line.replace(/^城池[:：]\s*/, '');
        p.cities_list = _parseCityList(cityRaw);
        p.ownedCities = p.cities_list.map(c => c.name);
        if (p.cities_list.length > 0) p.city = p.cities_list[0].name;
        continue;
      }
      // 武将行
      if (/^武将[:：]/.test(line)) {
        const genRaw = line.replace(/^武将[:：]\s*/, '');
        p.generals = _parseGeneralList(genRaw);
        continue;
      }
    }

    return p;
  }

  // ─────────────────────────────────────────
  //  解析城池列表（v2.5）
  //  支持：
  //    城名(守将/守将2|骑:3000,步:2000)   ← 新格式
  //    城名(守将)                          ← 旧格式
  //    城名(无|无兵)                       ← 新格式空城
  // ─────────────────────────────────────────
  function _parseCityList(raw) {
    if (!raw || !raw.trim()) return [];
    const result = [];
    // v2.7.9 解析铁律：标准格式 城名(守将/守将2|骑:3000,步:2000)
    // 中文括号/全角逗号兼容，但发出警告
    if (/[（）]/.test(raw)) {
      console.warn('[SGParser] 城池行含中文括号（），建议改用英文括号(): ' + raw.slice(0,60));
    }
    if (/，/.test(raw)) {
      console.warn('[SGParser] 城池行含全角逗号，，建议改用半角逗号,: ' + raw.slice(0,60));
    }
    // 匹配：城名(内容) 或 城名（内容）
    const re = /([^,，、(（\s]+)[（(]([^）)]*)[）)]/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      const name    = m[1].trim();
      const inner   = m[2].trim();
      if (!name) continue;

      // v2.5：内部含 | → 分离守将和兵力
      const pipeIdx = inner.indexOf('|');
      let holderRaw, troopsRaw;
      if (pipeIdx !== -1) {
        holderRaw = inner.slice(0, pipeIdx).trim();
        troopsRaw = inner.slice(pipeIdx + 1).trim();
      } else {
        // 旧格式：内部全部视为守将
        holderRaw = inner;
        troopsRaw = null;
      }

      // 守将：支持 / 分隔多将，"无" → ''
      const holders = holderRaw === '无' ? [] : holderRaw.split('/').map(s => s.trim()).filter(Boolean);
      const holder  = holders.join('/') || '无';

      // 兵力
      const troops = _parseTroops(troopsRaw);

      result.push({ name, holder, troops });
    }

    // 兼容无括号纯城名列表
    if (!result.length) {
      raw.split(/[,，、\s]+/).forEach(s => {
        const n = s.trim();
        if (n) result.push({ name: n, holder: '无', troops: {} });
      });
    }
    return result;
  }

  // ─────────────────────────────────────────
  //  解析兵力字符串
  //  输入：骑:3000,步:2000 / 无兵 / null
  //  输出：{ 骑:3000, 步:2000 } / {}
  // ─────────────────────────────────────────
  function _parseTroops(raw) {
    if (!raw || raw === '无兵' || raw.trim() === '') return {};
    const result = {};
    // 格式：步:500,弓:200,骑:1000
    raw.split(',').forEach(seg => {
      const m = seg.trim().match(/^([步弓骑水蛮])[:：](\d+)$/);
      if (m) result[m[1]] = parseInt(m[2]);
    });
    return result;
  }

  // ─────────────────────────────────────────
  //  解析武将列表
  // ─────────────────────────────────────────
  const VALID_STATUS = ['健康', '疲劳', '受伤', '患病', '阵亡'];

  function _parseGeneralList(raw) {
    if (!raw || !raw.trim()) return [];
    const result = [];
    const re = /([^,，、(（\s]+)[（(]([^）)]*)[）)]/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      const name   = m[1].trim();
      let   status = m[2].trim();
      if (!VALID_STATUS.includes(status)) {
        console.warn(`[SGParser] 武将状态不在白名单: "${status}"，视为健康`);
        status = '健康';
      }
      if (name && name.length >= 2 && name.length <= 8) {
        result.push({ name, status });
      }
    }
    if (!result.length) {
      raw.split(/[,，、\s]+/).forEach(s => {
        const n = s.trim();
        if (n && n.length >= 2 && n.length <= 8 && /[\u4e00-\u9fa5]/.test(n)) {
          result.push({ name: n, status: '健康' });
        }
      });
    }
    return result;
  }

  // ─────────────────────────────────────────
  //  解析驻城块
  // ─────────────────────────────────────────
  const GARRISON_ROLES = ['驻城', '任务', '客将', '新附'];

  function _parseGarrisonBlock(raw) {
    if (!raw || !raw.trim()) return [];
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 1 && /本回合无驻城调度/.test(lines[0])) return [];
    const result = [];
    for (const line of lines) {
      const colonIdx = line.search(/[:：]/);
      if (colonIdx < 0) continue;
      const cityName = line.slice(0, colonIdx).trim();
      const genRaw   = line.slice(colonIdx + 1).trim();
      if (!cityName || !genRaw) continue;
      const generals = [];
      const re = /([^,，、(（\s]+)[（(]([^）)]+)[）)]/g;
      let m;
      while ((m = re.exec(genRaw)) !== null) {
        const name   = m[1].trim();
        const detail = m[2].trim();
        const isTask = /剩\d+/.test(detail);
        const role   = GARRISON_ROLES.find(r => detail.startsWith(r)) || detail.split('·')[0] || '驻城';
        generals.push({ name, role, taskDetail: isTask ? detail : '' });
      }
      if (cityName && generals.length) {
        result.push({ cityName, generals });
      }
    }
    return result;
  }

  // ─────────────────────────────────────────
  //  解析战报
  // ─────────────────────────────────────────
  function _parseBattles(raw) {
    if (!raw || !raw.trim()) return [];
    const lines   = raw.split('\n').map(l => l.trim()).filter(Boolean);
    const battles = [];
    const re = /^(.+?)[→\->\-＞]\s*(.+?)\s*[|｜]\s*(胜|平|负)\s*[|｜]\s*伤亡[:：]攻(\d+)守(\d+)/;
    for (const line of lines) {
      if (/^本回合无战事/.test(line)) continue;
      const m = line.match(re);
      if (m) {
        battles.push({
          attacker:      m[1].trim(),
          defender:      m[2].trim(),
          result:        m[3],
          attacker_loss: parseInt(m[4]),
          defender_loss: parseInt(m[5]),
          success:       m[3] === '胜',
        });
      }
    }
    return battles;
  }

  // ─────────────────────────────────────────
  //  解析变动块 v3.0
  //  支持：收支△ / 暗账△ / 季度△ / 情报△ / 兵种△
  //  支持同行内容（暗账△盐铺:金-40）
  //  新增：NPC 状态事件（NPC 虎牢关状态△... 野外△...）
  // ─────────────────────────────────────────
  function _parseChanges(raw) {
    if (!raw || !raw.trim()) return [];
    const result   = [];
    const npcLines = [];  // 收集 NPC / 野外 行

    // 按玩家槽切分（甲/乙/丙 开头的行为分隔符）
    const lines = raw.split('\n');
    let curSlot = null, curLines = [];

    const flush = () => {
      if (!curSlot) return;
      const change = _parseOneChange(curSlot, curLines.join('\n'));
      if (change) result.push(change);
    };

    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;

      // NPC / 野外 行（旧格式："NPC 城名状态△" / 新格式："NPC状态△城名:" / 野外△）
      if (/^NPC[\s状]/.test(t) || /^NPC状态△/.test(t) || /野外△/.test(t)) {
        npcLines.push(t);
        continue;
      }

      const slotM = t.match(/^([甲乙丙])\s*[：:]?\s*(.*)/);
      if (slotM && ['甲','乙','丙'].includes(slotM[1])) {
        const newSlot = slotM[1];
        const rest    = slotM[2] || '';
        if (newSlot === curSlot) {
          // ★ 同一槽位的后续行（甲 收支△ / 甲 情报△xxx 等）→ 追加，绝不 flush
          if (rest) curLines.push(rest);
        } else {
          // 切换到新槽 → flush 旧槽，开新槽
          flush();
          curSlot  = newSlot;
          curLines = rest ? [rest] : [];
        }
      } else if (curSlot) {
        // 纯内容行（无槽前缀）→ 追加到当前槽
        curLines.push(t);
      }
    }
    flush();

    // 解析 NPC 事件并附到第一个 change 上（或单独保存到 result.__npc）
    const npcEvents = _parseNpcEvents(npcLines);
    if (npcEvents.length) {
      // 挂到 result 数组的隐藏属性，renderChangesDetail 会读取
      result.__npc = npcEvents;
    }

    return result;
  }

  // ─────────────────────────────────────────
  //  解析 NPC 状态行
  //  "NPC 虎牢关状态△吕布更换西门巡夜 阳平关状态△杨任修补坡道准备再守"
  //  "野外△高定再送山盐但仍未归附 野外△士林关注三家治民军纪"
  // ─────────────────────────────────────────
  function _parseNpcEvents(lines) {
    const events = [];
    for (const line of lines) {

      // ── 新格式：NPC状态△城名:动态内容（每行一条）──
      // 例：NPC状态△虎牢关:吕布严查盐铺
      const nm = line.match(/^NPC状态△([^:：]+)[：:](.+)/);
      if (nm) {
        events.push({ type: 'npc', city: nm[1].trim(), desc: nm[2].trim() });
        continue;
      }

      // ── 旧格式：NPC 城名状态△动态 城名状态△动态 … 野外△动态 ──
      // 例：NPC 虎牢关状态△吕布更换西门巡夜 阳平关状态△杨任修补坡道
      const reCityStr = '([^\\s△]+)状态△([^△]+?)(?=\\s+[^\\s△]+状态△|\\s*野外△|\\s*$)';
      const reCity = new RegExp(reCityStr, 'g');
      const reWild = /野外△([^△]+?)(?=\s+野外△|\s*$)/g;
      let m;
      while ((m = reCity.exec(line)) !== null) {
        const city = m[1].trim();
        // 跳过「NPC」「NPC状态」本身被误匹配为城名
        if (city === 'NPC' || city === 'NPC状态') continue;
        events.push({ type: 'npc', city, desc: m[2].trim() });
      }
      while ((m = reWild.exec(line)) !== null) {
        events.push({ type: 'wild', city: '野外', desc: m[1].trim() });
      }
    }
    return events;
  }

  function _parseOneChange(slot, raw) {
    const change = {
      slot,
      raw,
      resources:    {},   // 总变化 金△粮△兵△民心△城△
      cities:       [],   // 城池变动
      guards:       [],   // 守将变动
      troopChanges: [],   // 兵种变动 [{cityName, entries:[{type,val}]}]
      breakdown:    {},   // 收支△ 明细 { 金:{items:[{label,val}],total}, 粮:... }
      darkItems:    [],   // 府库△(兼容暗账△) 条目 [{desc,entries:[{res,val}]}]
      seasonal:     [],   // 季度△ 条目 [{res,val}]
      intel:        [],   // 情报△ 条目 [string]
      warnings:     [],   // 校验报警 [string]
    };

    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);

    // ── 当前解析锚点 ──
    let anchor = null;   // 'breakdown' | 'dark' | 'seasonal' | 'intel'

    for (const line of lines) {

      /* ── 总变化行：金△+200 粮△-100 … ── */
      const resRe = /(金|粮|兵|民心|城)△([+-]?\d+)/g;
      let rm;
      while ((rm = resRe.exec(line)) !== null) {
        change.resources[rm[1]] = parseInt(rm[2]);
      }

      /* ── 城池变动 ── */
      const cityRe = /城△([+-]\d+)[（(](攻下|失去)([^）)]+)[）)]/g;
      let cm;
      while ((cm = cityRe.exec(line)) !== null) {
        change.cities.push({ delta: parseInt(cm[1]), action: cm[2], cityName: cm[3].trim() });
      }

      /* ── 守将变动 ── */
      const guardRe = /(?:驻军|守将)△([^:：]+)[:：]([^(（\s]+)(?:[（(]原[:：]([^）)]+)[）)])?/g;
      let gm;
      while ((gm = guardRe.exec(line)) !== null) {
        change.guards.push({ cityName: gm[1].trim(), newHolder: gm[2].trim(), prevHolder: gm[3] ? gm[3].trim() : null });
      }

      /* ── 兵种变动：兵种△城名:骑+500,步-200 ── */
      /* ★ 兵种△ 行同时作为锚点重置触发器，阻止流入 anchor 分支 */
      if (/^兵种△/.test(line)) {
        anchor = null;  // 兵种△ 不属于任何文本锚点，重置
        const troopRe2 = /兵种△([^:：]+)[:：]([^\n]+)/g;
        let tm2;
        while ((tm2 = troopRe2.exec(line)) !== null) {
          const cityName = tm2[1].trim();
          const spec     = tm2[2].trim();
          const deltaRe2 = /([步弓骑水蛮])([+-]\d+)/g;
          let dm2;
          const deltaEntries = [];
          while ((dm2 = deltaRe2.exec(spec)) !== null) {
            deltaEntries.push({ type: dm2[1], val: parseInt(dm2[2]) });
          }
          if (deltaEntries.length) {
            change.troopChanges.push({ cityName, spec, entries: deltaEntries, isDelta: true });
          } else {
            // 绝对值格式 步:2000,弓:1000
            const absEntries = [];
            const absRe = /([步弓骑水蛮])[:：](\d+)/g;
            let am;
            while ((am = absRe.exec(spec)) !== null) {
              absEntries.push({ type: am[1], val: parseInt(am[2]) });
            }
            change.troopChanges.push({ cityName, spec, entries: absEntries, isDelta: false });
          }
        }
        continue;  // ★ 阻止继续流入 anchor 分支
      }

      /* ── 非 兵种△ 的其他兵种变动（行内，非行首）── */
      const troopRe = /兵种△([^:：]+)[:：]([^\n]+)/g;
      let tm;
      while ((tm = troopRe.exec(line)) !== null) {
        const cityName = tm[1].trim();
        const spec     = tm[2].trim();
        const deltaRe = /([步弓骑水蛮])([+-]\d+)/g;
        let dm;
        const deltaEntries = [];
        while ((dm = deltaRe.exec(spec)) !== null) {
          deltaEntries.push({ type: dm[1], val: parseInt(dm[2]) });
        }
        change.troopChanges.push({
          cityName,
          spec,
          entries: deltaEntries.length ? deltaEntries : [],
          isDelta: deltaEntries.length > 0,
        });
      }

      /* ── 锚点切换（支持同行内容）── */
      if (/^收支△/.test(line)) {
        anchor = 'breakdown';
        continue;
      }

      if (/^(?:府库|暗账)△/.test(line)) {
        anchor = 'dark';
        // 同行内容：府库△盐铺打点:金-40 / 暗账△（旧格式兼容）
        const rest = line.replace(/^(?:府库|暗账)△\s*/, '').trim();
        if (rest) _parseDarkLine(rest, change.darkItems);
        continue;
      }

      if (/^季度△/.test(line)) {
        anchor = 'seasonal';
        // 同行内容：季度△金-280,粮-420
        const rest = line.replace(/^季度△\s*/, '').trim();
        if (rest) _parseSeasonalLine(rest, change.seasonal);
        continue;
      }

      if (/^情报△/.test(line)) {
        anchor = 'intel';
        // 同行内容：情报△陈留粮市继续运转（跳过 NPC状态△ / 野外△）
        const rest = line.replace(/^情报△\s*/, '').trim();
        if (rest && !/^NPC|状态△|野外△/.test(rest))
          change.intel.push(rest.replace(/^[·•\-]\s*/, ''));
        continue;
      }

      /* ── 锚点内容解析 ── */
      if (anchor === 'breakdown') {
        // 格式 A（逗号分隔）：金:产出+242,维护-136,季度-280,合计-484
        // 格式 B（空格分隔）：金 产出+242 维护-136 季度-280 合计-484
        const catM = line.match(/^(金|粮|兵|民心)[：:，,\s]+(.*)/);
        if (catM) {
          const cat   = catM[1];
          const rest2 = catM[2];
          const items = [];
          const itemRe = /([^\s,，·|·+\-\d合计][^,，·\d+\-]*?)([+-]\d+)/g;
          let im;
          while ((im = itemRe.exec(rest2)) !== null) {
            let lbl = im[1].replace(/[→:：]/g,'').trim();
            if (lbl === '暗账') lbl = '府库';   // v2.7.9 统一命名
            if (lbl && lbl !== '合') items.push({ label: lbl, val: parseInt(im[2]) });
          }
          const totalM = rest2.match(/合计([+-]?\d+)/);
          change.breakdown[cat] = { items, total: totalM ? parseInt(totalM[1]) : null };
        }
      } else if (anchor === 'dark') {
        // 防线：跳过任何含 兵种△ 的行（已由上方处理并 continue）
        if (line && !/兵种△/.test(line)) _parseDarkLine(line, change.darkItems);
      } else if (anchor === 'seasonal') {
        _parseSeasonalLine(line, change.seasonal);
      } else if (anchor === 'intel') {
        // 过滤 NPC状态△ / 野外△ 行：属于天下动态，不进情报
        if (line && !/^NPC|状态△|野外△/.test(line))
          change.intel.push(line.replace(/^[·•\-]\s*/, ''));
      }
    }

    // ── 收支合计校验 ──
    // 对每个资源：若 breakdown[res].total 存在，且 resources[res] 也存在，则比对
    for (const res of ['金','粮','兵','民心']) {
      const bd = change.breakdown[res];
      if (!bd || bd.total === null || bd.total === undefined) continue;
      const declared = change.resources[res];
      if (declared === undefined) continue;
      if (bd.total !== declared) {
        change.warnings.push(
          `${res}合计不符：收支明细合计${bd.total > 0 ? '+' : ''}${bd.total}，总变化${declared > 0 ? '+' : ''}${declared}`
        );
        console.warn(`[SGParser] ${slot} ${res}合计不符: breakdown.total=${bd.total}, resources=${declared}`);
      }
    }

    return change;
  }

  // 解析府库行：盐铺打点:金-40  /  周瑜理政:金-80,粮-20
  function _parseDarkLine(line, arr) {
    if (!line) return;
    // 格式：描述:资源变动 或 描述：资源变动
    const colonM = line.match(/^([^:：]+)[：:](.+)/);
    if (colonM) {
      const desc    = colonM[1].trim();
      const resRaw  = colonM[2].trim();
      const entries = [];
      const re      = /(金|粮|兵|民心)([+-]\d+)/g;
      let m;
      while ((m = re.exec(resRaw)) !== null) {
        entries.push({ res: m[1], val: parseInt(m[2]) });
      }
      arr.push({ desc, entries });
    } else {
      arr.push({ desc: line, entries: [] });
    }
  }

  // 解析季度行：金-280,粮-420
  function _parseSeasonalLine(line, arr) {
    if (!line) return;
    const re = /(金|粮|兵|民心)([+-]\d+)/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      arr.push({ res: m[1], val: parseInt(m[2]) });
    }
  }

  // ─────────────────────────────────────────
  //  应用 兵种△ 变动到 cityOwnership
  //  格式 A：骑+500 / 水-300  → 增减
  //  格式 B：步:2000,弓:1000  → 覆盖
  // ─────────────────────────────────────────
  function _applyTroopChanges(raw, cityOwnership) {
    // 直接从原始变动行扫描 兵种△
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      // 兵种△城名:规格（可能有多个，逗号分隔）
      const re = /兵种△([^:：]+)[:：]([^\s]+)/g;
      let m;
      while ((m = re.exec(t)) !== null) {
        const cityName = m[1].trim();
        const spec     = m[2].trim();
        if (!cityOwnership[cityName]) continue;
        const ow = cityOwnership[cityName];
        if (!ow.troops) ow.troops = {};

        // 判断是覆盖式（含 : 且不含 + -）还是增减式
        const isOverwrite = /^([步弓骑水蛮]:[\d]+,?)+$/.test(spec);
        if (isOverwrite) {
          // 覆盖
          ow.troops = _parseTroops(spec);
        } else {
          // 增减：骑+500 或 水-300
          spec.split(',').forEach(seg => {
            const dm = seg.trim().match(/^([步弓骑水蛮])([+-]\d+)$/);
            if (dm) {
              const type  = dm[1];
              const delta = parseInt(dm[2]);
              ow.troops[type] = Math.max(0, (ow.troops[type] || 0) + delta);
            }
          });
        }
      }
    }
  }

  // ─────────────────────────────────────────
  //  构建 cityOwnership（地图用）
  //  v2.5：携带 troops 字段
  // ─────────────────────────────────────────
  function _buildCityOwnership(players, npcCities) {
    const result = {};

    players.forEach((p, idx) => {
      const slotIdx = ['甲','乙','丙'].indexOf(p.slot);
      const pidx    = slotIdx >= 0 ? slotIdx : idx;
      (p.cities_list || []).forEach((c, ci) => {
        result[c.name] = {
          owner:      `p${pidx}`,
          playerIdx:  pidx,
          playerName: p.name || p.slot,
          holder:     c.holder || '无',
          troops:     c.troops || {},
          isMulti:    ci > 0,
        };
      });
    });

    (npcCities || []).forEach(c => {
      if (!result[c.name]) {
        result[c.name] = {
          owner:      'npc',
          playerIdx:  -1,
          playerName: '',
          holder:     c.holder || '无',
          troops:     c.troops || {},   // NPC 兵力保存但前端不渲染
          isMulti:    false,
        };
      }
    });

    return result;
  }

  // ─────────────────────────────────────────
  //  降级：旧格式解析
  // ─────────────────────────────────────────
  function _parseLegacy(text, result) {
    const rnM = text.match(/第\s*(\d+)\s*回合/);
    if (rnM) result.round = parseInt(rnM[1]);

    const blockRe = /👤[【\[]([^】\]\n]+)[】\]]([\s\S]*?)(?=👤[【\[]|$)/g;
    let m;
    while ((m = blockRe.exec(text)) !== null) {
      const p = _parseLegacyPlayer(m[1], m[2]);
      if (p.name) result.players.push(p);
    }
    result.cityOwnership = _buildCityOwnership(result.players, []);
  }

  function _parseLegacyPlayer(header, body) {
    const parts = header.split(/\s*[·•\-]\s*/);
    const p = {
      slot: '', name: parts[0].trim(), city: parts[1] ? parts[1].trim() : '',
      gold: null, food: null, troop: null, morale: null, cities: null,
      generals: [], cities_list: [], ownedCities: [], situation_note: '', suggestions: [],
    };
    if (p.city) {
      p.cities_list = [{ name: p.city, holder: '无', troops: {} }];
      p.ownedCities = [p.city];
    }
    const resMap = [
      { key:'gold',   re:/💰\s*金[钱]?\s*[：:\s]\s*(\d+)/          },
      { key:'food',   re:/🌾\s*粮[草食]?\s*[：:\s]\s*(\d+)/         },
      { key:'troop',  re:/(?:🛡|🛡️)\uFE0F?\s*兵[力]?\s*[：:\s]\s*(\d+)/  },
      { key:'morale', re:/(?:❤|❤️)\uFE0F?\s*民心\s*[：:\s]\s*(\d+)/ },
      { key:'cities', re:/🏯\s*城[池]?\s*[：:\s]\s*(\d+)/            },
    ];
    for (const { key, re } of resMap) {
      const rm = body.match(re);
      if (rm) p[key] = parseInt(rm[1]);
    }
    const genM = body.match(/(?:⚔️?)\s*(?:麾下)?武将[列表]*\s*[：:]\s*([\s\S]+?)(?=\n\s*\n|\n\s*[📍🎯❤💰🌾🛡🏯⚔]|$)/);
    if (genM) {
      genM[1].split(/[,，、\n]/).forEach(s => {
        const n = s.trim().replace(/[（(][^）)]*[）)]/g,'').trim();
        const stM = s.match(/[（(](健康|疲劳|受伤|患病|阵亡)[）)]/);
        if (n && n.length >= 2 && n.length <= 8) p.generals.push({ name: n, status: stM ? stM[1] : '健康' });
      });
    }
    return p;
  }

  // ─────────────────────────────────────────
  //  兵力格式化（供弹窗显示用）
  //  输入：{ 骑:3000, 步:2000 }
  //  输出：'骑 3000 · 步 2000'（按 步/弓/骑/水/蛮 顺序）
  // ─────────────────────────────────────────
  function formatTroops(troops) {
    if (!troops || typeof troops !== 'object') return '';
    const parts = TROOP_TYPES
      .filter(t => troops[t] != null && troops[t] > 0)
      .map(t => `${t} ${troops[t].toLocaleString()}`);
    return parts.join(' · ');
  }

  // ─────────────────────────────────────────
  //  GM 预览摘要
  // ─────────────────────────────────────────
  function summarize(parsed) {
    if (!parsed) return ['❌ 无法解析'];
    const lines = [];

    if (parsed.round) {
      lines.push(`<strong>🎴 回合：</strong><span class="pp-ok">第 ${parsed.round} 回合</span>`);
    }
    if (parsed.digest) {
      lines.push(`<strong>📡 速递：</strong><span class="pp-ok">${esc(parsed.digest)}</span>`);
    }

    lines.push(`<strong>👤 玩家识别：</strong><span class="${parsed.players.length ? 'pp-ok' : 'pp-nil'}">${parsed.players.length} 位</span>`);
    parsed.players.forEach(p => {
      const res = [];
      if (p.gold   != null) res.push(`💰${p.gold}`);
      if (p.food   != null) res.push(`🌾${p.food}`);
      if (p.troop  != null) res.push(`🛡️${p.troop}`);
      if (p.morale != null) res.push(`❤️${p.morale}`);
      if (p.cities != null) res.push(`🏯${p.cities}`);
      const genStr = p.generals.map(g => {
        const s = g.status !== '健康' ? `(${g.status[0]})` : '';
        return g.name + s;
      }).join('、') || '无';
      const cityStr = (p.cities_list || []).map(c => {
        let s = c.name;
        if (c.holder && c.holder !== '无') s += `[${c.holder}]`;
        const tf = formatTroops(c.troops);
        if (tf) s += `{${tf}}`;
        return s;
      }).join('、') || '—';
      lines.push(
        `&nbsp;&nbsp;[${p.slot || '?'}] <strong>${esc(p.name)}</strong>` +
        ` &nbsp;${res.join(' ') || '<span class="pp-nil">未识别资源</span>'}` +
        ` &nbsp;⚔️ ${esc(genStr)}` +
        ` &nbsp;🏯 ${esc(cityStr)}`
      );
    });

    if (parsed.npcCities && parsed.npcCities.length) {
      const npcStr = parsed.npcCities.slice(0,6).map(c =>
        c.name + (c.holder && c.holder !== '无' ? `[${c.holder}]` : '')
      ).join('、') + (parsed.npcCities.length > 6 ? `…等${parsed.npcCities.length}城` : '');
      lines.push(`<strong>🏯 NPC城池：</strong><span class="pp-ok">${esc(npcStr)}</span>`);
    }

    const bLen = (parsed.battles || []).length;
    lines.push(`<strong>🔥 战报：</strong><span class="${bLen ? 'pp-ok' : 'pp-nil'}">${bLen ? bLen + ' 场' : '本回合无战事'}</span>`);
    (parsed.battles || []).forEach(b => {
      const icon = b.result === '胜' ? '✅' : b.result === '负' ? '❌' : '🔶';
      lines.push(`&nbsp;&nbsp;${icon} ${esc(b.attacker)}→${esc(b.defender)} ${b.result} 攻损${b.attacker_loss}守损${b.defender_loss}`);
    });

    const owned = Object.keys(parsed.cityOwnership || {});
    if (owned.length) {
      const pc  = owned.filter(k => parsed.cityOwnership[k].owner !== 'npc').length;
      const nc  = owned.filter(k => parsed.cityOwnership[k].owner === 'npc').length;
      lines.push(`<strong>🗺️ 城池归属：</strong><span class="pp-ok">玩家 ${pc} 城 · NPC ${nc} 城（含守将/兵力）</span>`);
    }

    const garr = parsed.garrison || [];
    if (garr.length) {
      lines.push(`<strong>🏯 驻城武将：</strong><span class="pp-ok">${garr.length} 座城有调度</span>`);
      garr.forEach(g => {
        const genStr = g.generals.map(gn =>
          gn.taskDetail ? `${esc(gn.name)}(${esc(gn.taskDetail)})` : `${esc(gn.name)}(${esc(gn.role)})`
        ).join('、');
        lines.push(`&nbsp;&nbsp;🏙️ ${esc(g.cityName)}：${genStr}`);
      });
    }

    lines.push(`<strong>📜 剧情区：</strong><span class="pp-ok">${(parsed.rawDigest||'').length} 字符</span>`);
    return lines;
  }

  function esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  return { parse, summarize, formatTroops, TROOP_TYPES };
})();
