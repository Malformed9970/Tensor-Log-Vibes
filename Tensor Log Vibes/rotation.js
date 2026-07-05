// ============================================================================
// Tensor Log Vibes — rotation tab (XIVAnalysis-style)
// Per-player cast timeline:
//   · Boss row — the enemy cast timeline for mechanic context
//   · Buffs row — every status applied to the player (optional 20s-capped
//     approximate bands; the log has no buff-end events)
//   · GCD row — all weaponskills/spells in sequence, with drift markers on
//     gaps >25% over the median GCD interval
//   · one row per oGCD ability — each use plus a shaded recast bar
//     (overlapping bars stagger vertically for charge abilities)
//   · death shading — grey columns while the player is dead
//
// Icons, GCD/oGCD classification, recast and charge data come from
// xivapi.com (Action + Status sheets), cached in localStorage.
// ============================================================================

(function () {
    'use strict';

    const fileSelect = document.getElementById('rotationFileSelect');
    const playerSelect = document.getElementById('rotationPlayerSelect');
    const hideAuto = document.getElementById('rotationHideAuto');
    const showBuffs = document.getElementById('rotationShowBuffs');
    const zoomInBtn = document.getElementById('rotationZoomIn');
    const zoomOutBtn = document.getElementById('rotationZoomOut');
    const statusEl = document.getElementById('rotationStatus');
    const scrollEl = document.getElementById('rotationScroll');
    const trackEl = document.getElementById('rotationTrack');
    const emptyEl = document.getElementById('rotationEmpty');

    const XIVAPI = 'https://xivapi.com';
    const ACTION_CACHE_KEY = 'tlvActionCache3';
    const STATUS_CACHE_KEY = 'tlvStatusCache1';

    // ActionCategory IDs: 1 auto-attack, 2 spell, 3 weaponskill, 4 ability,
    // 9 limit break, 15 artillery. GCD = spell/weaponskill/LB.
    const GCD_CATS = new Set([2, 3, 9, 15]);
    const AUTO_NAMES = new Set(['attack', 'shot', 'auto-attack']);
    const AUTO_IDS = new Set(['7', '8']); // Attack / Shot — works before metadata loads

    const GUTTER = 180;       // label gutter; all time positions offset by this
    const BOSS_ROW_H = 54;    // 3 label lines + tick strip
    const BOSS_LINES = [3, 17, 31];
    const BUFF_ROW_H = 30;
    const GCD_ROW_H = 50;
    const OGCD_ROW_H = 32;
    const GCD_SIZE = 38;
    const OGCD_SIZE = 24;
    const BUFF_SIZE = 20;

    const S = {
        pps: 30,
        active: false,
        cursorTimer: null,
        renderTimer: null
    };

    // ---------------- metadata caches (Action + Status sheets) ----------------
    function loadCache(key) {
        try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) { return {}; }
    }
    const actionCache = loadCache(ACTION_CACHE_KEY);
    const statusCache = loadCache(STATUS_CACHE_KEY);

    const sessionFails = new Set();
    const inFlight = new Set();
    let fetchQueue = [];
    let activeFetches = 0;
    const saveTimers = {};

    function saveCache(key, obj) {
        clearTimeout(saveTimers[key]);
        saveTimers[key] = setTimeout(() => {
            try { localStorage.setItem(key, JSON.stringify(obj)); } catch (e) { /* full */ }
        }, 800);
    }

    function requestMeta(kind, id) {
        id = String(id);
        const key = kind + ':' + id;
        const cache = kind === 'action' ? actionCache : statusCache;
        if (cache[id] || sessionFails.has(key) || inFlight.has(key)) return;
        inFlight.add(key);
        fetchQueue.push({ kind, id, key });
        pumpFetches();
    }

    function pumpFetches() {
        while (activeFetches < 4 && fetchQueue.length) {
            const { kind, id, key } = fetchQueue.shift();
            activeFetches++;
            const url = kind === 'action'
                ? `${XIVAPI}/Action/${id}?columns=Name,Icon,ActionCategory.ID,Recast100ms,MaxCharges`
                : `${XIVAPI}/Status/${id}?columns=Name,Icon`;
            fetch(url)
                .then(r => r.ok ? r.json() : Promise.reject(new Error('http ' + r.status)))
                .then(j => {
                    if (kind === 'action') {
                        actionCache[id] = {
                            n: j.Name || '', i: j.Icon || '',
                            c: (j.ActionCategory && j.ActionCategory.ID) || 0,
                            r: j.Recast100ms || 0, mc: j.MaxCharges || 0
                        };
                        saveCache(ACTION_CACHE_KEY, actionCache);
                    } else {
                        statusCache[id] = { n: j.Name || '', i: j.Icon || '' };
                        saveCache(STATUS_CACHE_KEY, statusCache);
                    }
                })
                .catch(() => sessionFails.add(key))
                .finally(() => {
                    activeFetches--;
                    inFlight.delete(key);
                    pumpFetches();
                    scheduleRender();
                });
        }
    }

    // ---------------- data ----------------
    function currentPull() {
        return TLV.byFile.get(fileSelect.value) || null;
    }

    function playerNames(A) {
        const names = new Set(A.meta.party || []);
        for (const [, ent] of A.entities) {
            if (ent.isPlayer && ent.name) names.add(ent.name);
        }
        return [...names];
    }

    function playerEntityIds(A, name) {
        const ids = new Set();
        for (const [id, ent] of A.entities) {
            if (ent.isPlayer && ent.name === name) ids.add(id);
        }
        return ids;
    }

    function isAuto(cast) {
        if (AUTO_IDS.has(String(cast.castId))) return true;
        const meta = actionCache[String(cast.castId)];
        if (meta && meta.c === 1) return true;
        return AUTO_NAMES.has((cast.name || '').toLowerCase());
    }

    // 'gcd' | 'ogcd' | 'unknown' (unknown renders on the GCD row, grey)
    function laneOf(cast) {
        const meta = actionCache[String(cast.castId)];
        if (!meta || !meta.c) return 'unknown';
        return GCD_CATS.has(meta.c) ? 'gcd' : 'ogcd';
    }

    // Boss mechanic sequence: named enemy casts/channels, deduped when several
    // actors cast the same spell in the same instant.
    function bossActions(A) {
        const all = [...A.casts.filter(c => c.isBoss && !c.isPet && c.name),
        ...A.channels.filter(c => c.isBoss && !c.isPet && c.name)]
            .sort((a, b) => a.t - b.t);
        const seq = [];
        const lastByCast = new Map();
        for (const c of all) {
            const key = c.castId + '|' + c.name;
            const last = lastByCast.get(key);
            lastByCast.set(key, c.t);
            if (last !== undefined && c.t - last < 1.0) continue;
            seq.push(c);
        }
        return seq;
    }

    // ---------------- UI wiring ----------------
    function onDataLoaded() {
        populatePlayers();
        render();
    }

    function populatePlayers() {
        const A = currentPull();
        const prev = playerSelect.value;
        playerSelect.innerHTML = '';
        if (!A) return;
        const names = playerNames(A);
        names.forEach(n => {
            const opt = document.createElement('option');
            opt.value = n;
            opt.textContent = n;
            playerSelect.appendChild(opt);
        });
        if (names.includes(prev)) playerSelect.value = prev;
    }

    fileSelect.addEventListener('change', () => { populatePlayers(); render(); });
    playerSelect.addEventListener('change', render);
    [hideAuto, showBuffs].forEach(el => el.addEventListener('change', render));
    zoomInBtn.addEventListener('click', () => setZoom(S.pps * 1.5));
    zoomOutBtn.addEventListener('click', () => setZoom(S.pps / 1.5));

    function setZoom(pps) {
        const mid = (scrollEl.scrollLeft + scrollEl.clientWidth / 2 - GUTTER) / S.pps;
        S.pps = Math.max(6, Math.min(150, pps));
        render();
        scrollEl.scrollLeft = Math.max(0, GUTTER + mid * S.pps - scrollEl.clientWidth / 2);
    }

    function scheduleRender() {
        clearTimeout(S.renderTimer);
        S.renderTimer = setTimeout(render, 300);
    }

    function onTabChange(visible) {
        S.active = visible;
        clearInterval(S.cursorTimer);
        if (visible) {
            render();
            if (window.TLVReplay && TLVReplay.getFile() === fileSelect.value) {
                const x = GUTTER + TLVReplay.getTime() * S.pps;
                scrollEl.scrollLeft = Math.max(0, x - scrollEl.clientWidth / 2);
            }
            S.cursorTimer = setInterval(updateCursor, 300);
        }
    }

    // ---------------- render ----------------
    function esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function median(nums) {
        if (!nums.length) return NaN;
        const s = [...nums].sort((a, b) => a - b);
        const mid = s.length >> 1;
        return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    }

    function iconOrChipHtml(cast, meta, lane, x, y, size) {
        const id = String(cast.castId);
        const name = (meta && meta.n) || cast.name || `#${id}`;
        const laneLabel = lane === 'gcd' ? 'GCD' : lane === 'ogcd' ? 'oGCD' : 'unclassified';
        const title = `${esc(name)} (${id}) — ${laneLabel} @ ${TLVAnalysis.fmtTime(cast.t)}`;
        const left = Math.round(x - size / 2);
        if (meta && meta.i) {
            return `<img class="rot-icon rot-${lane}" src="${XIVAPI}${esc(meta.i)}" ` +
                `style="left:${left}px;top:${y}px;width:${size}px;height:${size}px" ` +
                `title="${title}" data-t="${cast.t}" loading="lazy">`;
        }
        return `<div class="rot-chip rot-${lane}" ` +
            `style="left:${left}px;top:${y}px;width:${size}px;height:${size}px" ` +
            `title="${title}" data-t="${cast.t}">${esc(name.slice(0, 4))}</div>`;
    }

    function render() {
        const A = currentPull();
        if (!A) {
            emptyEl.classList.remove('hidden');
            trackEl.classList.add('hidden');
            statusEl.textContent = '';
            return;
        }
        const player = playerSelect.value;
        const pIds = playerEntityIds(A, player);
        const all = A.casts.filter(c => pIds.has(c.srcId));
        if (!all.length) {
            emptyEl.classList.remove('hidden');
            emptyEl.textContent = player ? `No casts recorded for ${player}.` : 'Pick a player.';
            trackEl.classList.add('hidden');
            statusEl.textContent = '';
            return;
        }
        emptyEl.classList.add('hidden');
        trackEl.classList.remove('hidden');

        const casts = hideAuto.checked ? all.filter(c => !isAuto(c)) : all;
        const uniqueIds = new Set(casts.map(c => String(c.castId)));
        uniqueIds.forEach(id => requestMeta('action', id));
        const iconsLoaded = [...uniqueIds].filter(id => actionCache[id] && actionCache[id].i).length;

        // buffs on this player (dedupe identical id+timestamp entries)
        let buffApps = [];
        if (showBuffs.checked) {
            const seen = new Set();
            for (const b of A.buffs) {
                if (!pIds.has(b.entId)) continue;
                const key = b.buffId + '@' + b.t.toFixed(2);
                if (seen.has(key)) continue;
                seen.add(key);
                buffApps.push(b);
                requestMeta('status', b.buffId);
            }
        }

        // split: GCD/unknown share the top cast row; each oGCD action gets a row
        const gcdCasts = [];
        const byAction = new Map();
        for (const c of casts) {
            const lane = laneOf(c);
            if (lane === 'ogcd' || (isAuto(c) && !hideAuto.checked)) {
                const id = String(c.castId);
                if (!byAction.has(id)) byAction.set(id, { id, casts: [], meta: actionCache[id] });
                byAction.get(id).casts.push(c);
            } else {
                gcdCasts.push({ c, lane });
            }
        }
        const ogcdRows = [...byAction.values()].sort((a, b) =>
            b.casts.length - a.casts.length ||
            ((a.meta && a.meta.n) || a.casts[0].name || '').localeCompare((b.meta && b.meta.n) || b.casts[0].name || ''));

        const boss = bossActions(A);
        const width = GUTTER + Math.ceil(A.duration * S.pps) + 80;
        const xOf = t => GUTTER + t * S.pps;

        const parts = [];

        // ---- gridlines + full-height shading (buff bands, death columns) ----
        const step = S.pps < 12 ? 60 : S.pps < 40 ? 30 : 15;
        let axisInner = '';
        for (let t = 0; t <= A.duration; t += step) {
            const x = Math.round(xOf(t));
            parts.push(`<div class="rot-grid" style="left:${x}px"></div>`);
            axisInner += `<div class="rot-axis" style="left:${x + 3}px">${TLVAnalysis.fmtTime(t)}</div>`;
        }

        // death shading for this player
        let deathCount = 0;
        for (const id of pIds) {
            const ent = A.entities.get(id);
            if (!ent) continue;
            for (const [d0, d1] of ent.deadRanges) {
                deathCount++;
                parts.push(`<div class="rot-dead" style="left:${Math.round(xOf(d0))}px;width:${Math.max(3, Math.round((d1 - d0) * S.pps))}px" title="Dead ${TLVAnalysis.fmtTime(d0)} → ${TLVAnalysis.fmtTime(d1)}"></div>`);
                parts.push(`<div class="rot-dead-skull" style="left:${Math.round(xOf(d0)) + 2}px">💀</div>`);
            }
        }

        parts.push(`<div class="rot-axis-row" style="width:${width}px">${axisInner}</div>`);

        let rowsHtml = '';

        // ---- boss context row ----
        // 1) collapse consecutive repeats of the same cast into one "Name ×N"
        //    group spanning first→last use
        const bossGroups = [];
        for (const c of boss) {
            const last = bossGroups[bossGroups.length - 1];
            if (last && last.castId === c.castId && last.name === c.name && c.t - last.tEnd <= 6) {
                last.tEnd = c.t;
                last.count++;
            } else {
                bossGroups.push({ t: c.t, tEnd: c.t, name: c.name, castId: c.castId, srcName: c.srcName, count: 1 });
            }
        }
        // 2) greedy label placement across 3 lines; groups that don't fit
        //    render as tick-only markers (tooltip carries the name)
        const lineEnds = [-Infinity, -Infinity, -Infinity];
        let bossLabelHtml = '', bossTickHtml = '';
        let shownLabels = 0;
        for (const g of bossGroups) {
            const x = Math.round(xOf(g.t));
            const label = g.count > 1 ? `${g.name} ×${g.count}` : g.name;
            const title = `${esc(g.srcName)}: ${esc(g.name)}${g.count > 1 ? ` ×${g.count} (${TLVAnalysis.fmtTime(g.t)} → ${TLVAnalysis.fmtTime(g.tEnd)})` : ` @ ${TLVAnalysis.fmtTime(g.t)}`}`;
            const labelW = label.length * 6.2 + 12;
            let line = -1;
            for (let li = 0; li < BOSS_LINES.length; li++) {
                if (x >= lineEnds[li]) { line = li; break; }
            }
            // tick strip at the bottom shows true density regardless of labels
            bossTickHtml += `<div class="rot-boss-tick" style="left:${x}px" title="${title}" data-t="${g.t}"></div>`;
            if (g.count > 1) {
                bossTickHtml += `<div class="rot-boss-run" style="left:${x}px;width:${Math.max(2, Math.round((g.tEnd - g.t) * S.pps))}px"></div>`;
            }
            if (line !== -1) {
                lineEnds[line] = x + labelW;
                shownLabels++;
                bossLabelHtml += `<div class="rot-boss-mark" style="left:${x}px;top:${BOSS_LINES[line]}px" ` +
                    `title="${title}" data-t="${g.t}">${esc(label)}</div>`;
            }
        }
        rowsHtml += `<div class="rot-row rot-row-boss" style="height:${BOSS_ROW_H}px">` +
            `<span class="rot-row-label" title="Enemy casts — mechanic context. Repeats collapse to ×N; when labels don't fit at this zoom they become bottom ticks (hover for the name).">Boss <span class="muted">×${boss.length}${shownLabels < bossGroups.length ? ` (${bossGroups.length - shownLabels} as ticks)` : ''}</span></span>` +
            bossTickHtml + bossLabelHtml + '</div>';

        // ---- buffs row ----
        if (showBuffs.checked) {
            rowsHtml += `<div class="rot-row rot-row-buffs" style="height:${BUFF_ROW_H}px">` +
                `<span class="rot-row-label" title="Statuses applied to ${esc(player)} (application times are exact; the log has no expiry events)">Buffs <span class="muted">×${buffApps.length}</span></span>`;
            for (const b of buffApps) {
                const meta = statusCache[String(b.buffId)];
                const name = (meta && meta.n) || `Status ${b.buffId}`;
                const title = `${esc(name)} (${b.buffId}) from ${esc(b.ownerName || '?')} @ ${TLVAnalysis.fmtTime(b.t)}`;
                const left = Math.round(xOf(b.t) - BUFF_SIZE / 2);
                if (meta && meta.i) {
                    rowsHtml += `<img class="rot-icon rot-buff" src="${XIVAPI}${esc(meta.i)}" ` +
                        `style="left:${left}px;top:${(BUFF_ROW_H - BUFF_SIZE) / 2}px;width:${BUFF_SIZE}px;height:${BUFF_SIZE}px" ` +
                        `title="${title}" data-t="${b.t}" loading="lazy">`;
                } else {
                    rowsHtml += `<div class="rot-chip rot-buff" style="left:${left}px;top:${(BUFF_ROW_H - BUFF_SIZE) / 2}px;width:${BUFF_SIZE}px;height:${BUFF_SIZE}px" ` +
                        `title="${title}" data-t="${b.t}">${esc(String(b.buffId).slice(0, 3))}</div>`;
                }
            }
            rowsHtml += '</div>';
        }

        // ---- GCD row with drift markers ----
        // Drift math is meaningless while unclassified oGCDs still sit on the
        // GCD row, so wait until most casts have ActionCategory data.
        const unknownCount = gcdCasts.filter(g => g.lane === 'unknown').length;
        const classified = unknownCount <= casts.length * 0.1;
        const times = gcdCasts.map(g => g.c.t);
        const intervals = [];
        for (let i = 1; i < times.length; i++) intervals.push(times[i] - times[i - 1]);
        const med = classified ? median(intervals) : NaN;
        let driftTotal = 0, driftGaps = 0;
        let driftHtml = '';
        if (!isNaN(med) && med > 1) {
            const threshold = Math.max(med * 1.25, med + 0.15);
            for (let i = 1; i < times.length; i++) {
                const gap = times[i] - times[i - 1];
                if (gap <= threshold) continue;
                driftGaps++;
                driftTotal += Math.min(gap - med, 10); // cap so downtime doesn't dominate
                const x0 = xOf(times[i - 1] + med);
                const w = Math.max(3, Math.round((gap - med) * S.pps));
                const prevName = (actionCache[String(gcdCasts[i - 1].c.castId)] || {}).n || gcdCasts[i - 1].c.name || '';
                driftHtml += `<div class="rot-drift" style="left:${Math.round(x0)}px;width:${w}px" ` +
                    `title="+${(gap - med).toFixed(2)}s gap after ${esc(prevName)} @ ${TLVAnalysis.fmtTime(times[i - 1])}" data-t="${times[i - 1]}"></div>`;
            }
        }
        rowsHtml += `<div class="rot-row rot-row-gcd" style="height:${GCD_ROW_H}px">` +
            `<span class="rot-row-label" title="All weaponskills and spells, in sequence. Red segments = gaps >25% over the median GCD interval (${isNaN(med) ? '?' : med.toFixed(2)}s)">GCD <span class="muted">×${gcdCasts.length}</span></span>` +
            driftHtml;
        for (const { c, lane } of gcdCasts) {
            rowsHtml += iconOrChipHtml(c, actionCache[String(c.castId)], lane, xOf(c.t), (GCD_ROW_H - GCD_SIZE) / 2, GCD_SIZE);
        }
        rowsHtml += '</div>';

        // ---- one row per oGCD ability, recast bars stagger for charges ----
        for (const row of ogcdRows) {
            const meta = row.meta;
            const name = (meta && meta.n) || row.casts[0].name || `#${row.id}`;
            const recastS = meta && meta.r ? meta.r / 10 : 0;
            const charges = meta && meta.mc ? meta.mc : 0;
            const labelIcon = meta && meta.i ? `<img class="rot-label-icon" src="${XIVAPI}${esc(meta.i)}">` : '';
            const labelTitle = `${esc(name)} (${row.id})` +
                (recastS ? ` — ${recastS.toFixed(0)}s recast` : '') +
                (charges > 1 ? `, ${charges} charges` : '');
            rowsHtml += `<div class="rot-row" style="height:${OGCD_ROW_H}px">` +
                `<span class="rot-row-label" title="${labelTitle}">${labelIcon}${esc(name)} <span class="muted">×${row.casts.length}${charges > 1 ? ` (${charges}c)` : ''}</span></span>`;
            if (recastS > 2) {
                // overlapping bars (charge abilities) stagger onto a second level
                const levelEnds = [-Infinity, -Infinity];
                for (const c of row.casts) {
                    let lvl = levelEnds.findIndex(end => c.t >= end);
                    if (lvl === -1) lvl = levelEnds[0] <= levelEnds[1] ? 0 : 1;
                    levelEnds[lvl] = c.t + recastS;
                    const bw = Math.max(2, Math.round(recastS * S.pps));
                    rowsHtml += `<div class="rot-cd" style="left:${Math.round(xOf(c.t))}px;width:${bw}px;bottom:${3 + lvl * 5}px"></div>`;
                }
            }
            for (const c of row.casts) {
                rowsHtml += iconOrChipHtml(c, meta, isAuto(c) ? 'unknown' : 'ogcd', xOf(c.t), (OGCD_ROW_H - OGCD_SIZE) / 2, OGCD_SIZE);
            }
            rowsHtml += '</div>';
        }

        parts.push(rowsHtml);
        parts.push(`<div class="rotation-cursor" id="rotationCursor"></div>`);

        trackEl.style.width = width + 'px';
        trackEl.innerHTML = parts.join('');

        statusEl.textContent =
            `${casts.length} casts · GCD ×${gcdCasts.length}` +
            (isNaN(med) ? '' : ` (median ${med.toFixed(2)}s)`) +
            (driftGaps ? ` · drift ≈ ${driftTotal.toFixed(1)}s over ${driftGaps} gaps` : '') +
            ` · ${ogcdRows.length} oGCD rows · icons ${iconsLoaded}/${uniqueIds.size}` +
            (deathCount ? ` · 💀 ×${deathCount}` : '') +
            (hideAuto.checked && all.length !== casts.length ? ` · ${all.length - casts.length} auto-attacks hidden` : '');

        updateCursor();
    }

    // click any icon/chip/marker → jump the replay there
    trackEl.addEventListener('click', e => {
        const el = e.target.closest('[data-t]');
        if (!el || !window.TLVReplay) return;
        TLVReplay.jumpTo(fileSelect.value, parseFloat(el.dataset.t));
    });

    function updateCursor() {
        const cursor = document.getElementById('rotationCursor');
        if (!cursor || !window.TLVReplay) return;
        const sameFile = TLVReplay.getFile() === fileSelect.value;
        cursor.style.display = sameFile ? 'block' : 'none';
        if (!sameFile) return;
        cursor.style.left = Math.round(GUTTER + TLVReplay.getTime() * S.pps) + 'px';
    }

    window.TLVRotation = {
        onDataLoaded,
        onTabChange
    };
})();
