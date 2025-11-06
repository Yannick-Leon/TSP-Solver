/* ================================
   TSP Routenplaner – app.js
   CSV/JSON-Import, Heuristiken, 2-Opt,
   Haversine/Euklid, Canvas-Render, Exporte
   + Mini-Erklärungen im Ergebnis
   ================================ */

(() => {
  // ---------- DOM ----------
  const $ = (sel) => document.querySelector(sel);

  const coordsInput = $('#coordsInput');
  const fileInput   = $('#fileInput');
  const btnParse    = $('#btnParse');
  const btnClear    = $('#btnClear');
  const btnSample   = $('#btnSample');

  const metricSelect = $('#metricSelect');
  const algoSelect   = $('#algoSelect');
  const chkFixStart  = $('#chkFixStart');
  const startIndexEl = $('#startIndex');
  const improveSelect= $('#improveSelect');

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
  const explainEl = document.querySelector('#explainText'); // NEU: Erklärfeld

  // ---------- State ----------
  let points = [];          // [{x,y, label?}]
  let route = [];           // [indices]
  let metric = 'euclidean'; // 'euclidean' | 'haversine'
  let fixedStart = false;
  let fixedStartIndex = null;
  let renderOptions = { labels: false, numbers: true, coords: false };

  // 2-Opt Step/Stop
  let improving = false;
  let stopFlag = false;
  let last2OptState = null; // {i,j, improved}

  // Drawing transform cache
  let transform = { scale: 1, tx: 0, ty: 0, padding: 24 };

  // RNG (optional seed)
  let seeded = null;
  const rng = () => (seeded = (seeded * 1664525 + 1013904223) % 4294967296) / 4294967296;

  // ---------- Kurze Erklärtexte ----------
  const DESCRIPTIONS = {
    metric: {
      euclidean: 'Euklidische Distanz (x/y) – geeignet für flache Karten/Konstruktionspunkte.',
      haversine: 'Haversine (Lat/Lon) – Kugelabstand auf der Erde in Metern/Kilometern.'
    },
    algo: {
      nearest: 'Nearest Neighbor: startet an einem Punkt und nimmt jeweils den nächstgelegenen unbesuchten Punkt (greedy, sehr schnell, kann lokale Minima haben).',
      insertion: 'Cheapest Insertion: baut die Route schrittweise, indem der jeweils günstigste Einfügeplatz gewählt wird (oft bessere Starttour).',
      random: 'Zufällige Tour: dient als Baseline/Benchmark; Qualität variiert stark.'
    },
    improve: {
      '2opt': '2-Opt: tauscht Kantenpaare lokal aus, solange die Gesamtdistanz sinkt (schnell & oft großer Gewinn).',
      'none': 'Keine Verbesserung: reine Startheuristik ohne lokale Optimierung.'
    }
  };

  // ---------- Utils ----------
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const sum = (arr) => arr.reduce((a,b)=>a+b,0);

  function showToast(msg, { ok=false, warn=false, err=false } = {}) {
    toast.textContent = msg;
    toast.style.borderLeftColor = err ? '#ef4444' : warn ? '#f59e0b' : ok ? '#16a34a' : 'var(--primary)';
    toast.classList.add('show');
    setTimeout(()=>toast.classList.remove('show'), 2600);
  }

  function setStats({ method='–', timeMs=null } = {}) {
    statNodes.textContent = points.length;
    statMethod.textContent = method;
    statDistance.textContent = route.length ? formatDistance(tourLength(route, metric)) : '–';
    statTime.textContent = timeMs==null ? '–' : `${timeMs.toFixed(1)} ms`;
  }

  function updateExplanation({ methodKey, improveKey, metricKey }) {
    if (!explainEl) return;
    const m = DESCRIPTIONS.metric[metricKey] ?? '';
    const a = DESCRIPTIONS.algo[methodKey] ?? methodKey;
    const i = DESCRIPTIONS.improve[improveKey] ?? '';
    const distText = route.length ? `Aktuelle Gesamtdistanz: ${formatDistance(tourLength(route, metric))}.` : '';
    explainEl.textContent = `${a}${improveKey !== 'none' ? ' + ' + i : ''} • ${m} ${distText}`;
  }

  function formatDistance(d) {
    // Bei Haversine: Meter/Kilometer. Euklidisch: Einheitenlos -> 2–3 Nachkommastellen
    if (metric === 'haversine') {
      if (d >= 1000) return `${(d/1000).toFixed(2)} km`;
      return `${d.toFixed(1)} m`;
    }
    return d.toFixed(3);
  }

  function hasLatLonLike(p) {
    return p.lat !== undefined && p.lon !== undefined;
  }

  function toXYArray(srcPoints) {
    // Wenn lat/lon, dann in {x: lon, y: lat}
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
      // array [a,b] -> interpret as x,y (oder lat,lon – Metrik wählt später)
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

  // ---------- Distance Metrics ----------
  function dist(i, j, metricMode) {
    const a = points[i], b = points[j];
    if (metricMode === 'haversine') {
      // a.y=lat, a.x=lon
      return haversine(a.y, a.x, b.y, b.x);
    }
    // Euclidean
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.hypot(dx, dy);
  }

  function tourLength(order, metricMode) {
    if (order.length < 2) return 0;
    let s = 0;
    for (let i = 0; i < order.length - 1; i++) s += dist(order[i], order[i+1], metricMode);
    // Offene Tour (kein Rücksprung)
    return s;
  }

  // Haversine (Meter)
  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth radius in meters
    const toRad = (d) => d * Math.PI / 180;
    const φ1 = toRad(lat1), φ2 = toRad(lat2);
    const Δφ = toRad(lat2 - lat1);
    const Δλ = toRad(lon2 - lon1);

    const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  // ---------- Heuristics ----------
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

    // Start mit kleinem Zyklus: [s, k]
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
          const b = tour[(i + 1) % tour.length]; // zyklisch für Bewertung
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
    return tour; // Offene Route belassen
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
          bestGain = gain; bestI = b; bestK = c; // Reverse Segment [i+1..k-1]
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
        setStats({ method: `${statMethod.textContent} + 2-Opt`, timeMs: performance.now()-t0 });
        updateExplanation({
          methodKey: algoSelect.value,
          improveKey: '2opt',
          metricKey: metricSelect.value
        });

        if (stepMode) {
          last2OptState = { improved: true };
          showToast(`2-Opt Schritt: Δ = −${formatDistance(res.gain)} ✓`, { ok:true });
          break; // nur ein Schritt
        }
        await new Promise(r => setTimeout(r, 0));
      } else {
        last2OptState = { improved: false };
        if (stepMode) {
          showToast('2-Opt: keine weitere Verbesserung gefunden.', { warn:true });
        } else {
          showToast(`2-Opt fertig in ${iterations} Iterationen.`, { ok:true });
        }
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
      } catch (e) {
        // fällt zurück auf CSV
      }
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
          out.push({ x: n2, y: n1, label }); // Standard: (lat,lon,label?) -> (x=lon, y=lat)
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
        } else {
          cur += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',' || ch === ';' || ch === '\t') {
          push();
        } else if (ch === ' ') {
          const next = line[i+1];
          if (next === ' ' && cur === '') {
            // skip führende Mehrfach-Spaces
          } else {
            cur += ch;
          }
        } else {
          cur += ch;
        }
      }
      i++;
    }
    push();
    return result.map(s => s.trim()).filter(s => s.length>0);
  }

  // ---------- Rendering ----------
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
    download('route.csv', header + lines.join('\n'), 'text/csv;charset=utf-8');
  }

  function escapeCSV(s){
    if (s == null) return '';
    const needs = /[",\n]/.test(s);
    return needs ? `"${s.replace(/"/g,'""')}"` : s;
  }

  function exportJSON() {
    if (!route.length) return;
    const arr = route.map(i => points[i]);
    download('route.json', JSON.stringify(arr, null, 2), 'application/json');
  }

  function exportGeoJSON() {
    if (!route.length) return;
    const coords = route.map(i => {
      const p = points[i];
      return [p.x, p.y];
    });
    const gj = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { name: 'TSP Route', metric },
          geometry: { type: 'LineString', coordinates: coords }
        }
      ]
    };
    download('route.geojson', JSON.stringify(gj, null, 2), 'application/geo+json');
  }

  function exportGPX() {
    if (!route.length) return;
    if (metric !== 'haversine') {
      showToast('GPX ist für Lat/Lon gedacht (Haversine). Export erfolgt dennoch mit x/y als lon/lat.', { warn:true });
    }
    const pts = route.map(i => points[i]);
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TSP Routenplaner" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>TSP Route</name>
    <trkseg>
${pts.map(p => `      <trkpt lat="${p.y}" lon="${p.x}"></trkpt>`).join('\n')}
    </trkseg>
  </trk>
</gpx>`;
    download('route.gpx', gpx, 'application/gpx+xml');
  }

  // ---------- Actions ----------
  function applyPoints(newPts, {gridSnap=0}={}) {
    points = snapToGrid(toXYArray(newPts), gridSnap);
    route = [];
    fitView();
    setStats();
    updateExplanation({
      methodKey: algoSelect.value,
      improveKey: improveSelect.value,
      metricKey: metricSelect.value
    });
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

  function solve() {
    if (points.length < 2) { showToast('Bitte zuerst mindestens 2 Punkte eingeben.', { warn:true }); return; }
    metric = metricSelect.value;

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
      if (pos > 0) {
        initial = initial.slice(pos).concat(initial.slice(0, pos));
      }
      fixedStart = true;
      fixedStartIndex = startIdx;
    } else {
      fixedStart = false;
      fixedStartIndex = null;
    }

    route = initial;
    const dt = performance.now() - t0;
    setStats({ method: algoLabel(algo), timeMs: dt });
    render();

    updateExplanation({
      methodKey: algoSelect.value,
      improveKey: improveSelect.value,
      metricKey: metricSelect.value
    });

    if (improveSelect.value === '2opt') {
      twoOptImprove(false);
    }
  }

  function algoLabel(a) {
    if (a === 'nearest') return 'Nearest Neighbor';
    if (a === 'insertion') return 'Cheapest Insertion';
    return 'Random';
  }

  function resetAll() {
    route = [];
    render();
    setStats();
    updateExplanation({
      methodKey: algoSelect.value,
      improveKey: improveSelect.value,
      metricKey: metricSelect.value
    });
    showToast('Zurückgesetzt.');
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
    parseFromTextarea();
    metricSelect.value = 'haversine';
    updateExplanation({
      methodKey: algoSelect.value,
      improveKey: improveSelect.value,
      metricKey: metricSelect.value
    });
  });

  fileInput?.addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) parseFromFile(f);
  });

  btnSolve?.addEventListener('click', solve);
  btnImprove?.addEventListener('click', () => twoOptImprove(false));
  btnStep?.addEventListener('click', () => twoOptImprove(true));
  btnStop?.addEventListener('click', () => { stopFlag = true; improving = false; showToast('Stop angefordert.'); });
  btnReset?.addEventListener('click', resetAll);

  btnExportCSV?.addEventListener('click', exportCSV);
  btnExportJSON?.addEventListener('click', exportJSON);
  btnExportGeoJSON?.addEventListener('click', exportGeoJSON);
  btnExportGPX?.addEventListener('click', exportGPX);

  btnFit?.addEventListener('click', fitView);
  btnToggleLabels?.addEventListener('click', () => { renderOptions.labels = !renderOptions.labels; render(); });
  btnToggleNumbers?.addEventListener('click', () => { renderOptions.numbers = !renderOptions.numbers; render(); });
  btnToggleCoords?.addEventListener('click', () => { renderOptions.coords = !renderOptions.coords; render(); });

  linkAbout?.addEventListener('click', (e)=>{ e.preventDefault(); aboutDialog.showModal(); });
  yearEl.textContent = new Date().getFullYear();

  // Live-Update der Erklärungen bei Optionswechsel
  metricSelect.addEventListener('change', () => {
    metric = metricSelect.value;
    updateExplanation({
      methodKey: algoSelect.value,
      improveKey: improveSelect.value,
      metricKey: metricSelect.value
    });
    render(); // Anzeige (Koordinatenformat) könnte sich ändern
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

  // Initial
  fitView();
  updateExplanation({
    methodKey: algoSelect.value,
    improveKey: improveSelect.value,
    metricKey: metricSelect.value
  });

  // ---------- Bonus: Drag&Drop ----------
  document.addEventListener('dragover', (e)=>{ e.preventDefault(); });
  document.addEventListener('drop', (e)=>{
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) parseFromFile(f);
  });

})();
