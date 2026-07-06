// ============================================================================
// Tensor Log Vibes 2 — analysis layer
// Builds per-pull derived data from parsedEvents and renders:
//   - Pull summary cards
//   - Reaction lifecycle (Gantt + tables)
//   - Cross-pull compare
//   - Cast consequence inspector
// ============================================================================

window.TLV = { byFile: new Map(), metas: [] };

(function () {
    'use strict';

    const DEAD_ANIM_ID = '73'; // battle/dead_pose

    // ---------------- helpers ----------------
    function fmtTime(t) {
        if (t === null || t === undefined || isNaN(t)) return '-';
        const m = Math.floor(t / 60);
        const s = (t % 60).toFixed(1).padStart(4, '0');
        return `${m}:${s}`;
    }

    function esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // binary search: first index in arr (sorted by .t) with .t >= t
    function lowerBound(arr, t) {
        let lo = 0, hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid].t < t) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    function median(nums) {
        if (!nums.length) return NaN;
        const s = [...nums].sort((a, b) => a - b);
        const mid = s.length >> 1;
        return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    }

    // ---------------- build ----------------
    function build(events, metas) {
        TLV.byFile = new Map();
        TLV.metas = metas || [];

        for (const meta of TLV.metas) {
            TLV.byFile.set(meta.file, {
                meta,
                entities: new Map(),   // id -> {id,name,cid,isPlayer,samples:[{t,x,z,h}],deadRanges:[]}
                casts: [],             // boss + player casts {t,castId,name,srcId,srcName,isBoss}
                channels: [],          // {t,castId,name,dur,srcId,srcName,isBoss}
                aoes: [],              // {t,o:payloadObj}
                markers: [],           // {t,markerId,entId,entName}
                tethers: [],           // {t0,t1,srcId,srcName,tgtId,tgtName,tetherId}
                buffs: [],             // {t,entId,buffId,ownerId,ownerName}
                vfx: [],               // {t,n,entId}
                damage: [],            // {t,castId,name,srcName,tgtName,amount}
                deaths: [],            // {t,entId,name,isPlayer}
                reactions: [],         // {name,tQueue,tExec,tDequeue}
                eventsIdx: [],         // refs to this file's events, log order
                duration: 0,           // mechanic (synced) time — drives replay/gantt/compare
                durationReal: 0,       // real time — actual pull length
                center: { x: 100, z: 100 },
                viewRadius: 25,
                progPoint: null
            });
        }

        const openTethers = new Map();   // file -> Map(srcId|tetherId -> tether)
        const openReactions = new Map(); // file -> Map(name -> [instances])

        for (const ev of events) {
            const A = TLV.byFile.get(ev.file);
            if (!A) continue;
            A.eventsIdx.push(ev);
            const t = ev.tNum;
            const hasT = !isNaN(t);
            if (hasT && t > A.duration) A.duration = t;
            if (!isNaN(ev.rtNum) && ev.rtNum > A.durationReal) A.durationReal = ev.rtNum;

            // entity samples from structured positions
            if (ev.positions && hasT) {
                for (const p of ev.positions) {
                    if (!p.id || p.id === '0' || p.id === 'nil') continue;
                    let ent = A.entities.get(p.id);
                    if (!ent) {
                        ent = { id: p.id, name: p.name, cid: p.cid, isPlayer: p.cid === '0', samples: [], deadRanges: [], _openDead: null };
                        A.entities.set(p.id, ent);
                    }
                    if (p.name && !ent.name) ent.name = p.name;
                    const last = ent.samples[ent.samples.length - 1];
                    if (!last || last.t !== t || last.x !== p.x || last.z !== p.z) {
                        ent.samples.push({ t, x: p.x, z: p.z, h: p.h });
                    }
                }
            }

            switch (ev.type) {
                case 'OnEntityCast': {
                    if (!hasT) break;
                    const cid = ev.payload['Entity ContentID'];
                    A.casts.push({
                        t, castId: ev.payload['Cast ID'] || '',
                        name: ev.payload['Cast Name'] || '',
                        srcId: ev.payload['Entity ID'] || '',
                        srcName: ev.payload['Entity Name'] || '',
                        tgtId: ev.payload['Main Target ID'] || '',
                        nt: parseInt(ev.payload['Num Targets'], 10) || 0,
                        isBoss: cid !== undefined && cid !== '0',
                        evId: ev.id
                    });
                    break;
                }
                case 'OnEntityChannel': {
                    if (!hasT) break;
                    const cid = ev.payload['Caster ContentID'];
                    A.channels.push({
                        t, castId: ev.payload['Channel ID'] || '',
                        name: ev.payload['Cast Name'] || '',
                        dur: parseFloat(ev.payload['Channel Time Max']) || 0,
                        srcId: ev.payload['Caster ID'] || '',
                        srcName: ev.payload['Caster Name'] || '',
                        isBoss: cid !== undefined && cid !== '0',
                        evId: ev.id
                    });
                    break;
                }
                case 'onAOECreate': {
                    if (hasT && ev.payloadObj) A.aoes.push({ t, o: ev.payloadObj, evId: ev.id });
                    break;
                }
                case 'OnEntityMarkerAdd': {
                    if (!hasT) break;
                    A.markers.push({
                        t,
                        markerId: ev.payload['Marker ID'] || '?',
                        entId: ev.payload['Entity ID'] || '',
                        entName: ev.payload['Entity Name'] || ''
                    });
                    break;
                }
                case 'OnTetherChange': {
                    if (!hasT) break;
                    const m = ev.payloadRaw.match(/Source Ent:\s*(.+?)\s*\[(\d+)\]\s+TetherID:\s*(\d+)\s*->\s*(\d+)\s+Target Ent:\s*(.+?)\s*\[(\d+)\]\s*->\s*(.+?)\s*\[(\d+)\]/);
                    if (!m) break;
                    const [, srcName, srcId, oldTid, newTid, , , newTgtName, newTgtId] = m;
                    if (!openTethers.has(ev.file)) openTethers.set(ev.file, new Map());
                    const open = openTethers.get(ev.file);
                    if (newTid !== '0') {
                        const tether = { t0: t, t1: null, srcId, srcName, tgtId: newTgtId, tgtName: newTgtName, tetherId: newTid };
                        A.tethers.push(tether);
                        open.set(srcId + '|' + newTid, tether);
                    } else if (oldTid !== '0') {
                        const key = srcId + '|' + oldTid;
                        const tether = open.get(key);
                        if (tether && tether.t1 === null) tether.t1 = t;
                        open.delete(key);
                    }
                    break;
                }
                case 'onAddEntityVFX': {
                    if (!hasT) break;
                    A.vfx.push({ t, n: ev.payload['VFX Name'] || '', entId: ev.payload['Primary Entity ID'] || '' });
                    break;
                }
                case 'OnNewBuffEntry': {
                    if (!hasT) break;
                    A.buffs.push({
                        t,
                        entId: ev.payload['Entity ID'] || '',
                        buffId: ev.payload['Buff ID'] || '',
                        ownerId: ev.payload['Owner ID'] || '',
                        ownerName: ev.payload['Owner Name'] || ''
                    });
                    break;
                }
                case 'OnEntityDamage': {
                    if (!hasT) break;
                    A.damage.push({
                        t, castId: ev.payload['Cast ID'] || '',
                        name: ev.payload['Cast Name'] || '',
                        srcName: ev.payload['Source Name'] || '',
                        srcId: ev.payload['Source ID'] || '',
                        srcCid: ev.payload['Source ContentID'] || '',
                        tgtName: ev.payload['Target Name'] || '',
                        tgtCid: ev.payload['Target ContentID'] || '',
                        amount: parseInt(ev.payload['Amount'], 10) || 0
                    });
                    break;
                }
                case 'OnAnimationChange': {
                    if (!hasT) break;
                    const newAnim = ev.payload['newAnimID'];
                    const oldAnim = ev.payload['oldAnimID'];
                    const entId = ev.payload['Entity ID'];
                    if (!entId) break;
                    if (newAnim === DEAD_ANIM_ID) {
                        const cid = ev.payload['Entity ContentID'];
                        const ent = A.entities.get(entId);
                        A.deaths.push({ t, entId, name: ev.payload['Entity Name'] || '', isPlayer: cid === '0' });
                        if (ent && ent._openDead === null) ent._openDead = t;
                    } else if (oldAnim === DEAD_ANIM_ID) {
                        const ent = A.entities.get(entId);
                        if (ent && ent._openDead !== null) {
                            ent.deadRanges.push([ent._openDead, t]);
                            ent._openDead = null;
                        }
                    }
                    break;
                }
                case 'Queueing reaction': {
                    if (!hasT || !ev.reactionName) break;
                    if (!openReactions.has(ev.file)) openReactions.set(ev.file, new Map());
                    const open = openReactions.get(ev.file);
                    const inst = { name: ev.reactionName, tQueue: t, tExec: null, tDequeue: null };
                    A.reactions.push(inst);
                    if (!open.has(ev.reactionName)) open.set(ev.reactionName, []);
                    open.get(ev.reactionName).push(inst);
                    break;
                }
                case 'Executed reaction': {
                    if (!hasT || !ev.reactionName) break;
                    const open = openReactions.get(ev.file);
                    const list = open && open.get(ev.reactionName);
                    if (list) {
                        const inst = list.find(i => i.tExec === null && i.tDequeue === null);
                        if (inst) inst.tExec = t;
                    }
                    break;
                }
                case 'Dequeueing action': {
                    if (!hasT || !ev.reactionName) break;
                    const open = openReactions.get(ev.file);
                    const list = open && open.get(ev.reactionName);
                    if (list) {
                        const idx = list.findIndex(i => i.tDequeue === null);
                        if (idx > -1) {
                            list[idx].tDequeue = t;
                            list.splice(idx, 1);
                        }
                    }
                    break;
                }
            }
        }

        // close dangling dead ranges + compute arena center / radius / prog point
        for (const [, A] of TLV.byFile) {
            let sumX = 0, sumZ = 0, n = 0;
            for (const [, ent] of A.entities) {
                if (ent._openDead !== null) {
                    ent.deadRanges.push([ent._openDead, A.duration]);
                    ent._openDead = null;
                }
                if (ent.isPlayer) {
                    for (let i = 0; i < ent.samples.length; i += 5) {
                        sumX += ent.samples[i].x;
                        sumZ += ent.samples[i].z;
                        n++;
                    }
                }
            }
            if (n > 20) {
                A.center = { x: Math.round(sumX / n * 2) / 2, z: Math.round(sumZ / n * 2) / 2 };
            }
            // view radius: 97th percentile of player distance to center
            const dists = [];
            for (const [, ent] of A.entities) {
                if (!ent.isPlayer) continue;
                for (let i = 0; i < ent.samples.length; i += 10) {
                    const s = ent.samples[i];
                    dists.push(Math.hypot(s.x - A.center.x, s.z - A.center.z));
                }
            }
            if (dists.length > 20) {
                dists.sort((a, b) => a - b);
                A.viewRadius = Math.max(15, Math.ceil(dists[Math.floor(dists.length * 0.97)]) + 4);
            }

            // ---- pet detection (behavioral, no hardcoded names) ----
            // Hostiles: damaged a player, spawned a hostile AOE, or were
            // main-targeted by a player cast (players can only target enemies).
            const hostileIds = new Set();
            for (const d of A.damage) {
                if (d.srcCid && d.srcCid !== '0' && d.tgtCid === '0' && d.srcId) hostileIds.add(d.srcId);
            }
            for (const a of A.aoes) {
                if (a.o.friendly === false && a.o.entityID) hostileIds.add(String(a.o.entityID));
            }
            for (const c of A.casts) {
                if (!c.isBoss && c.tgtId) {
                    const tgt = A.entities.get(c.tgtId);
                    if (tgt && !tgt.isPlayer) hostileIds.add(c.tgtId);
                }
            }
            const hostileNames = new Set();
            hostileIds.forEach(id => {
                const e = A.entities.get(id);
                if (e && e.name) hostileNames.add(e.name);
            });
            for (const [id, e] of A.entities) {
                if (e.name && hostileNames.has(e.name)) hostileIds.add(id);
            }

            // Pets: non-player entities whose casts main-target a hostile, or
            // that spawned friendly AOEs — with no hostile evidence themselves.
            // Anything ambiguous stays boss-side.
            const petSeedIds = new Set();
            for (const c of A.casts) {
                if (c.isBoss && c.tgtId && hostileIds.has(c.tgtId) && !hostileIds.has(c.srcId)) {
                    petSeedIds.add(c.srcId);
                }
            }
            for (const a of A.aoes) {
                const eid = String(a.o.entityID || '');
                if (a.o.friendly === true && eid && !hostileIds.has(eid)) petSeedIds.add(eid);
            }
            // Support pets (Liturgic Bell etc): non-player entities whose casts
            // only ever main-target themselves or players, with multi-target
            // casts or an action name a player also cast — and no hostile
            // evidence (anything that harms players always logs damage).
            const supportCandidates = new Map(); // srcId -> {ok, maxNt, names}
            for (const c of A.casts) {
                if (!c.isBoss || !c.srcId) continue;
                let cand = supportCandidates.get(c.srcId);
                if (!cand) {
                    cand = { ok: true, maxNt: 0, names: new Set() };
                    supportCandidates.set(c.srcId, cand);
                }
                const tgt = c.tgtId ? A.entities.get(c.tgtId) : null;
                if (!(c.tgtId === c.srcId || (tgt && tgt.isPlayer))) cand.ok = false;
                cand.maxNt = Math.max(cand.maxNt, c.nt);
                if (c.name) cand.names.add(c.name);
            }
            const playerCastNames = new Set(A.casts.filter(c => !c.isBoss && c.name).map(c => c.name));
            for (const [id, cand] of supportCandidates) {
                if (!cand.ok || hostileIds.has(id)) continue;
                const nameOverlap = [...cand.names].some(n => playerCastNames.has(n));
                if (cand.maxNt >= 4 || nameOverlap) petSeedIds.add(id);
            }
            const petNames = new Set();
            petSeedIds.forEach(id => {
                const e = A.entities.get(id);
                // players place friendly ground AOEs too — they are not pets
                if (e && !e.isPlayer && e.name && !hostileNames.has(e.name)) petNames.add(e.name);
            });
            const petIds = new Set();
            for (const [id, e] of A.entities) {
                if (e.isPlayer) continue;
                if ((e.name && petNames.has(e.name)) || (petSeedIds.has(id) && !hostileIds.has(id))) {
                    petIds.add(id);
                    e.isPet = true;
                }
            }
            A.petIds = petIds;
            A.petNames = petNames;
            for (const c of A.casts) c.isPet = petIds.has(c.srcId);
            for (const c of A.channels) c.isPet = petIds.has(c.srcId);

            const bossActions = [...A.casts.filter(c => c.isBoss && !c.isPet && c.name),
            ...A.channels.filter(c => c.isBoss && !c.isPet && c.name)];
            bossActions.sort((a, b) => a.t - b.t);
            A.progPoint = bossActions.length ? bossActions[bossActions.length - 1] : null;
        }

        renderSummaryStrip();
        populateFileSelects();
        renderReactions();
    }

    // ---------------- pull summary strip ----------------
    function renderSummaryStrip() {
        const strip = document.getElementById('summaryStrip');
        if (!TLV.byFile.size) {
            strip.classList.add('hidden');
            return;
        }
        strip.classList.remove('hidden');
        strip.innerHTML = '';

        for (const [file, A] of TLV.byFile) {
            const playerDeaths = A.deaths.filter(d => d.isPlayer);
            const deathsByName = {};
            playerDeaths.forEach(d => { deathsByName[d.name] = (deathsByName[d.name] || 0) + 1; });
            const deathTooltip = Object.entries(deathsByName).map(([n, c]) => `${n}: ${c}`).join('\n') || 'No deaths';

            const card = document.createElement('div');
            card.className = 'summary-card' + (activeFilters.files.has(file) ? ' active' : '');
            card.title = `${file}\n${A.meta.dutyName || ''}\nClick to filter the events table to this pull`;
            card.innerHTML = `
                <div class="sc-file">${esc(file.replace(/\.lua$/, ''))}</div>
                <div class="sc-duty">${esc(A.meta.dutyName || 'Unknown duty')}</div>
                <div class="sc-row">
                    <span class="sc-stat" title="Pull length (real time)">⏱ ${fmtTime(A.durationReal || A.duration)}</span>
                    <span class="sc-stat sc-deaths" title="${esc(deathTooltip)}">💀 ${playerDeaths.length}</span>
                </div>
                <div class="sc-prog" title="Prog point: last boss action seen (raw synced timestamp)">
                    ${A.progPoint ? `▸ ${esc(A.progPoint.name)} <span class="muted">@ ${A.progPoint.t.toFixed(1)}</span>` : '▸ —'}
                </div>`;
            card.addEventListener('click', () => window.toggleFileFilter(file));
            strip.appendChild(card);
        }
    }

    // ---------------- shared file selects ----------------
    function populateFileSelects() {
        const files = [...TLV.byFile.keys()];
        for (const selId of ['replayFileSelect', 'reactionsFileSelect', 'rotationFileSelect']) {
            const sel = document.getElementById(selId);
            const prev = sel.value;
            sel.innerHTML = '';
            files.forEach(f => {
                const opt = document.createElement('option');
                opt.value = f;
                opt.textContent = f.replace(/\.lua$/, '');
                sel.appendChild(opt);
            });
            if (files.includes(prev)) sel.value = prev;
        }
    }

    // ---------------- reactions tab ----------------
    const reactionsFileSelect = document.getElementById('reactionsFileSelect');
    const reactionsSearch = document.getElementById('reactionsSearch');
    const ganttCanvas = document.getElementById('ganttCanvas');

    reactionsFileSelect.addEventListener('change', renderReactions);
    reactionsSearch.addEventListener('input', renderReactions);

    function reactionOutcome(inst) {
        if (inst.tExec !== null) return 'executed';
        if (inst.tDequeue !== null) return 'stale';
        return 'open';
    }

    function renderReactions() {
        const file = reactionsFileSelect.value;
        const A = TLV.byFile.get(file);
        const instBody = document.getElementById('reactionInstanceBody');
        const sumBody = document.getElementById('reactionSummaryBody');
        const stats = document.getElementById('lifecycleStats');
        instBody.innerHTML = '';
        sumBody.innerHTML = '';
        stats.innerHTML = '';
        if (!A) return;

        const term = reactionsSearch.value.toLowerCase();
        const insts = A.reactions.filter(r => !term || r.name.toLowerCase().includes(term));

        // stats
        const nExec = insts.filter(i => i.tExec !== null).length;
        const nStale = insts.filter(i => i.tExec === null && i.tDequeue !== null).length;
        stats.innerHTML = `
            <span class="ls-chip">Queued <b>${insts.length}</b></span>
            <span class="ls-chip ls-ok">Executed <b>${nExec}</b></span>
            <span class="ls-chip ls-bad" title="Queued but dequeued stale without ever executing — the condition never went true">Never executed <b>${nStale}</b></span>`;

        // instance table (chronological)
        const frag = document.createDocumentFragment();
        insts.forEach(inst => {
            const tr = document.createElement('tr');
            const outcome = reactionOutcome(inst);
            const latency = inst.tExec !== null ? (inst.tExec - inst.tQueue) : null;
            tr.className = `rx-${outcome}`;
            tr.innerHTML = `
                <td class="rx-name" title="${esc(inst.name)}">${esc(inst.name)}</td>
                <td class="col-time">${fmtTime(inst.tQueue)}</td>
                <td class="col-time">${inst.tExec !== null ? fmtTime(inst.tExec) : '—'}</td>
                <td class="col-time">${latency !== null ? '+' + latency.toFixed(3) + 's' : '—'}</td>
                <td><span class="badge ${outcome === 'executed' ? 'badge-aura' : outcome === 'stale' ? 'badge-cast' : 'badge-default'}">${outcome === 'stale' ? 'never executed' : outcome}</span></td>`;
            tr.addEventListener('dblclick', () => {
                if (window.TLVReplay) TLVReplay.jumpTo(file, inst.tQueue);
            });
            frag.appendChild(tr);
        });
        instBody.appendChild(frag);

        // per-name summary
        const byName = new Map();
        insts.forEach(inst => {
            if (!byName.has(inst.name)) byName.set(inst.name, []);
            byName.get(inst.name).push(inst);
        });
        const sumRows = [...byName.entries()].map(([name, list]) => {
            const latencies = list.filter(i => i.tExec !== null).map(i => i.tExec - i.tQueue);
            return {
                name,
                queued: list.length,
                executed: list.filter(i => i.tExec !== null).length,
                stale: list.filter(i => i.tExec === null && i.tDequeue !== null).length,
                med: median(latencies),
                max: latencies.length ? Math.max(...latencies) : NaN
            };
        }).sort((a, b) => b.stale - a.stale || b.queued - a.queued);

        const frag2 = document.createDocumentFragment();
        sumRows.forEach(r => {
            const tr = document.createElement('tr');
            if (r.stale > 0 && r.executed === 0) tr.className = 'rx-stale';
            tr.innerHTML = `
                <td class="rx-name" title="${esc(r.name)}">${esc(r.name)}</td>
                <td>${r.queued}</td>
                <td>${r.executed}</td>
                <td>${r.stale > 0 ? `<b class="danger-text">${r.stale}</b>` : '0'}</td>
                <td class="col-time">${isNaN(r.med) ? '—' : '+' + r.med.toFixed(3) + 's'}</td>
                <td class="col-time">${isNaN(r.max) ? '—' : '+' + r.max.toFixed(3) + 's'}</td>`;
            frag2.appendChild(tr);
        });
        sumBody.appendChild(frag2);

        renderGantt(A, insts);
    }

    function renderGantt(A, insts) {
        const wrap = ganttCanvas.parentElement;
        const byName = new Map();
        insts.forEach(inst => {
            if (!byName.has(inst.name)) byName.set(inst.name, []);
            byName.get(inst.name).push(inst);
        });
        const lanes = [...byName.entries()].sort((a, b) => b[1].length - a[1].length);

        const LANE_H = 18, LABEL_W = 240, TOP = 22;
        const width = wrap.clientWidth || 900;
        const height = TOP + lanes.length * LANE_H + 8;
        ganttCanvas.width = width;
        ganttCanvas.height = height;
        ganttCanvas.style.height = height + 'px';

        const ctx = ganttCanvas.getContext('2d');
        ctx.clearRect(0, 0, width, height);
        if (!lanes.length || A.duration <= 0) return;

        const plotW = width - LABEL_W - 10;
        const xOf = t => LABEL_W + (t / A.duration) * plotW;

        // time axis
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.font = '10px "Fira Code", monospace';
        const step = A.duration > 600 ? 120 : A.duration > 240 ? 60 : 30;
        for (let t = 0; t <= A.duration; t += step) {
            const x = xOf(t);
            ctx.fillRect(x, TOP - 6, 1, height - TOP);
            ctx.fillText(fmtTime(t), x + 2, 12);
        }

        lanes.forEach(([name, list], i) => {
            const y = TOP + i * LANE_H;
            ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.045)';
            ctx.fillRect(0, y, width, LANE_H - 2);

            ctx.fillStyle = 'rgba(240,242,245,0.75)';
            ctx.font = '11px Inter, sans-serif';
            let label = name.length > 34 ? name.slice(0, 33) + '…' : name;
            ctx.fillText(label, 6, y + 12);

            list.forEach(inst => {
                const tEnd = inst.tDequeue !== null ? inst.tDequeue : (inst.tExec !== null ? inst.tExec : inst.tQueue + 0.3);
                const x0 = xOf(inst.tQueue);
                const x1 = Math.max(x0 + 2, xOf(tEnd));
                const outcome = reactionOutcome(inst);
                ctx.fillStyle = outcome === 'executed' ? 'rgba(16,185,129,0.85)'
                    : outcome === 'stale' ? 'rgba(239,68,68,0.85)'
                        : 'rgba(245,158,11,0.85)';
                ctx.fillRect(x0, y + 3, x1 - x0, LANE_H - 8);
                if (inst.tExec !== null) {
                    ctx.fillStyle = '#fff';
                    ctx.fillRect(xOf(inst.tExec), y + 2, 1.5, LANE_H - 6);
                }
            });
        });
    }

    // ---------------- cast consequence inspector ----------------
    const inspectorPanel = document.getElementById('inspectorPanel');
    const inspectorBody = document.getElementById('inspectorBody');
    const inspectorTitle = document.getElementById('inspectorTitle');
    const inspectorSubtitle = document.getElementById('inspectorSubtitle');
    const inspectorWindow = document.getElementById('inspectorWindow');
    let inspectorState = null; // {castId, name}

    document.getElementById('inspectorClose').addEventListener('click', () => {
        inspectorPanel.classList.add('hidden');
        inspectorState = null;
    });
    inspectorWindow.addEventListener('change', () => {
        if (inspectorState) renderInspector();
    });

    function openInspectorFromEvent(eventId) {
        const ev = parsedEvents[eventId];
        if (!ev) return;
        const castId = ev.payload['Cast ID'] || ev.payload['Channel ID'];
        const name = ev.payload['Cast Name'] || '';
        if (!castId) return;
        inspectorState = { castId, name };
        inspectorPanel.classList.remove('hidden');
        renderInspector();
    }

    function renderInspector() {
        const { castId, name } = inspectorState;
        const W = Math.max(1, parseFloat(inspectorWindow.value) || 8);
        inspectorTitle.textContent = name || `Cast ${castId}`;
        inspectorSubtitle.textContent = `Cast ID ${castId} — everything within ${W}s after each occurrence, across all loaded pulls`;

        // find occurrences per file (casts + channels, deduped within 1s)
        const occurrences = []; // {file, t}
        for (const [file, A] of TLV.byFile) {
            const hits = [
                ...A.casts.filter(c => String(c.castId) === String(castId)),
                ...A.channels.filter(c => String(c.castId) === String(castId))
            ].sort((a, b) => a.t - b.t);
            let lastT = -Infinity;
            for (const h of hits) {
                if (h.t - lastT < 1.0) { lastT = h.t; continue; }
                lastT = h.t;
                occurrences.push({ file, t: h.t });
            }
        }

        if (!occurrences.length) {
            inspectorBody.innerHTML = '<p class="muted">No occurrences found.</p>';
            return;
        }

        // aggregate consequences
        const aoeAgg = new Map(), markerAgg = new Map(), vfxAgg = new Map(), dmgAgg = new Map(), tetherAgg = new Map();

        function agg(map, key, mk, offset) {
            if (!map.has(key)) map.set(key, { ...mk, count: 0, offsets: [] });
            const e = map.get(key);
            e.count++;
            e.offsets.push(offset);
        }

        for (const occ of occurrences) {
            const A = TLV.byFile.get(occ.file);
            const t0 = occ.t, t1 = occ.t + W;

            let i = lowerBound(A.aoes, t0);
            for (; i < A.aoes.length && A.aoes[i].t <= t1; i++) {
                const o = A.aoes[i].o;
                agg(aoeAgg, `${o.aoeID}|${o.aoeCastType}`, {
                    name: o.aoeName || `AOE ${o.aoeID}`, aoeID: o.aoeID, castType: o.aoeCastType,
                    length: o.aoeLength, width: o.aoeWidth, duration: o.duration
                }, A.aoes[i].t - t0);
            }
            i = lowerBound(A.markers, t0);
            for (; i < A.markers.length && A.markers[i].t <= t1; i++) {
                const m = A.markers[i];
                agg(markerAgg, m.markerId, { markerId: m.markerId, targets: new Set() }, m.t - t0);
                markerAgg.get(m.markerId).targets.add(m.entName || m.entId);
            }
            i = lowerBound(A.vfx, t0);
            for (; i < A.vfx.length && A.vfx[i].t <= t1; i++) {
                agg(vfxAgg, A.vfx[i].n, { name: A.vfx[i].n }, A.vfx[i].t - t0);
            }
            i = lowerBound(A.damage, t0);
            for (; i < A.damage.length && A.damage[i].t <= t1; i++) {
                const d = A.damage[i];
                const key = d.castId + '|' + d.name;
                agg(dmgAgg, key, { name: d.name || `Cast ${d.castId}`, castId: d.castId, total: 0 }, d.t - t0);
                dmgAgg.get(key).total += d.amount;
            }
            // tethers opening in window (tethers sorted by t0 by construction)
            for (const th of A.tethers) {
                if (th.t0 >= t0 && th.t0 <= t1) {
                    agg(tetherAgg, th.tetherId, { tetherId: th.tetherId, pairs: new Set() }, th.t0 - t0);
                    tetherAgg.get(th.tetherId).pairs.add(`${th.srcName} → ${th.tgtName}`);
                }
            }
        }

        const nOcc = occurrences.length;
        const avgOff = e => (e.offsets.reduce((a, b) => a + b, 0) / e.offsets.length).toFixed(2);

        let html = `<div class="insp-section"><h4>Occurrences (${nOcc})</h4><ul class="insp-list">`;
        occurrences.slice(0, 30).forEach(o => {
            html += `<li><a href="javascript:void(0)" onclick="TLVReplay && TLVReplay.jumpTo('${esc(o.file)}', ${o.t})" title="Jump replay here">${fmtTime(o.t)}</a> <span class="muted">${esc(o.file.replace(/\.lua$/, ''))}</span></li>`;
        });
        if (nOcc > 30) html += `<li class="muted">…and ${nOcc - 30} more</li>`;
        html += '</ul></div>';

        if (aoeAgg.size) {
            html += `<div class="insp-section"><h4>AOEs spawned</h4><table class="insp-table"><tr><th>Name</th><th>Shape</th><th>Seen</th><th>Avg +t</th></tr>`;
            [...aoeAgg.values()].sort((a, b) => b.count - a.count).forEach(a => {
                const shape = `id ${a.aoeID}, castType ${a.castType}, len ${a.length}${a.width ? `, w ${a.width}` : ''}${a.duration ? `, ${Number(a.duration).toFixed(1)}s` : ''}`;
                html += `<tr><td>${esc(a.name)}</td><td class="muted">${esc(shape)}</td><td>${a.count}/${nOcc}</td><td>+${avgOff(a)}s</td></tr>`;
            });
            html += '</table></div>';
        }

        if (markerAgg.size) {
            html += `<div class="insp-section"><h4>Head markers</h4><table class="insp-table"><tr><th>Marker</th><th>Targets</th><th>Seen</th><th>Avg +t</th></tr>`;
            [...markerAgg.values()].sort((a, b) => b.count - a.count).forEach(m => {
                html += `<tr><td>ID ${esc(m.markerId)}</td><td class="muted">${esc([...m.targets].slice(0, 8).join(', '))}</td><td>${m.count}</td><td>+${avgOff(m)}s</td></tr>`;
            });
            html += '</table></div>';
        }

        if (tetherAgg.size) {
            html += `<div class="insp-section"><h4>Tethers</h4><table class="insp-table"><tr><th>Tether</th><th>Pairs</th><th>Seen</th><th>Avg +t</th></tr>`;
            [...tetherAgg.values()].sort((a, b) => b.count - a.count).forEach(t => {
                html += `<tr><td>ID ${esc(t.tetherId)}</td><td class="muted">${esc([...t.pairs].slice(0, 6).join('; '))}</td><td>${t.count}</td><td>+${avgOff(t)}s</td></tr>`;
            });
            html += '</table></div>';
        }

        if (dmgAgg.size) {
            html += `<div class="insp-section"><h4>Damage events</h4><table class="insp-table"><tr><th>Ability</th><th>Hits</th><th>Avg dmg</th><th>Avg +t</th></tr>`;
            [...dmgAgg.values()].sort((a, b) => b.count - a.count).slice(0, 12).forEach(d => {
                html += `<tr><td>${esc(d.name)}</td><td>${d.count}</td><td>${Math.round(d.total / d.count).toLocaleString()}</td><td>+${avgOff(d)}s</td></tr>`;
            });
            html += '</table></div>';
        }

        if (vfxAgg.size) {
            html += `<div class="insp-section"><h4>Entity VFX (top 15)</h4><table class="insp-table"><tr><th>VFX</th><th>Seen</th><th>Avg +t</th></tr>`;
            [...vfxAgg.values()].sort((a, b) => b.count - a.count).slice(0, 15).forEach(v => {
                html += `<tr><td class="mono">${esc(v.name)}</td><td>${v.count}</td><td>+${avgOff(v)}s</td></tr>`;
            });
            html += '</table></div>';
        }

        inspectorBody.innerHTML = html;
    }

    function onTabChange(tab) {
        if (tab === 'reactions') renderReactions();
    }

    window.TLVAnalysis = {
        build,
        renderSummaryStrip,
        renderReactions,
        openInspectorFromEvent,
        onTabChange,
        fmtTime,
        lowerBound
    };
})();
