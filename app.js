/* ================================
   TSP Routenplaner – app.js
   CSV/JSON-Import, Heuristiken, 2-Opt,
   Haversine/Euklid, Canvas-Render, Exporte,
   Mini-Erklärungen, Geocoding & Leaflet,
   Rundtour, OSRM-Straßenrouting
   ================================ */

(() => {
  // ---------- DOM ----------
  const $ = (sel) => document.querySelector(sel);

  const coordsInput = $('#coordsInput');
  const addrInput   = $('#addrInput');
  const fileInput   = $('#fileInput');
  const btnParse    = $('#btnParse');
  const btnClear    = $('#btnClear');
  const btnSample   = $('#btnSample');
  const btnGeocode  = $('#btnGeocode');

  const metricSelect    = $('#metricSelect');
  const algoSelect      = $('#algoSelect');
  const chkFixStart     = $('#chkFixStart');
  const startIndexEl    = $('#startIndex');
  const improveSelect   = $('#improveSelect');
  const chkRoundtrip    = $('#chkRoundtrip');
  const routeModeSelect = $('#routeModeSelect'); // NEU

  const btnSolve    = $('#btnSolve');
  const btnImprove  = $('#btnImprove');
  const btnStep     = $('#btnStep');
  const btnStop     = $('#btnStop');
  const btnReset    = $('#btnReset');

  const btnExportCSV     = $('#btnExportCSV');
  const btnExportJSON    = $('#btnExportJSON');
  const btnExportGeoJSON = $('#btnExportGeoJSON');
  const btnExportGPX     = $('#btnExportGPX');

  const btnFit           = $('#btnFit');
  const btnToggleLabels  = $('#btnToggleLabels');
  const btnToggleNumbers = $('#btnToggleNumbers');
  const btnToggleCoords  = $('#btnToggleCoords');
  const btnToggleMap     = $('#btnToggleMap');

  const btnPrint = document.querySelector('#btnPrint');
 
  const statNodes    = $('#statNodes');
  const statDistance = $('#statDistance');
  const statTime     = $('#statTime');
  const statMethod   = $('#statMethod');

  const routeList = $('#routeList');

  const yearEl = $('#year');
  const linkAbout = $('#linkAbout');
  const aboutDialog = $('#aboutDialog');
  const toast = $('#toast');

  const canvas = $('#routeCanvas');
  const ctx = canvas.getContext('2d', { alpha: true });
  const overlay = $('#canvasOverlay');
  const explainEl = document.querySelector('#explainText');

  const mapEl = $('#map');

  // ---------- State ----------
  let points = [];          // [{x,y,label?}]  (x=lon oder x, y=lat oder y)
  let route = [];           // [indices]
  let metric = 'euclidean'; // 'euclidean' | 'haversine'
  let fixedStart = false;
  let fixedStartIndex = null;
  let roundtrip = false;
  let renderOptions = { labels: false, numbers: true, coords: false };

  // Routing-Modus
  let routeMode = 'straight'; // 'straight' | 'osrm'
  let osrmDistanceMeters = null;
  let osrmGeometry = null; // [[lat,lon], ...]

  // 2-Opt
  let improving = false;
  let stopFlag = false;

  // Canvas Transform
  let transform = { scale: 1, tx: 0, ty: 0, padding: 24 };

  // RNG (optional seed)
  let seeded = null;
  const rng = () => (seeded = (seeded * 1664525 + 1013904223) % 4294967296) / 4294967296;

  // Leaflet
  let map, markerGroup, lineLayer;
  let mapVisible = false;

  // ---------- Erklärtexte ----------
  const DESCRIPTIONS = {
    metric: {
      euclidean: 'Euklidische Distanz (x/y) – geeignet für flache Karten/Konstruktionspunkte.',
      haversine: 'Haversine (Lat/Lon) – Kugelabstand auf der Erde in Metern/Kilometern.'
    },
    algo: {
      nearest: 'Nearest Neighbor: startet am Startpunkt und wählt jeweils den nächstgelegenen unbesuchten Punkt.',
      insertion: 'Cheapest Insertion: fügt Punkte an der günstigsten Stelle in die Tour ein.',
      random: 'Zufällige Tour: Baseline/Benchmark; Qualität variiert stark.'
    },
    improve: {
      '2opt': '2-Opt: tauscht Kantenpaare lokal aus, solange die Gesamtdistanz sinkt.',
      'none': 'Keine Verbesserung: reine Startheuristik ohne lokale Optimierung.'
    }
  };

  // ---------- Utils ----------
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  function showToast(msg, { ok=false, warn=false, err=false } = {}) {
    toast.textContent = msg;
    toast.style.borderLeftColor = err ? '#ef4444' : warn ? '#f59e0b' : ok ? '#16a34a' : 'var(--primary)';
    toast.classList.add('show');
    setTimeout(()=>toast.classList.remove('show'), 2600);
  }

  function currentDistanceText() {
    // Distanzanzeige mit OSRM, falls vorhanden
    if (routeMode === 'osrm' && osrmDistanceMeters != null) {
      if (osrmDistanceMeters >= 1000) return `${(osrmDistanceMeters/1000).toFixed(2)} km`;
      return `${osrmDistanceMeters.toFixed(1)} m`;
    }
    const d = tourLength(route, metric, roundtrip);
    if (metric === 'haversine') {
      if (d >= 1000) return `${(d/1000).toFixed(2)} km`;
      return `${d.toFixed(1)} m`;
    }
    return d.toFixed(3);
  }

  function setStats({ method='–', timeMs=null } = {}) {
    statNodes.textContent = points.length;
    const suffix = roundtrip ? ' (Rundtour)' : '';
    const routingNote = routeMode === 'osrm' ? ' [OSRM]' : '';
    statMethod.textContent = method + suffix + routingNote;
    statDistance.textContent = route.length ? currentDistanceText() : '–';
    statTime.textContent = timeMs==null ? '–' : `${timeMs.toFixed(1)} ms`;
  }

  function updateExplanation({ methodKey, improveKey, metricKey }) {
    if (!explainEl) return;
    const m = DESCRIPTIONS.metric[metricKey] ?? '';
    const a = DESCRIPTIONS.algo[methodKey] ?? methodKey;
    const i = DESCRIPTIONS.improve[improveKey] ?? '';
    const distText = route.length ? `Aktuelle Gesamtdistanz: ${currentDistanceText()}.` : '';
    const rText = roundtrip ? ' • Rundtour (Start=Ziel).' : '';
    const rmText = routeMode === 'osrm' ? ' • Straßenrouting via OSRM.' : '';
    explainEl.textContent = `${a}${improveKey !== 'none' ? ' + ' + i : ''} • ${m}${rText}${rmText} ${distText}`;
  }

  function toXYArray(srcPoints) {
    return srcPoints.map((p, i) => {
      if ('lat' in p && 'lon' in p) {
        return { x: +p.lon, y: +p.lat, label: p.label ?? `P${i}` };
      }
      if ('latitude' in p && 'longitude' in p) {
        return { x: +p.longitude, y: +p.latitude, label: p.label ?? `P${i}` };
      }
      if ('x' in p && 'y' in p) {
        return { x: +p.x, y: +p.y, label: p.label ?? `P${i}` };
      }
      if (Array.isArray(p) && p.length >= 2) {
        return { x: +p[0], y: +p[1], label: `P${i}` };
      }
      throw new Error('Unbekanntes Punktformat');
    });
  }

  function snapToGrid(arr, gridStep){
    if (!gridStep || gridStep <= 0) return arr;
    return arr.map(p => ({
      ...p,
      x: Math.round(p.x / gridStep) * gridStep,
      y: Math.round(p.y / gridStep) * gridStep
    }));
  }

  // ---------- Distanz ----------
  function dist(i, j, metricMode) {
    const a = points[i], b = points[j];
    if (metricMode === 'haversine') {
      return haversine(a.y, a.x, b.y, b.x);
    }
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.hypot(dx, dy);
  }

  function tourLength(order, metricMode, isRoundtrip=false) {
    if (order.length < 2) return 0;
    let s = 0;
    for (let i = 0; i < order.length - 1; i++) s += dist(order[i], order[i+1], metricMode);
    if (isRoundtrip && order.length > 1) s += dist(order[order.length-1], order[0], metricMode);
    return s;
  }

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const toRad = (d) => d * Math.PI / 180;
    const φ1 = toRad(lat1), φ2 = toRad(lat2);
    const Δφ = toRad(lat2 - lat1);
    const Δλ = toRad(lon2 - lon1);
    const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  // ---------- Heuristiken ----------
  function nearestNeighbor(start=0) {
    const n = points.length;
    if (n === 0) return [];
    const visited = Array(n).fill(false);
    const tour = [];
    let current = clamp(start, 0, n-1);
    tour.push(current);
    visited[current] = true;
    for (let step = 1; step < n; step++) {
      let best = -1, bestD = Infinity;
      for (let j = 0; j < n; j++) {
        if (!visited[j]) {
          const d = dist(current, j, metric);
          if (d < bestD) { bestD = d; best = j; }
        }
      }
      if (best === -1) break;
      visited[best] = true;
      tour.push(best);
      current = best;
    }
    return tour;
  }

  function cheapestInsertion(start=0) {
    const n = points.length;
    if (n < 2) return [...Array(n).keys()];
    const remaining = new Set([...Array(n).keys()]);
    const s = clamp(start, 0, n-1);

    remaining.delete(s);
    let k = s === 0 ? 1 : 0;
    remaining.delete(k);
    let tour = [s, k];

    while (remaining.size) {
      let bestNode = null;
      let bestPos = -1;
      let bestIncrease = Infinity;

      for (const v of remaining) {
        let localBestInc = Infinity;
        let localBestPos = -1;
        for (let i = 0; i < tour.length; i++) {
          const a = tour[i];
          const b = tour[(i + 1) % tour.length];
          const inc = dist(a, v, metric) + dist(v, b, metric) - dist(a, b, metric);
          if (inc < localBestInc) { localBestInc = inc; localBestPos = i + 1; }
        }
        if (localBestInc < bestIncrease) {
          bestIncrease = localBestInc; bestPos = localBestPos; bestNode = v;
        }
      }

      if (bestNode == null) break;
      tour.splice(bestPos, 0, bestNode);
      remaining.delete(bestNode);
    }
    return tour;
  }

  function randomTour() {
    const arr = [...Array(points.length).keys()];
    for (let i=arr.length-1; i>0; i--){
      const j = seeded != null ? Math.floor(rng()*(i+1)) : Math.floor(Math.random()*(i+1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // ---------- 2-Opt ----------
  function twoOptOnce(order) {
    const n = order.length;
    let bestGain = 0;
    let bestI = -1, bestK = -1;

    const L = (a,b) => dist(order[a], order[b], metric);

    for (let i=0; i < n-2; i++){
      for (let k=i+2; k < n; k++){
        const a = i, b = i+1, c = k-1, d = k;
        if (b >= n || d >= n) continue;

        const oldLen = L(a,b) + L(c,d);
        const newLen = L(a,c) + L(b,d);
        const gain = oldLen - newLen;

        if (gain > bestGain + 1e-12) {
          bestGain = gain; bestI = b; bestK = c;
        }
      }
    }
    if (bestGain > 0) {
      const newOrder = order.slice();
      let i = bestI, k = bestK;
      while (i < k) {
        [newOrder[i], newOrder[k]] = [newOrder[k], newOrder[i]];
        i++; k--;
      }
      return { improved: true, order: newOrder, gain: bestGain };
    }
    return { improved: false, order, gain: 0 };
  }

  async function twoOptImprove(stepMode=false) {
    if (!route.length) return;
    improving = true; stopFlag = false;

    const t0 = performance.now();
    let iterations = 0;
    while (!stopFlag) {
      const res = twoOptOnce(route);
      iterations++;

      if (res.improved) {
        route = res.order;
        render();
        setStats({ method: `${statMethod.textContent}`, timeMs: performance.now()-t0 });
        updateExplanation({
          methodKey: algoSelect.value,
          improveKey: '2opt',
          metricKey: metricSelect.value
        });

        // OSRM neu berechnen, falls aktiv
        if (routeMode === 'osrm') await computeOsrmForCurrentRoute();

        if (stepMode) {
          showToast(`2-Opt Schritt: Δ verbessert ✓`, { ok:true });
          break;
        }
        await new Promise(r => setTimeout(r, 0));
      } else {
        if (stepMode) showToast('2-Opt: keine weitere Verbesserung gefunden.', { warn:true });
        else showToast(`2-Opt fertig in ${iterations} Iterationen.`, { ok:true });
        break;
      }
    }
    improving = false; stopFlag = false;
  }

  // ---------- Parsing ----------
  function parseTextToPoints(text) {
    const trimmed = text.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const data = JSON.parse(trimmed);
        const arr = Array.isArray(data) ? data : (Array.isArray(data.points) ? data.points : null);
        if (!arr) throw new Error('JSON nicht erkannt');
        return toXYArray(arr);
      } catch (e) { /* CSV-Fallback */ }
    }
    const lines = trimmed.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return [];
    const headerTokens = tokenizeCSV(lines[0]);
    const headerLower = headerTokens.map(s => s.toLowerCase());
    const headerLooksLike =
      headerLower.includes('lat') || headerLower.includes('lon') ||
      headerLower.includes('latitude') || headerLower.includes('longitude') ||
      headerLower.includes('x') || headerLower.includes('y');

    const rows = headerLooksLike ? lines.slice(1) : lines;
    const out = [];
    for (const line of rows) {
      const toks = tokenizeCSV(line);
      if (!toks.length) continue;

      if (headerLooksLike) {
        const obj = {};
        headerTokens.forEach((h, idx) => { obj[h.trim().toLowerCase()] = toks[idx]; });

        let x, y, label;
        if (obj.longitude!=null || obj.lon!=null) x = parseFloat(obj.longitude ?? obj.lon);
        if (obj.latitude!=null || obj.lat!=null) y = parseFloat(obj.latitude ?? obj.lat);
        if (obj.x!=null) x = parseFloat(obj.x);
        if (obj.y!=null) y = parseFloat(obj.y);
        label = obj.label ?? obj.name ?? null;

        if (isFinite(x) && isFinite(y)) out.push({ x, y, label: label ?? `P${out.length}` });
      } else {
        const [a,b,...rest] = toks;
        const n1 = parseFloat(a);
        const n2 = parseFloat(b);
        if (isFinite(n1) && isFinite(n2)) {
          const label = rest && rest.length ? rest.join(' ').trim() : `P${out.length}`;
          out.push({ x: n2, y: n1, label }); // (lat,lon,label?) -> (x=lon, y=lat)
        }
      }
    }
    return out;
  }

  function tokenizeCSV(line) {
    const result = [];
    let i = 0, cur = '', inQuotes = false;
    const push = () => { result.push(cur); cur = ''; };

    while (i < line.length) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i+1] === '"') { cur += '"'; i++; }
          else inQuotes = false;
        } else cur += ch;
      } else {
        if (ch === '"') inQuotes = true;
        else if (ch === ',' || ch === ';' || ch === '\t') push();
        else if (ch === ' ') {
          const next = line[i+1];
          if (next === ' ' && cur === '') { /* skip */ } else cur += ch;
        } else cur += ch;
      }
      i++;
    }
    push();
    return result.map(s => s.trim()).filter(s => s.length>0);
  }

  // ---------- Rendering (Canvas) ----------
  function computeBounds(pts) {
    const xs = pts.map(p => p.x);
    const ys = pts.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    return { minX, maxX, minY, maxY, w: maxX-minX, h: maxY-minY };
  }

  function updateTransform() {
    if (!points.length) return;
    const { padding } = transform;
    const bounds = computeBounds(points);
    const cw = canvas.width, ch = canvas.height;

    const scaleX = (cw - 2*padding) / (bounds.w || 1);
    const scaleY = (ch - 2*padding) / (bounds.h || 1);
    const s = Math.min(scaleX, scaleY);

    transform.scale = s;
    transform.tx = padding - bounds.minX * s;
    transform.ty = padding - bounds.minY * s;
  }

  function worldToCanvas(p) {
    const { scale, tx, ty } = transform;
    return { cx: p.x*scale + tx, cy: p.y*scale + ty };
  }

  function render() {
    ctx.clearRect(0,0,canvas.width, canvas.height);

    if (!points.length) {
      overlay.textContent = 'Füge Punkte hinzu, um zu starten.';
      setStats();
      routeList.innerHTML = '';
      return;
    }
    overlay.textContent = '';

    // Linien
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#8888';
    if (route.length >= 2) {
      ctx.beginPath();
      const start = worldToCanvas(points[route[0]]);
      ctx.moveTo(start.cx, start.cy);
      for (let i=1; i<route.length; i++) {
        const pt = worldToCanvas(points[route[i]]);
        ctx.lineTo(pt.cx, pt.cy);
      }
      if (roundtrip && route.length > 1) {
        const back = worldToCanvas(points[route[0]]);
        ctx.lineTo(back.cx, back.cy);
      }
      ctx.stroke();
    }

    // Punkte
    const r = 4;
    ctx.fillStyle = '#333';
    points.forEach((p, idx) => {
      const { cx, cy } = worldToCanvas(p);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI*2);
      ctx.fill();

      if (renderOptions.numbers) {
        ctx.font = '12px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(String(idx), cx+6, cy+4);
      }
      if (renderOptions.labels && p.label) {
        ctx.font = '12px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(p.label, cx+6, cy-6);
      }
      if (renderOptions.coords) {
        ctx.font = '11px ui-monospace, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        const text = metric==='haversine'
          ? `lat:${p.y.toFixed(5)}, lon:${p.x.toFixed(5)}`
          : `x:${p.x.toFixed(2)}, y:${p.y.toFixed(2)}`;
        ctx.fillText(text, cx+6, cy+18);
      }
    });

    // Liste
    routeList.innerHTML = '';
    route.forEach((idx) => {
      const li = document.createElement('li');
      const p = points[idx];
      const base = p.label ? `${p.label}` : `P${idx}`;
      const extra = metric==='haversine'
        ? ` (lat ${p.y.toFixed(5)}, lon ${p.x.toFixed(5)})`
        : ` (x ${p.x.toFixed(2)}, y ${p.y.toFixed(2)})`;
      li.textContent = base + (renderOptions.coords ? extra : '');
      routeList.appendChild(li);
    });

    setStats({ method: statMethod.textContent, timeMs: null });
  }

  function fitView() {
    if (!points.length) return;
    updateTransform();
    render();
    if (mapVisible) updateMap(true);
  }

  // ---------- Leaflet ----------
  function ensureMap() {
    if (map) return;
    map = L.map('map');
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap-Mitwirkende'
    }).addTo(map);
    markerGroup = L.layerGroup().addTo(map);
  }

  function updateMap(fit=false) {
    ensureMap();
    markerGroup.clearLayers();
    if (lineLayer) { lineLayer.remove(); lineLayer = null; }

    if (!points.length) return;

    if (metric !== 'haversine') {
      showToast('Hinweis: Karte/OSRM erwarten Lat/Lon (Haversine).', { warn:true });
    }

    // Marker (Route-Reihenfolge, oder Rohreihenfolge)
    const order = route.length ? route : [...Array(points.length).keys()];
    const latlngsStraight = order.map(i => [points[i].y, points[i].x]);

    // Marker + Popups
    order.forEach((idx, pos) => {
      const p = points[idx];
      const label = p.label ?? `P${idx}`;
      L.marker([p.y, p.x]).addTo(markerGroup)
        .bindPopup(`<b>${pos+1}.</b> ${label}<br/>${metric==='haversine'
          ? `lat ${p.y.toFixed(5)}, lon ${p.x.toFixed(5)}`
          : `x ${p.x.toFixed(2)}, y ${p.y.toFixed(2)}`}`);
    });

    // Polyline: OSRM oder straight
    if (routeMode === 'osrm' && osrmGeometry && osrmGeometry.length) {
      lineLayer = L.polyline(osrmGeometry, { weight: 4 }).addTo(markerGroup);
    } else {
      const path = latlngsStraight.slice();
      if (roundtrip && path.length > 1) path.push(path[0]);
      lineLayer = L.polyline(path, { weight: 3 }).addTo(markerGroup);
    }

    if (fit) {
      const bounds = lineLayer.getBounds();
      if (bounds.isValid()) map.fitBounds(bounds.pad(0.15));
    }
  }

  // ---------- OSRM ----------
  const OSRM_BASE = 'https://router.project-osrm.org';

  function osrmRouteURL(sequence) {
    // sequence: [[lon,lat], ...]
    const coords = sequence.map(([lon,lat]) => `${lon},${lat}`).join(';');
    const params = new URLSearchParams({
      overview: 'full',
      geometries: 'geojson',
      annotations: 'false',
      steps: 'false',
      alternatives: 'false'
    });
    return `${OSRM_BASE}/route/v1/driving/${coords}?${params.toString()}`;
    // Tipp: Für produktive Nutzung besser eigener OSRM-Server oder anderer Routingdienst.
  }

  async function computeOsrmForCurrentRoute() {
    osrmDistanceMeters = null;
    osrmGeometry = null;

    if (!route.length || metric !== 'haversine') {
      // falsches Koordinatensystem
      if (routeMode === 'osrm') showToast('OSRM benötigt Lat/Lon (Haversine).', { warn:true });
      setStats({});
      updateExplanation({
        methodKey: algoSelect.value,
        improveKey: improveSelect.value,
        metricKey: metricSelect.value
      });
      if (mapVisible) updateMap();
      return;
    }

    const coords = route.map(i => [points[i].x, points[i].y]);
    if (roundtrip && route.length > 1) coords.push([points[route[0]].x, points[route[0]].y]);

    try {
      const url = osrmRouteURL(coords);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
      const data = await res.json();
      if (!data || data.code !== 'Ok' || !data.routes || !data.routes.length) {
        throw new Error('OSRM: keine Route gefunden');
      }
      const r = data.routes[0];
      osrmDistanceMeters = r.distance || null;
      // GeoJSON coords sind [lon,lat]; Leaflet erwartet [lat,lon]
      osrmGeometry = (r.geometry && r.geometry.coordinates)
        ? r.geometry.coordinates.map(([lon,lat]) => [lat,lon])
        : null;

      setStats({});
      updateExplanation({
        methodKey: algoSelect.value,
        improveKey: improveSelect.value,
        metricKey: metricSelect.value
      });
      if (mapVisible) updateMap();
      showToast('OSRM-Route berechnet.', { ok:true });
    } catch (e) {
      osrmDistanceMeters = null;
      osrmGeometry = null;
      setStats({});
      if (mapVisible) updateMap();
      showToast(`OSRM-Fehler: ${e.message}`, { err:true });
    }
  }

  // ---------- Export ----------
  function download(filename, content, type='text/plain') {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  function exportCSV() {
    if (!route.length) return;
    const header = metric==='haversine' ? 'lat,lon,label\n' : 'x,y,label\n';
    const lines = route.map(i => {
      const p = points[i];
      const a = metric==='haversine' ? p.y : p.x;
      const b = metric==='haversine' ? p.x : p.y;
      const lab = p.label ?? '';
      return `${a},${b},${escapeCSV(lab)}`;
    });
    if (roundtrip && route.length > 1) {
      const p = points[route[0]];
      const a = metric==='haversine' ? p.y : p.x;
      const b = metric==='haversine' ? p.x : p.y;
      lines.push(`${a},${b},${escapeCSV(p.label ?? '')}`);
    }
    download('route.csv', header + lines.join('\n'), 'text/csv;charset=utf-8');
  }

  function escapeCSV(s){
    if (s == null) return '';
    const needs = /[",\n]/.test(s);
    return needs ? `"${s.replace(/"/g,'""')}"` : s;
  }

  function exportJSON() {
    if (!route.length) return;
    // Bevorzugt OSRM-Geometrie, sonst Punktfolge
    if (routeMode === 'osrm' && osrmGeometry) {
      const gj = {
        type: 'Feature',
        properties: { name: 'TSP Route (OSRM)', metric, roundtrip, routing: 'osrm' },
        geometry: { type: 'LineString', coordinates: osrmGeometry.map(([lat,lon])=>[lon,lat]) }
      };
      download('route.json', JSON.stringify(gj, null, 2), 'application/json');
      return;
    }
    const arr = route.map(i => points[i]);
    if (roundtrip && route.length > 1) arr.push(points[route[0]]);
    download('route.json', JSON.stringify(arr, null, 2), 'application/json');
  }

  function exportGeoJSON() {
    if (!route.length) return;
    if (routeMode === 'osrm' && osrmGeometry) {
      const gj = {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { name: 'TSP Route (OSRM)', metric, roundtrip, routing: 'osrm' },
            geometry: {
              type: 'LineString',
              coordinates: osrmGeometry.map(([lat,lon])=>[lon,lat])
            }
          }
        ]
      };
      download('route.geojson', JSON.stringify(gj, null, 2), 'application/geo+json');
      return;
    }
    const coords = route.map(i => [points[i].x, points[i].y]);
    if (roundtrip && route.length > 1) coords.push([points[route[0]].x, points[route[0]].y]);
    const gj = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { name: 'TSP Route', metric, roundtrip, routing: 'straight' },
          geometry: { type: 'LineString', coordinates: coords }
        }
      ]
    };
    download('route.geojson', JSON.stringify(gj, null, 2), 'application/geo+json');
  }

  function exportGPX() {
    if (!route.length) return;
    if (routeMode === 'osrm' && osrmGeometry) {
      const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TSP Routenplaner" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>TSP Route (OSRM)</name>
    <trkseg>
${osrmGeometry.map(([lat,lon]) => `      <trkpt lat="${lat}" lon="${lon}"></trkpt>`).join('\n')}
    </trkseg>
  </trk>
</gpx>`;
      download('route.gpx', gpx, 'application/gpx+xml');
      return;
    }
    const seq = route.map(i => points[i]);
    if (roundtrip && route.length > 1) seq.push(points[route[0]]);
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TSP Routenplaner" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>TSP Route</name>
    <trkseg>
${seq.map(p => `      <trkpt lat="${p.y}" lon="${p.x}"></trkpt>`).join('\n')}
    </trkseg>
  </trk>
</gpx>`;
    download('route.gpx', gpx, 'application/gpx+xml');
  }

function printResult() {
  if (!points.length) {
    showToast('Keine Punkte vorhanden.', { warn:true });
    return;
  }

  // Daten einsammeln
  const now = new Date();
  const dateStr = now.toLocaleString();
  const methodText = statMethod.textContent || '–';
  const distText = statDistance.textContent || '–';

  // Ergebnisliste aufbereiten (immer Label + Koordinate)
  const rows = (route.length ? route : [...Array(points.length).keys()]).map((idx, pos) => {
    const p = points[idx];
    const label = p.label ?? `P${idx}`;
    const coord = (metric === 'haversine')
      ? `lat ${p.y.toFixed(5)}, lon ${p.x.toFixed(5)}`
      : `x ${p.x.toFixed(2)}, y ${p.y.toFixed(2)}`;
    return `<li><strong>${pos+1}.</strong> ${escapeHTML(label)} <span style="opacity:.8">(${coord})</span></li>`;
  }).join('');

  // Optional: Canvas als Bild einbetten (wenn Route existiert)
  let canvasImgHTML = '';
  try {
    if (route.length) {
      const dataURL = canvas.toDataURL('image/png');
      canvasImgHTML = `<div style="margin-top:12px"><img src="${dataURL}" alt="Routen-Canvas" style="max-width:100%;border:1px solid #ddd;border-radius:8px"/></div>`;
    }
  } catch(_) { /* kann ignoriert werden (Cross-Origin etc.) */ }

  // Druck-HTML
  const html = `
<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>TSP Ergebnis – Druck</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root{ --fg:#111; --muted:#555; --border:#e5e7eb; }
  body{ font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color:var(--fg); margin:24px; }
  h1{ margin:0 0 4px; font-size:20px; }
  .meta{ color:var(--muted); margin:0 0 12px; }
  .block{ border:1px solid var(--border); border-radius:12px; padding:16px; margin:12px 0; }
  .grid{ display:grid; grid-template-columns: repeat(auto-fit, minmax(220px,1fr)); gap:8px; }
  .stat b{ display:block; font-size:12px; color:var(--muted); }
  .stat span{ font-size:14px; }
  ol{ margin:10px 0 0 20px; }
  li{ margin:2px 0; }
  .footnote{ margin-top:8px; color:var(--muted); font-size:12px; }
  @media print { .noprint{ display:none } }
</style>
</head>
<body>
  <h1>Ergebnisliste – TSP</h1>
  <p class="meta">${dateStr}</p>

  <section class="block">
    <div class="grid">
      <div class="stat"><b>Methode</b><span>${escapeHTML(methodText)}</span></div>
      <div class="stat"><b>Gesamtdistanz</b><span>${escapeHTML(distText)}</span></div>
      <div class="stat"><b>Punkte</b><span>${points.length}</span></div>
    </div>
    ${canvasImgHTML}
  </section>

  <section class="block">
    <h2 style="margin:0 0 8px; font-size:16px">Reihenfolge</h2>
    <ol>${rows}</ol>
  </section>

  <p class="footnote">Generiert mit deinem TSP Routenplaner.</p>

  <script>
    window.onload = () => { window.print(); };
  </script>
</body>
</html>`.trim();

  // Neues Fenster öffnen und drucken
  const w = window.open('', '_blank');
  if (!w) { showToast('Popup blockiert? Erlaube Popups zum Drucken.', { warn:true }); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
  try { w.focus(); } catch(_) {}
}
function escapeHTML(s=''){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

   
  // ---------- Actions ----------
  function clearOsrmCache() {
    osrmDistanceMeters = null;
    osrmGeometry = null;
  }

  function applyPoints(newPts, {gridSnap=0}={}) {
    points = snapToGrid(toXYArray(newPts), gridSnap);
    route = [];
    clearOsrmCache();
    fitView();
    setStats();
    updateExplanation({
      methodKey: algoSelect.value,
      improveKey: improveSelect.value,
      metricKey: metricSelect.value
    });
    if (mapVisible) updateMap(true);
    showToast(`${points.length} Punkt(e) geladen.`, { ok:true });
  }

  function parseFromTextarea() {
    try {
      const grid = Number($('#gridSnap')?.value || 0) || 0;
      const arr = parseTextToPoints(coordsInput.value);
      applyPoints(arr, {gridSnap: grid});
    } catch (e) {
      showToast(`Fehler beim Einlesen: ${e.message}`, { err:true });
    }
  }

  function parseFromFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      coordsInput.value = reader.result;
      parseFromTextarea();
    };
    reader.onerror = () => showToast('Datei konnte nicht gelesen werden.', { err:true });
    reader.readAsText(file, 'utf-8');
  }

  async function solve() {
    if (points.length < 2) { showToast('Bitte zuerst mindestens 2 Punkte eingeben.', { warn:true }); return; }
    metric = metricSelect.value;
    roundtrip = !!chkRoundtrip.checked;
    routeMode = (routeModeSelect?.value || 'straight');

    // OSRM braucht Haversine/LatLon
    if (routeMode === 'osrm' && metric !== 'haversine') {
      metric = 'haversine';
      metricSelect.value = 'haversine';
      showToast('OSRM benötigt Lat/Lon. Metrik auf Haversine gesetzt.', { warn:true });
    }

    const seedVal = Number($('#seed')?.value);
    seeded = Number.isFinite(seedVal) ? (seedVal >>> 0) : null;

    const useFixed = chkFixStart.checked;
    const startIdxRaw = Number(startIndexEl.value);
    const startIdx = Number.isFinite(startIdxRaw) ? clamp(startIdxRaw, 0, points.length-1) : 0;

    const algo = algoSelect.value;
    const t0 = performance.now();

    let initial = [];
    if (algo === 'nearest') initial = nearestNeighbor(useFixed ? startIdx : 0);
    else if (algo === 'insertion') initial = cheapestInsertion(useFixed ? startIdx : 0);
    else initial = randomTour();

    if (useFixed) {
      const pos = initial.indexOf(startIdx);
      if (pos > 0) initial = initial.slice(pos).concat(initial.slice(0, pos));
      fixedStart = true;
      fixedStartIndex = startIdx;
    } else {
      fixedStart = false;
      fixedStartIndex = null;
    }

    route = initial;
    clearOsrmCache();
    const dt = performance.now() - t0;
    setStats({ method: algoLabel(algo), timeMs: dt });
    render();
    updateExplanation({
      methodKey: algoSelect.value,
      improveKey: improveSelect.value,
      metricKey: metricSelect.value
    });
    if (mapVisible) updateMap(true);

    if (routeMode === 'osrm') await computeOsrmForCurrentRoute();
    if (improveSelect.value === '2opt') await twoOptImprove(false);
  }

  function algoLabel(a) {
    if (a === 'nearest') return 'Nearest Neighbor';
    if (a === 'insertion') return 'Cheapest Insertion';
    return 'Random';
  }

  function resetAll() {
    route = [];
    clearOsrmCache();
    render();
    setStats();
    updateExplanation({
      methodKey: algoSelect.value,
      improveKey: improveSelect.value,
      metricKey: metricSelect.value
    });
    if (mapVisible) updateMap(true);
    showToast('Zurückgesetzt.');
  }

  // ---------- Geocoding (Nominatim) ----------
  async function geocodeOne(query) {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '1');
    url.searchParams.set('q', query);
    const res = await fetch(url.toString(), { headers: { 'Accept-Language': 'de' } });
    if (!res.ok) throw new Error(`Geocoding-Fehler (${res.status})`);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    const hit = data[0];
    return {
      lat: parseFloat(hit.lat),
      lon: parseFloat(hit.lon),
      label: hit.display_name || query
    };
  }

  async function geocodeAddresses() {
    const lines = (addrInput.value || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!lines.length) { showToast('Keine Adressen eingegeben.', { warn:true }); return; }

    showToast(`Geocoding gestartet (${lines.length})…`);
    const results = [];
    for (let i=0; i<lines.length; i++) {
      const q = lines[i];
      try {
        const res = await geocodeOne(q);
        if (res) {
          results.push(res);
          showToast(`✓ ${q}`, { ok:true });
        } else {
          showToast(`❓ Keine Treffer: ${q}`, { warn:true });
        }
      } catch (e) {
        showToast(`⚠️ Fehler bei „${q}“: ${e.message}`, { err:true });
      }
      await new Promise(r => setTimeout(r, 600));
    }

    if (!results.length) {
      showToast('Keine Adressen geocodiert.', { warn:true });
      return;
    }

    const header = 'lat,lon,label\n';
    const csv = header + results.map(r => `${r.lat},${r.lon},"${r.label.replace(/"/g,'""')}"`).join('\n');
    coordsInput.value = csv;
    metricSelect.value = 'haversine';
    parseFromTextarea();
    showToast(`Geocoding fertig: ${results.length} Treffer.`, { ok:true });

    if (!mapVisible) toggleMap(true);
  }

  // ---------- Events ----------
  window.addEventListener('resize', fitView);

  btnParse?.addEventListener('click', parseFromTextarea);
  btnClear?.addEventListener('click', () => { coordsInput.value=''; showToast('Eingabe geleert.'); });
  btnSample?.addEventListener('click', () => {
    const demo = [
      {lat:52.5200, lon:13.4050, label:'Berlin'},
      {lat:48.8566, lon:2.3522, label:'Paris'},
      {lat:51.5074, lon:-0.1278, label:'London'},
      {lat:41.9028, lon:12.4964, label:'Rom'},
      {lat:40.4168, lon:-3.7038, label:'Madrid'},
      {lat:50.1109, lon:8.6821, label:'Frankfurt'},
      {lat:52.2297, lon:21.0122, label:'Warschau'},
      {lat:59.3293, lon:18.0686, label:'Stockholm'},
      {lat:60.1699, lon:24.9384, label:'Helsinki'},
      {lat:45.4642, lon:9.1900, label:'Mailand'},
    ];
    coordsInput.value = 'lat,lon,label\n' + demo.map(p=>`${p.lat},${p.lon},${p.label}`).join('\n');
    metricSelect.value = 'haversine';
    parseFromTextarea();
  });

  btnGeocode?.addEventListener('click', geocodeAddresses);

  fileInput?.addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) parseFromFile(f);
  });

  btnSolve?.addEventListener('click', () => { solve(); });
  btnImprove?.addEventListener('click', () => twoOptImprove(false));
  btnStep?.addEventListener('click', () => twoOptImprove(true));
  btnStop?.addEventListener('click', () => { stopFlag = true; improving = false; showToast('Stop angefordert.'); });
  btnReset?.addEventListener('click', resetAll);

  btnExportCSV?.addEventListener('click', exportCSV);
  btnExportJSON?.addEventListener('click', exportJSON);
  btnExportGeoJSON?.addEventListener('click', exportGeoJSON);
  btnExportGPX?.addEventListener('click', exportGPX);

  btnFit?.addEventListener('click', fitView);
  btnToggleLabels?.addEventListener('click', () => { renderOptions.labels = !renderOptions.labels; render(); if (mapVisible) updateMap(); });
  btnToggleNumbers?.addEventListener('click', () => { renderOptions.numbers = !renderOptions.numbers; render(); if (mapVisible) updateMap(); });
  btnToggleCoords?.addEventListener('click', () => { renderOptions.coords = !renderOptions.coords; render(); if (mapVisible) updateMap(); });

  function toggleMap(forceVisible=null){
    if (forceVisible !== null) mapVisible = !!forceVisible;
    else mapVisible = !mapVisible;
    mapEl.style.display = mapVisible ? '' : 'none';
    if (mapVisible) {
      ensureMap();
      setTimeout(()=> {
        map.invalidateSize();
        updateMap(true);
      }, 0);
    }
  }
  btnToggleMap?.addEventListener('click', () => toggleMap());

  linkAbout?.addEventListener('click', (e)=>{ e.preventDefault(); aboutDialog.showModal(); });
  yearEl.textContent = new Date().getFullYear();

  // Live-Updates: Metrik / Optionen / Routing
  metricSelect.addEventListener('change', () => {
    metric = metricSelect.value;
    clearOsrmCache();
    updateExplanation({
      methodKey: algoSelect.value,
      improveKey: improveSelect.value,
      metricKey: metricSelect.value
    });
    render();
    if (mapVisible) updateMap();
  });
  algoSelect.addEventListener('change', () => {
    updateExplanation({
      methodKey: algoSelect.value,
      improveKey: improveSelect.value,
      metricKey: metricSelect.value
    });
  });
  improveSelect.addEventListener('change', () => {
    updateExplanation({
      methodKey: algoSelect.value,
      improveKey: improveSelect.value,
      metricKey: metricSelect.value
    });
  });
  chkRoundtrip.addEventListener('change', async () => {
    roundtrip = !!chkRoundtrip.checked;
    render();
    clearOsrmCache();
    if (routeMode === 'osrm' && route.length) await computeOsrmForCurrentRoute();
    setStats({});
    updateExplanation({
      methodKey: algoSelect.value,
      improveKey: improveSelect.value,
      metricKey: metricSelect.value
    });
  });
  routeModeSelect.addEventListener('change', async () => {
    routeMode = routeModeSelect.value || 'straight';
    if (routeMode === 'osrm' && metric !== 'haversine') {
      metric = 'haversine';
      metricSelect.value = 'haversine';
      showToast('OSRM benötigt Lat/Lon. Metrik auf Haversine gesetzt.', { warn:true });
    }
    clearOsrmCache();
    if (routeMode === 'osrm' && route.length) await computeOsrmForCurrentRoute();
    setStats({});
    updateExplanation({
      methodKey: algoSelect.value,
      improveKey: improveSelect.value,
      metricKey: metricSelect.value
    });
    if (mapVisible) updateMap();
  });

  // Initial
  fitView();
  updateExplanation({
    methodKey: algoSelect.value,
    improveKey: improveSelect.value,
    metricKey: metricSelect.value
  });

  // Drag&Drop
  document.addEventListener('dragover', (e)=>{ e.preventDefault(); });
  document.addEventListener('drop', (e)=>{
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) parseFromFile(f);
  });
btnPrint?.addEventListener('click', printResult);

})();
