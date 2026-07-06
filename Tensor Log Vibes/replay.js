// ============================================================================
// Tensor Log Vibes 2 — arena replay
// Reconstructs a top-down replay of a pull from the per-file analysis data
// (entity position tracks, AOE creates, tethers, markers, channels, deaths).
//
// Conventions: FFXIV world axes — facing dir = (sin h, cos h) in (x, z),
// north = -z (drawn as up). AOE shapes are best-effort from aoeCastType.
// ============================================================================

(function () {
    'use strict';

    const canvas = document.getElementById('replayCanvas');
    const ctx = canvas.getContext('2d');
    const stage = canvas.parentElement;

    const fileSelect = document.getElementById('replayFileSelect');
    const playBtn = document.getElementById('replayPlayBtn');
    const speedSelect = document.getElementById('replaySpeedSelect');
    const timeModeSel = document.getElementById('replayTimeMode');
    const clockEl = document.getElementById('replayClock');
    const durationEl = document.getElementById('replayDuration');
    const scrub = document.getElementById('replayScrub');
    const feedEl = document.getElementById('replayEventFeed');

    const tglTrails = document.getElementById('tglTrails');
    const tglLabels = document.getElementById('tglLabels');
    const tglPlayerLabels = document.getElementById('tglPlayerLabels');
    const tglNpcLabels = document.getElementById('tglNpcLabels');
    const tglPetLabels = document.getElementById('tglPetLabels');
    const tglAoes = document.getElementById('tglAoes');
    const tglCasts = document.getElementById('tglCasts');
    const tglMarkers = document.getElementById('tglMarkers');
    const tglSync = document.getElementById('tglSync');
    const labelSizeSel = document.getElementById('replayLabelSize');

    // label size multiplier + clickable label regions (rebuilt every render)
    let labelScale = 1;
    let labelHits = [];
    function lpx(base) { return Math.round(base * labelScale); }

    const PLAYER_COLORS = ['#4fc3f7', '#3b82f6', '#10b981', '#84cc16', '#ef4444', '#f97316', '#eab308', '#a855f7'];
    const TRAIL_SECONDS = 6;
    const MARKER_SECONDS = 5;
    const DEATH_FLASH_SECONDS = 8;
    const FEED_SECONDS = 5;

    const S = {
        file: null,
        A: null,            // analysis record from TLV.byFile
        t: 0,
        playing: false,
        speed: 1,
        active: false,      // replay tab visible
        lastFrame: 0,
        zoom: 1,
        panX: 0,
        panY: 0,
        dragging: false,
        dragStart: null,
        partyIndex: new Map(), // player name -> party slot
        lastFeedSig: ''
    };

    function lowerBound(arr, t) { return TLVAnalysis.lowerBound(arr, t); }
    function fmtTime(t) { return TLVAnalysis.fmtTime(t); }

    // ---------------- clock modes ----------------
    // 'sync' = raw synced-timer seconds (what reaction timelines use)
    // 'real' = in-game duty timer (m:ss), mapped through the sync offsets
    let realMap = []; // [{t, rt}] segment starts, sorted by t

    function buildRealMap(A) {
        realMap = [];
        let lastOffset = null;
        let lastT = -Infinity;
        let lastRt = -Infinity;
        for (const ev of A.eventsIdx) {
            if (isNaN(ev.tNum) || isNaN(ev.rtNum)) continue;
            // post-wipe lines freeze the synced stamp and reset real time to
            // 0.000 — require BOTH clocks to stay monotonic
            if (ev.tNum < lastT - 0.001 || ev.rtNum < lastRt - 0.001) continue;
            lastT = ev.tNum;
            lastRt = ev.rtNum;
            const offset = ev.rtNum - ev.tNum;
            if (lastOffset === null || Math.abs(offset - lastOffset) > 0.05) {
                realMap.push({ t: ev.tNum, rt: ev.rtNum });
                lastOffset = offset;
            }
        }
    }

    function realOf(t) {
        if (!realMap.length) return t;
        let lo = 0, hi = realMap.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (realMap[mid].t <= t) lo = mid;
            else hi = mid - 1;
        }
        const seg = realMap[lo];
        return t < seg.t ? t : seg.rt + (t - seg.t);
    }

    function fmtClock(t) {
        return timeModeSel.value === 'real' ? fmtTime(realOf(t)) : t.toFixed(1);
    }

    function refreshClockLabels() {
        const real = timeModeSel.value === 'real';
        clockEl.title = real ? 'In-game duty timer (real time)' : 'Synced timer (raw seconds)';
        durationEl.title = clockEl.title;
        if (S.A) durationEl.textContent = fmtClock(S.A.duration);
    }

    timeModeSel.addEventListener('change', () => {
        refreshClockLabels();
        S.lastFeedSig = ''; // feed timestamps follow the mode
        requestRender();
    });

    // ---------------- data / lifecycle ----------------
    function onDataLoaded() {
        if (fileSelect.options.length) {
            loadPull(fileSelect.value || fileSelect.options[0].value);
        }
    }

    function loadPull(file) {
        S.file = file;
        S.A = TLV.byFile.get(file) || null;
        S.t = 0;
        S.playing = false;
        S.zoom = 1;
        S.panX = 0;
        S.panY = 0;
        S.partyIndex = new Map();
        if (S.A && S.A.meta.party) {
            S.A.meta.party.forEach((name, i) => S.partyIndex.set(name, i));
        }
        if (S.A) {
            scrub.max = S.A.duration;
            buildRealMap(S.A);
            refreshClockLabels();
        }
        updatePlayBtn();
        requestRender();
    }

    fileSelect.addEventListener('change', () => loadPull(fileSelect.value));

    function onTabChange(visible) {
        S.active = visible;
        if (visible) {
            resizeCanvas();
            S.lastFrame = performance.now();
            requestRender();
            requestAnimationFrame(frame);
        } else {
            S.playing = false;
            updatePlayBtn();
        }
    }

    // ---------------- playback controls ----------------
    function updatePlayBtn() {
        playBtn.textContent = S.playing ? '⏸' : '▶';
    }

    function setPlaying(p) {
        S.playing = p && !!S.A;
        S.lastFrame = performance.now();
        updatePlayBtn();
    }

    playBtn.addEventListener('click', () => setPlaying(!S.playing));
    speedSelect.addEventListener('change', () => { S.speed = parseFloat(speedSelect.value); });

    scrub.addEventListener('input', () => {
        S.t = parseFloat(scrub.value);
        requestRender();
    });
    scrub.addEventListener('change', () => {
        if (tglSync.checked && S.file) window.syncTableToTime(S.file, S.t);
    });

    [tglTrails, tglLabels, tglPlayerLabels, tglNpcLabels, tglPetLabels, tglAoes, tglCasts, tglMarkers].forEach(el =>
        el.addEventListener('change', requestRender));
    labelSizeSel.addEventListener('input', () => {
        const v = parseFloat(labelSizeSel.value);
        labelScale = isNaN(v) ? 1 : Math.max(0.4, Math.min(4, v));
        requestRender();
    });

    document.getElementById('replayResetViewBtn').addEventListener('click', () => {
        S.zoom = 1; S.panX = 0; S.panY = 0;
        requestRender();
    });

    document.addEventListener('keydown', e => {
        if (!S.active || !S.A) return;
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
        if (e.code === 'Space') {
            e.preventDefault();
            setPlaying(!S.playing);
        } else if (e.code === 'ArrowRight') {
            e.preventDefault();
            S.t = Math.min(S.A.duration, S.t + (e.shiftKey ? 5 : 0.5));
            if (tglSync.checked) window.syncTableToTime(S.file, S.t);
            requestRender();
        } else if (e.code === 'ArrowLeft') {
            e.preventDefault();
            S.t = Math.max(0, S.t - (e.shiftKey ? 5 : 0.5));
            if (tglSync.checked) window.syncTableToTime(S.file, S.t);
            requestRender();
        }
    });

    // External entry: events table dblclick / inspector / reactions tables
    function jumpTo(file, t) {
        if (fileSelect.value !== file) {
            fileSelect.value = file;
            loadPull(file);
        }
        if (!S.A) return;
        S.t = Math.max(0, Math.min(S.A.duration, t));
        S.playing = false;
        updatePlayBtn();
        window.switchTab('replay');
        requestRender();
    }

    // ---------------- view transform ----------------
    function resizeCanvas() {
        const r = stage.getBoundingClientRect();
        if (r.width < 10 || r.height < 10) return;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(r.width * dpr);
        canvas.height = Math.floor(r.height * dpr);
        canvas.style.width = r.width + 'px';
        canvas.style.height = r.height + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    window.addEventListener('resize', () => {
        if (S.active) { resizeCanvas(); requestRender(); }
    });

    function viewParams() {
        const w = canvas.clientWidth, h = canvas.clientHeight;
        const A = S.A;
        const baseScale = Math.min(w, h) / (2 * (A ? A.viewRadius : 25));
        const scale = baseScale * S.zoom;
        const cx = w / 2 + S.panX;
        const cy = h / 2 + S.panY;
        return { w, h, scale, cx, cy };
    }

    function w2s(vp, x, z) {
        const A = S.A;
        return [
            vp.cx + (x - A.center.x) * vp.scale,
            vp.cy + (z - A.center.z) * vp.scale
        ];
    }

    canvas.addEventListener('wheel', e => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        S.zoom = Math.max(0.3, Math.min(12, S.zoom * factor));
        requestRender();
    }, { passive: false });

    canvas.addEventListener('mousedown', e => {
        S.dragging = false;
        S.dragStart = { x: e.clientX, y: e.clientY, panX: S.panX, panY: S.panY };
    });
    window.addEventListener('mousemove', e => {
        if (!S.dragStart) return;
        const dx = e.clientX - S.dragStart.x, dy = e.clientY - S.dragStart.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) S.dragging = true;
        if (S.dragging) {
            S.panX = S.dragStart.panX + dx;
            S.panY = S.dragStart.panY + dy;
            requestRender();
        }
    });
    window.addEventListener('mouseup', e => {
        if (S.dragStart && !S.dragging && e.target === canvas) handleCanvasClick(e);
        S.dragStart = null;
        S.dragging = false;
    });

    function labelHitAt(mx, my) {
        // topmost = drawn last
        for (let i = labelHits.length - 1; i >= 0; i--) {
            const h = labelHits[i];
            if (mx >= h.x0 && mx <= h.x1 && my >= h.y0 && my <= h.y1) return h;
        }
        return null;
    }

    function handleCanvasClick(e) {
        if (!S.A) return;
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;

        // cast / effect labels open the raw event in the docked side panel
        const hit = labelHitAt(mx, my);
        if (hit && hit.evId !== undefined) {
            showReplayDetail(hit.evId);
            return;
        }

        const vp = viewParams();
        let best = null, bestD = 14;
        for (const [, ent] of S.A.entities) {
            const p = entityPosAt(ent, S.t);
            if (!p) continue;
            const [sx, sy] = w2s(vp, p.x, p.z);
            const d = Math.hypot(sx - mx, sy - my);
            if (d < bestD) { bestD = d; best = ent; }
        }
        if (best) {
            window.toggleEntityFilterExternal(best.name || best.id);
        }
    }

    canvas.addEventListener('mousemove', e => {
        if (!S.A || S.dragging) return;
        const rect = canvas.getBoundingClientRect();
        canvas.style.cursor = labelHitAt(e.clientX - rect.left, e.clientY - rect.top) ? 'pointer' : 'crosshair';
    });

    // ---------------- entity position lookup ----------------
    function entityPosAt(ent, t) {
        const s = ent.samples;
        if (!s.length) return null;
        const i = lowerBound(s, t);
        const after = s[i];
        const before = s[i - 1];
        if (!before && after) return (after.t - t <= 4) ? after : null;
        if (!after && before) return (t - before.t <= 4) ? before : null;
        if (!before && !after) return null;
        const gap = after.t - before.t;
        if (gap > 3) {
            // big sampling hole — snap to whichever side is close enough
            if (t - before.t <= 4) return before;
            if (after.t - t <= 4) return after;
            return null;
        }
        const f = gap > 0 ? (t - before.t) / gap : 0;
        return {
            t,
            x: before.x + (after.x - before.x) * f,
            z: before.z + (after.z - before.z) * f,
            h: after.h // don't interpolate angles across the -π/π seam
        };
    }

    function isDeadAt(ent, t) {
        for (const [a, b] of ent.deadRanges) {
            if (t >= a && t <= b) return true;
        }
        return false;
    }

    // ---------------- render ----------------
    let renderQueued = false;
    function requestRender() {
        if (renderQueued) return;
        renderQueued = true;
        requestAnimationFrame(() => {
            renderQueued = false;
            render();
        });
    }

    function frame(now) {
        if (!S.active) return;
        if (S.playing && S.A) {
            const dt = (now - S.lastFrame) / 1000;
            S.t += dt * S.speed;
            if (S.t >= S.A.duration) {
                S.t = S.A.duration;
                setPlaying(false);
            }
            render();
        }
        S.lastFrame = now;
        requestAnimationFrame(frame);
    }

    function render() {
        if (canvas.clientWidth < 10) resizeCanvas();
        const vp = viewParams();
        ctx.clearRect(0, 0, vp.w, vp.h);
        clockEl.textContent = fmtClock(S.t);
        scrub.value = S.t;

        if (!S.A) {
            ctx.fillStyle = 'rgba(255,255,255,0.4)';
            ctx.font = '14px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Load logs, then pick a pull to replay', vp.w / 2, vp.h / 2);
            ctx.textAlign = 'left';
            return;
        }

        labelHits = [];
        drawArena(vp);
        if (tglAoes.checked) drawAoes(vp);
        drawTethers(vp);
        if (tglTrails.checked) drawTrails(vp);
        drawEntities(vp);
        if (tglMarkers.checked) drawMarkers(vp);
        if (tglCasts.checked) drawChannels(vp);
        drawDeaths(vp);
        updateFeed();
    }

    function drawArena(vp) {
        const A = S.A;
        ctx.save();
        // rings every 5y
        for (let r = 5; r <= A.viewRadius + 5; r += 5) {
            const [sx, sy] = w2s(vp, A.center.x, A.center.z);
            ctx.beginPath();
            ctx.arc(sx, sy, r * vp.scale, 0, Math.PI * 2);
            ctx.strokeStyle = r % 10 === 0 ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.045)';
            ctx.lineWidth = 1;
            ctx.stroke();
        }
        // crosshair
        const [cx, cy] = w2s(vp, A.center.x, A.center.z);
        const ext = (A.viewRadius + 5) * vp.scale;
        ctx.strokeStyle = 'rgba(255,255,255,0.07)';
        ctx.beginPath();
        ctx.moveTo(cx - ext, cy); ctx.lineTo(cx + ext, cy);
        ctx.moveTo(cx, cy - ext); ctx.lineTo(cx, cy + ext);
        ctx.stroke();
        // compass
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.font = '11px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('N', cx, cy - ext - 4);
        ctx.fillText('S', cx, cy + ext + 12);
        ctx.fillText('W', cx - ext - 10, cy + 4);
        ctx.fillText('E', cx + ext + 10, cy + 4);
        ctx.textAlign = 'left';
        ctx.restore();
    }

    // AOE shape families by aoeCastType (best-effort):
    //   circles: 2, 5, 6, 7 · cones: 3, 13 · rects (from origin): 4, 8, 12 ·
    //   donuts: 10 · cross: 11 — anything else falls back to a circle.
    function drawAoes(vp) {
        const A = S.A;
        const active = [];
        for (const a of A.aoes) {
            const o = a.o;
            const delay = Number(o.delay) || 0;
            const dur = Number(o.duration) || 3;
            const t0 = a.t + delay;
            if (S.t >= t0 && S.t <= t0 + dur) active.push({ a, o, t0, dur });
        }

        for (const { a, o, t0, dur } of active) {
            const remain = 1 - (S.t - t0) / dur;
            const heading = Number(o.heading) || 0;
            const len = Number(o.aoeLength) || 5;
            const wid = Number(o.aoeWidth) || 0;
            const [sx, sy] = w2s(vp, Number(o.x), Number(o.z));
            const screenAng = Math.atan2(Math.cos(heading), Math.sin(heading)); // dir (sin h, cos h) in (x,z)

            ctx.save();
            const alpha = 0.14 + 0.22 * remain;
            ctx.fillStyle = o.friendly ? `rgba(59,130,246,${alpha})` : `rgba(239,68,68,${alpha})`;
            ctx.strokeStyle = o.friendly ? 'rgba(96,165,250,0.8)' : 'rgba(248,113,113,0.8)';
            ctx.lineWidth = 1.5;

            const ct = Number(o.aoeCastType);
            ctx.beginPath();
            if (ct === 3 || ct === 13) {
                // cone — real angle isn't in the log; 90° approximation
                const half = Math.PI / 4;
                ctx.moveTo(sx, sy);
                ctx.arc(sx, sy, len * vp.scale, screenAng - half, screenAng + half);
                ctx.closePath();
            } else if (ct === 4 || ct === 8 || ct === 12) {
                const w = (wid || 4) * vp.scale;
                const l = len * vp.scale;
                ctx.translate(sx, sy);
                ctx.rotate(screenAng);
                ctx.rect(0, -w / 2, l, w);
                ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
                ctx.translate(0, 0);
                // note: rect path was added in rotated space; fill/stroke below use it
            } else if (ct === 10) {
                // donut — inner radius unknown, approximate at 40 % of outer
                const outer = len * vp.scale, inner = outer * 0.4;
                ctx.arc(sx, sy, outer, 0, Math.PI * 2);
                ctx.arc(sx, sy, inner, 0, Math.PI * 2, true);
            } else if (ct === 11) {
                const w = (wid || 4) * vp.scale, l = len * vp.scale;
                ctx.translate(sx, sy);
                ctx.rotate(screenAng);
                ctx.rect(-l, -w / 2, l * 2, w);
                ctx.rect(-w / 2, -l, w, l * 2);
                ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
            } else {
                ctx.arc(sx, sy, len * vp.scale, 0, Math.PI * 2);
            }
            ctx.fill('evenodd');
            ctx.stroke();
            ctx.restore();

            if (tglLabels.checked && o.aoeName) {
                ctx.save();
                ctx.fillStyle = 'rgba(248,113,113,0.9)';
                const fpx = lpx(10);
                ctx.font = `${fpx}px Inter, sans-serif`;
                ctx.textAlign = 'center';
                const txt = `${o.aoeName} (${(t0 + dur - S.t).toFixed(1)}s)`;
                const tw = ctx.measureText(txt).width;
                ctx.fillText(txt, sx, sy - 6);
                labelHits.push({ x0: sx - tw / 2, x1: sx + tw / 2, y0: sy - 6 - fpx, y1: sy - 2, evId: a.evId });
                ctx.textAlign = 'left';
                ctx.restore();
            }
        }
    }

    function drawTethers(vp) {
        const A = S.A;
        for (const th of A.tethers) {
            const end = th.t1 !== null ? th.t1 : th.t0 + 15;
            if (S.t < th.t0 || S.t > end) continue;
            const src = A.entities.get(th.srcId);
            const tgt = A.entities.get(th.tgtId);
            if (!src || !tgt) continue;
            const ps = entityPosAt(src, S.t);
            const pt = entityPosAt(tgt, S.t);
            if (!ps || !pt) continue;
            const [x1, y1] = w2s(vp, ps.x, ps.z);
            const [x2, y2] = w2s(vp, pt.x, pt.z);
            ctx.save();
            ctx.strokeStyle = 'rgba(245,158,11,0.85)';
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 4]);
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
            ctx.setLineDash([]);
            if (tglLabels.checked) {
                ctx.fillStyle = 'rgba(245,158,11,0.9)';
                ctx.font = `${lpx(10)}px Inter, sans-serif`;
                ctx.fillText(`tether ${th.tetherId}`, (x1 + x2) / 2 + 4, (y1 + y2) / 2 - 4);
            }
            ctx.restore();
        }
    }

    function playerColor(ent) {
        const idx = S.partyIndex.has(ent.name) ? S.partyIndex.get(ent.name) : -1;
        return idx >= 0 ? PLAYER_COLORS[idx % PLAYER_COLORS.length] : '#9ba1a6';
    }

    function drawTrails(vp) {
        const A = S.A;
        for (const [, ent] of A.entities) {
            if (!ent.isPlayer) continue;
            const s = ent.samples;
            let i = lowerBound(s, S.t - TRAIL_SECONDS);
            const endI = lowerBound(s, S.t);
            if (endI - i < 2) continue;
            ctx.save();
            ctx.strokeStyle = playerColor(ent) + '55';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            let started = false;
            for (; i < endI; i++) {
                const [sx, sy] = w2s(vp, s[i].x, s[i].z);
                if (!started) { ctx.moveTo(sx, sy); started = true; }
                else ctx.lineTo(sx, sy);
            }
            ctx.stroke();
            ctx.restore();
        }
    }

    function drawEntities(vp) {
        const A = S.A;
        // non-players below players
        const groups = [[], []];
        for (const [, ent] of A.entities) {
            const p = entityPosAt(ent, S.t);
            if (!p) continue;
            groups[ent.isPlayer ? 1 : 0].push({ ent, p });
        }

        // bosses / adds (pets detected by the analysis layer draw teal)
        for (const { ent, p } of groups[0]) {
            const [sx, sy] = w2s(vp, p.x, p.z);
            const dead = isDeadAt(ent, S.t);
            const isPet = !!ent.isPet;
            ctx.save();
            ctx.translate(sx, sy);
            ctx.rotate(Math.PI / 4);
            const r = 7;
            ctx.fillStyle = dead ? 'rgba(120,120,120,0.5)'
                : isPet ? 'rgba(45,212,191,0.9)' : 'rgba(249,115,22,0.9)';
            ctx.strokeStyle = 'rgba(0,0,0,0.6)';
            ctx.lineWidth = 1;
            ctx.fillRect(-r / 2, -r / 2, r, r);
            ctx.strokeRect(-r / 2, -r / 2, r, r);
            ctx.restore();
            // heading tick
            drawHeadingTick(vp, sx, sy, p.h, 9, isPet ? 'rgba(45,212,191,0.8)' : 'rgba(249,115,22,0.8)');
            if ((isPet ? tglPetLabels.checked : tglNpcLabels.checked) && ent.name) {
                ctx.fillStyle = isPet ? 'rgba(94,234,212,0.85)' : 'rgba(251,146,60,0.85)';
                ctx.font = `${lpx(10)}px Inter, sans-serif`;
                ctx.fillText(ent.name, sx + 8, sy - 6);
            }
        }

        // players
        for (const { ent, p } of groups[1]) {
            const [sx, sy] = w2s(vp, p.x, p.z);
            const dead = isDeadAt(ent, S.t);
            const color = dead ? '#6b7280' : playerColor(ent);
            ctx.save();
            ctx.beginPath();
            ctx.arc(sx, sy, 6, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.globalAlpha = dead ? 0.55 : 1;
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.strokeStyle = 'rgba(0,0,0,0.65)';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            if (dead) {
                ctx.strokeStyle = 'rgba(255,255,255,0.8)';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(sx - 3, sy - 3); ctx.lineTo(sx + 3, sy + 3);
                ctx.moveTo(sx + 3, sy - 3); ctx.lineTo(sx - 3, sy + 3);
                ctx.stroke();
            } else {
                drawHeadingTick(vp, sx, sy, p.h, 8, color);
            }
            ctx.restore();
            if (tglPlayerLabels.checked && ent.name) {
                ctx.fillStyle = 'rgba(240,242,245,0.85)';
                ctx.font = `${lpx(10)}px Inter, sans-serif`;
                ctx.fillText(ent.name.replace(/^P\d_/, ''), sx + 8, sy + 3);
            }
        }
    }

    function drawHeadingTick(vp, sx, sy, h, len, color) {
        const dx = Math.sin(h), dy = Math.cos(h);
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + dx * len, sy + dy * len);
        ctx.stroke();
        ctx.restore();
    }

    function drawMarkers(vp) {
        const A = S.A;
        let i = lowerBound(A.markers, S.t - MARKER_SECONDS);
        for (; i < A.markers.length && A.markers[i].t <= S.t; i++) {
            const m = A.markers[i];
            const ent = A.entities.get(m.entId);
            if (!ent) continue;
            const p = entityPosAt(ent, S.t);
            if (!p) continue;
            const [sx, sy] = w2s(vp, p.x, p.z);
            const age = S.t - m.t;
            const pulse = 10 + 3 * Math.sin(age * 6);
            ctx.save();
            ctx.strokeStyle = 'rgba(250,204,21,0.9)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(sx, sy, pulse, 0, Math.PI * 2);
            ctx.stroke();
            ctx.fillStyle = 'rgba(250,204,21,0.95)';
            ctx.font = `bold ${lpx(10)}px Inter, sans-serif`;
            ctx.textAlign = 'center';
            ctx.fillText(`M${m.markerId}`, sx, sy - pulse - 3);
            ctx.textAlign = 'left';
            ctx.restore();
        }
    }

    function drawChannels(vp) {
        const A = S.A;
        for (const c of A.channels) {
            if (!c.dur || S.t < c.t || S.t > c.t + c.dur) continue;
            const ent = A.entities.get(c.srcId);
            if (!ent) continue;
            const p = entityPosAt(ent, S.t);
            if (!p) continue;
            const [sx, sy] = w2s(vp, p.x, p.z);
            const frac = (S.t - c.t) / c.dur;
            ctx.save();
            ctx.strokeStyle = 'rgba(139,92,246,0.9)';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(sx, sy, 11, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
            ctx.stroke();
            if (tglLabels.checked && c.name) {
                ctx.fillStyle = 'rgba(196,181,253,0.95)';
                const fpx = lpx(10);
                ctx.font = `${fpx}px Inter, sans-serif`;
                ctx.textAlign = 'center';
                const txt = `${c.name} ${(c.t + c.dur - S.t).toFixed(1)}s`;
                const tw = ctx.measureText(txt).width;
                ctx.fillText(txt, sx, sy + 22);
                labelHits.push({ x0: sx - tw / 2, x1: sx + tw / 2, y0: sy + 22 - fpx, y1: sy + 26, evId: c.evId });
                ctx.textAlign = 'left';
            }
            ctx.restore();
        }
    }

    function drawDeaths(vp) {
        const A = S.A;
        for (const d of A.deaths) {
            if (S.t < d.t || S.t > d.t + DEATH_FLASH_SECONDS || !d.isPlayer) continue;
            const ent = A.entities.get(d.entId);
            if (!ent) continue;
            const p = entityPosAt(ent, Math.min(S.t, d.t + 0.5));
            if (!p) continue;
            const [sx, sy] = w2s(vp, p.x, p.z);
            ctx.save();
            ctx.font = '14px sans-serif';
            ctx.globalAlpha = Math.max(0.25, 1 - (S.t - d.t) / DEATH_FLASH_SECONDS);
            ctx.textAlign = 'center';
            ctx.fillText('💀', sx, sy - 12);
            ctx.textAlign = 'left';
            ctx.restore();
        }
    }

    // ---------------- docked event detail panel ----------------
    const detailEl = document.getElementById('replayDetail');
    const detailTitle = document.getElementById('replayDetailTitle');
    const detailBody = document.getElementById('replayDetailBody');
    document.getElementById('replayDetailClose').addEventListener('click', () => {
        detailEl.classList.add('hidden');
    });

    function showReplayDetail(evId) {
        // parsedEvents is a top-level `let` in app.js: visible as a bare
        // identifier across classic scripts, but NOT as window.parsedEvents
        const ev = (typeof parsedEvents !== 'undefined') ? parsedEvents[evId] : null;
        if (!ev) return;
        detailTitle.textContent = `${ev.type} @ ${ev.time}`;
        if (ev.isMultiline) {
            detailBody.textContent = ev.payloadRaw;
        } else {
            const lines = Object.entries(ev.payload).map(([k, v]) => `${k}: ${v}`);
            detailBody.textContent = lines.length ? lines.join('\n') : ev.payloadRaw;
        }
        detailEl.classList.remove('hidden');
    }

    // ---------------- rolling event feed ----------------
    function updateFeed() {
        const A = S.A;
        const items = [];
        const t0 = S.t - FEED_SECONDS;

        let i = lowerBound(A.channels, t0);
        for (; i < A.channels.length && A.channels[i].t <= S.t; i++) {
            const c = A.channels[i];
            if (c.isBoss && !c.isPet && c.name) items.push({ t: c.t, cls: 'feed-cast', txt: `⌛ ${c.srcName}: ${c.name} (${c.dur.toFixed(1)}s)` });
        }
        i = lowerBound(A.casts, t0);
        for (; i < A.casts.length && A.casts[i].t <= S.t; i++) {
            const c = A.casts[i];
            if (c.isBoss && !c.isPet && c.name) items.push({ t: c.t, cls: 'feed-cast', txt: `⚡ ${c.srcName}: ${c.name}` });
        }
        i = lowerBound(A.markers, t0);
        for (; i < A.markers.length && A.markers[i].t <= S.t; i++) {
            const m = A.markers[i];
            items.push({ t: m.t, cls: 'feed-marker', txt: `◎ Marker ${m.markerId} → ${m.entName || m.entId}` });
        }
        for (const d of A.deaths) {
            if (d.t >= t0 && d.t <= S.t && d.isPlayer) items.push({ t: d.t, cls: 'feed-death', txt: `💀 ${d.name} died` });
        }
        for (const r of A.reactions) {
            if (r.tExec !== null && r.tExec >= t0 && r.tExec <= S.t) items.push({ t: r.tExec, cls: 'feed-reaction', txt: `⚙ ${r.name}` });
        }

        items.sort((a, b) => a.t - b.t);
        const trimmed = items.slice(-14);
        const sig = trimmed.map(x => x.t.toFixed(2) + x.txt).join('|');
        if (sig === S.lastFeedSig) return;
        S.lastFeedSig = sig;
        feedEl.innerHTML = trimmed.map(x =>
            `<div class="feed-line ${x.cls}"><span class="feed-t">${fmtClock(x.t)}</span> ${escapeHtml(x.txt)}</div>`
        ).join('');
    }

    function escapeHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    window.TLVReplay = {
        onDataLoaded,
        onTabChange,
        jumpTo,
        getTime: () => S.t,
        getFile: () => S.file,
        isPlaying: () => S.playing
    };
})();
