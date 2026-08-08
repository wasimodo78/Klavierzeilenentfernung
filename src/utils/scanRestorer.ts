// Scan-Restauration: Normalisierung von Fotos/schlechten Scans zu A4.
// Prinzip: Messen → Rektifizieren → Verifizieren. Alle geometrischen Regeln
// in Proportionen (Spatia/Seitenbruchteile), nie in absoluten Pixeln.

export type ScanDebug = {
  orientationVotes: string;
  fineAngleDeg: number;
  split: 'einseitig' | 'doppelseitig';
  splitColumnX: number | null;
  splitEvidence: string;
  stageImages: { label: string, dataUrl: string }[];
};

export type RestoredPage = {
  canvas: HTMLCanvasElement; // normalisierte Seite (Illumination entzerrt)
  debug: ScanDebug;
};

// --- Binarisierung (global, schnell) ---------------------------------------
function binarize(canvas: HTMLCanvasElement): Uint8Array {
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width, h = canvas.height;
  const d = ctx.getImageData(0, 0, w, h).data;
  const bin = new Uint8Array(w * h);
  // Schwellwert grob aus dem Histogramm (Mitte zwischen Peaks, Otsu-ähnlich)
  const hist = new Float64Array(256);
  for (let i = 0; i < d.length; i += 4) hist[Math.floor(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])]++;
  let total = d.length / 4, sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  const mean = sum / total;
  let sumB = 0, wB = 0, maxVar = 0, thr = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (wB === 0) continue;
    const wF = total - wB; if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > maxVar) { maxVar = v; thr = i; }
  }
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    bin[i / 4] = l < thr ? 1 : 0;
  }
  return bin;
}

// --- Hilfs-Helfer: Bitmap drehen (nearest-neighbor, weiss-Auffüllung) --------
function rotateBinary(bin: Uint8Array, w: number, h: number, deg: number): { bin: Uint8Array, w: number, h: number } {
  const rad = deg * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const cx = w / 2, cy = h / 2;
  const cw = Math.ceil(Math.abs(w * cos) + Math.abs(h * sin));
  const ch = Math.ceil(Math.abs(w * sin) + Math.abs(h * cos));
  const out = new Uint8Array(cw * ch);
  const ccx = cw / 2, ccy = ch / 2;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const dx = x - ccx, dy = y - ccy;
      const sx = dx * cos + dy * sin + cx;
      const sy = -dx * sin + dy * cos + cy;
      const xi = Math.round(sx), yi = Math.round(sy);
      if (xi >= 0 && xi < w && yi >= 0 && yi < h) out[y * cw + x] = bin[yi * w + xi];
    }
  }
  return { bin: out, w: cw, h: ch };
}

// --- Groborientierung: 0/90 Grad -------------------------------------------
// Musik hat dominante horizontale Linien; in der falschen Orientierung werden
// aus ihnen kurze/unzureichende Läufe. Miss Staerke langer Läufe beider Lagen.
function horizontalStrength(bin: Uint8Array, w: number, h: number): { score: number, longRuns: number } {
  let score = 0, longRuns = 0;
  const minLong = Math.floor(w * 0.15); // wie MIN_LINE_LENGTH in cvAnalyzer
  for (let y = 0; y < h; y += 3) { // Sampling: jede 3. Zeile reicht
    let run = 0;
    for (let x = 0; x < w; x++) {
      if (bin[y * w + x] === 1) {
        run++;
        if (run === minLong) { longRuns++; score += 1; }
      } else run = 0;
    }
  }
  return { score, longRuns };
}

function transposeBinary(bin: Uint8Array, w: number, h: number): { bin: Uint8Array, w: number, h: number } {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[x * h + y] = bin[y * w + x];
  return { bin: out, w: h, h: w };
}

export function estimateOrientation90(canvas: HTMLCanvasElement): { rotate90: boolean, votes: string } {
  const small = downscale(canvas, 800);
  const bin = binarize(small);
  const w = small.width, h = small.height;
  // Projektive Schärfe: Musik produziert in RICHTIGER Orientierung harte
  // Kontraste zwischen vollen und leeren Zeilen (Staff-Linien + Text),
  // quer dazu schmiert alles auf mittlere Anteile. Kurvenfest: es wird nur
  // gezählt, keine Geradheit verlangt.
  const sharp = (fn: (i: number) => number, n: number): number => {
    let s = 0;
    for (let i = 0; i < n; i += 2) { const v = fn(i); s += v * v; }
    return s;
  };
  const rows = sharp(y => { let b = 0; const o = y * w; for (let x = 0; x < w; x++) b += bin[o + x]; return b; }, h);
  const cols = sharp(x => { let b = 0; for (let y = 0; y < h; y++) b += bin[y * w + x]; return b; }, w);
  const votes = `0°=${(rows / 1e9).toFixed(2)} 90°=${(cols / 1e9).toFixed(2)}`;
  return { rotate90: cols > rows * 1.1, votes };
}

// --- Feinwinkel über Projektionsschärfe ------------------------------------
export function rotateCanvas(src: HTMLCanvasElement, deg: number): HTMLCanvasElement {
  const rad = deg * Math.PI / 180;
  const out = document.createElement('canvas');
  out.width = src.width; out.height = src.height;
  const octx = out.getContext('2d')!;
  octx.fillStyle = 'white';
  octx.fillRect(0, 0, out.width, out.height);
  octx.translate(src.width / 2, src.height / 2);
  octx.rotate(rad);
  octx.drawImage(src, -src.width / 2, -src.height / 2);
  return out;
}

function projectionSharpness(canvas: HTMLCanvasElement): number {
  const bin = binarize(canvas);
  const w = canvas.width, h = canvas.height;
  let score = 0;
  for (let y = 0; y < h; y += 2) {
    let rowBlack = 0;
    for (let x = 0; x < w; x++) rowBlack += bin[y * w + x];
    score += rowBlack * rowBlack;
  }
  return score;
}

export function estimateFineAngle(canvas: HTMLCanvasElement): { angleDeg: number, votes: string } {
  const small = downscale(canvas, 900);
  const bin0 = binarize(small);
  const sharpOf = (deg: number): number => {
    const r = rotateBinary(bin0, small.width, small.height, deg);
    let score = 0;
    for (let y = 0; y < r.h; y += 2) {
      let b = 0;
      const o = y * r.w;
      for (let x = 0; x < r.w; x++) b += r.bin[o + x];
      score += b * b;
    }
    return score;
  };
  let best = 0, bestScore = -Infinity;
  const coarse: [number, number][] = [];
  for (let a = -20; a <= 20; a += 1) {
    const s = sharpOf(a);
    coarse.push([a, s]);
    if (s > bestScore) { bestScore = s; best = a; }
  }
  for (let a = best - 0.75; a <= best + 0.75; a += 0.05) {
    const s = sharpOf(a);
    if (s > bestScore) { bestScore = s; best = a; }
  }
  // Falls der beste Grobwert am Rand liegt (-20/20), nicht vorzeitig glauben
  const edge = Math.abs(best) >= 19.9;
  return { angleDeg: edge ? best : best, votes: coarse.map(([a, s]) => `${a}°:${(s / 1e9).toFixed(2)}`).join(' ') + (edge ? ' [RAND!]' : '') };
}

// --- Perspektivische Rektifizierung über Papierkontur -----------------------
// Hintergrund/Ecken: Finde die Papier-Ecken als Extrempunkte der hellen
// Flaeche (Papier hell, Untergrund dunkler). Ecken-Signatur via
// Richtungsmaxima (TL min x+y, TR max x-y, BR max x+y, BL min x-y).
function luminanceGrid(canvas: HTMLCanvasElement): { w: number, h: number, lum: Float32Array } {
  const w = canvas.width, h = canvas.height;
  const d = canvas.getContext('2d')!.getImageData(0, 0, w, h).data;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < d.length; i += 4) lum[i / 4] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return { w, h, lum };
}

export function detectPageCorners(canvas: HTMLCanvasElement): { corners: [number, number][] | null, evidence: string } {
  const small = downscale(canvas, 900);
  const { w, h, lum } = luminanceGrid(small);
  // Helligkeitsschwelle adaptiv (Otsu auf abgetasteter Luminance)
  const hist = new Float64Array(256);
  for (let i = 0; i < lum.length; i += 9) hist[Math.floor(lum[i])]++;
  let total = 0, sum = 0;
  for (let i = 0; i < 256; i++) total += hist[i], sum += i * hist[i];
  const mean = sum / total;
  let sumB = 0, wB = 0, best = 0, thr = 160;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; thr = i; }
  }
  // Papier-Maske: Ränder wegen Fensterlicht nicht disqualifizieren -> robuste
  // Mindesthelligkeit Tiefer 5% vom Mittel
  const paperThr = Math.max(thr, mean * 0.55);
  const paper = new Uint8Array(w * h);
  let totalPaper = 0;
  for (let i = 0; i < lum.length; i++) { if (lum[i] >= paperThr) { paper[i] = 1; totalPaper++; } }
  const minPaper = w * h * 0.10; // mind. 10% der Flaeche Papier, sonst keine Kontur
  if (totalPaper < minPaper) return { corners: null, evidence: `Papieranteil ${(totalPaper / (w * h) * 100).toFixed(1)}% < 10%` };
  // Größte zusammenhängende Papier-Flaeche finden (Flood Fill, reuse)
  const visited = new Uint8Array(w * h);
  let bestComp: { px: number[] } | null = null;
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (!paper[start] || visited[start]) continue;
    const comp: number[] = [];
    stack.push(start); visited[start] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      comp.push(p);
      const px = p % w, py = Math.floor(p / w);
      const neigh = [[px - 1, py], [px + 1, py], [px, py - 1], [px, py + 1]];
      for (const [nx, ny] of neigh) {
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const np = ny * w + nx;
        if (paper[np] && !visited[np]) { visited[np] = 1; stack.push(np); }
      }
    }
    if (!bestComp || comp.length > bestComp.px.length) bestComp = { px: comp };
    if (stack.length > 0) stack.length = 0;
    // Performance: fruehstuecke abbrechen wenn Flaeche gross genug
    if (bestComp && bestComp.px.length > totalPaper * 0.8) break;
  }
  if (!bestComp || bestComp.px.length < totalPaper * 0.5) {
    return { corners: null, evidence: `kein dominierendes Papier-Areal (${bestComp ? (bestComp.px.length / totalPaper * 100).toFixed(0) : 0}% der Flaeche)` };
  }
  // Ecken-Signaturen
  const tl = { s: Infinity, p: -1 }, tr = { s: -Infinity, p: -1 }, br = { s: -Infinity, p: -1 }, bl = { s: Infinity, p: -1 };
  for (const p of bestComp.px) {
    const x = p % w, y = Math.floor(p / w);
    if (x + y < tl.s) { tl.s = x + y; tl.p = p; }
    if (x - y > tr.s) { tr.s = x - y; tr.p = p; }
    if (x + y > br.s) { br.s = x + y; br.p = p; }
    if (x - y < bl.s) { bl.s = x - y; bl.p = p; }
  }
  const toXY = (p: number): [number, number] => [p % w, Math.floor(p / w)];
  if (tl.p < 0 || tr.p < 0 || br.p < 0 || bl.p < 0) return { corners: null, evidence: 'Ecken nicht auffindbar' };
  const src4 = [toXY(tl.p), toXY(tr.p), toXY(br.p), toXY(bl.p)];
  const evidence = `Ecken gefunden: TL(${toXY(tl.p)}) TR(${toXY(tr.p)}) BR(${toXY(br.p)}) BL(${toXY(bl.p)}) Papier ${(bestComp.px.length / totalPaper * 100).toFixed(0)}%, Schwellwert ${paperThr.toFixed(0)}`;
  return { corners: src4, evidence };
}

// Homographie aus 4 Punkten (Dreieck-Interpolation via Doppelbilinear/baryzentrisch)?
// Wir nutzen direkte 4-Punkt-Homographie (DLT-ähnlich, geschlossene Form in 2D->2D via parallelogram or projective warp).
// Einfacher stabil: projektive Warp mit Bilinear-Approximation pro Scanline via Eckinterpolation.
export function rectifyPerspective(canvas: HTMLCanvasElement, corners: [number, number][], outW: number, outH: number): HTMLCanvasElement {
  const [tl, tr, br, bl] = corners;
  // Skalierungsfaktor: corners sind auf downscale-Ebene; auf Original umrechnen
  const small = downscale(canvas, 900);
  const sc = canvas.width / small.width;
  const CTL: [number, number] = [tl[0] * sc, tl[1] * sc];
  const CTR: [number, number] = [tr[0] * sc, tr[1] * sc];
  const CBR: [number, number] = [br[0] * sc, br[1] * sc];
  const CBL: [number, number] = [bl[0] * sc, bl[1] * sc];
  const out = document.createElement('canvas');
  out.width = outW; out.height = outH;
  const octx = out.getContext('2d')!;
  const sctx = canvas.getContext('2d')!;
  const src = sctx.getImageData(0, 0, canvas.width, canvas.height);
  const oimg = octx.createImageData(outW, outH);
  const od = oimg.data, sd = src.data;
  const sw = canvas.width;
  const lerp = (a: [number, number], b: [number, number], t: number): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  for (let y = 0; y < outH; y++) {
    const v = y / (outH - 1);
    const L = lerp(CTL, CBL, v);
    const R = lerp(CTR, CBR, v);
    for (let x = 0; x < outW; x++) {
      const u = x / (outW - 1);
      const [sx, sy] = lerp(L, R, u);
      // bilinear sample
      const x0 = Math.max(0, Math.floor(sx)), y0 = Math.max(0, Math.floor(sy));
      const x1 = Math.min(canvas.width - 1, x0 + 1), y1 = Math.min(canvas.height - 1, y0 + 1);
      const dx = Math.min(1, Math.max(0, sx - x0)), dy = Math.min(1, Math.max(0, sy - y0));
      for (let c = 0; c < 3; c++) {
        const c00 = sd[(y0 * sw + x0) * 4 + c], c10 = sd[(y0 * sw + x1) * 4 + c], c01 = sd[(y1 * sw + x0) * 4 + c], c11 = sd[(y1 * sw + x1) * 4 + c];
        od[(y * outW + x) * 4 + c] = c00 * (1 - dx) * (1 - dy) + c10 * dx * (1 - dy) + c01 * (1 - dx) * dy + c11 * dx * dy;
      }
      od[(y * outW + x) * 4 + 3] = 255;
    }
  }
  octx.putImageData(oimg, 0, 0);
  return out;
}

// --- Doppelseiten-Erkennung -------------------------------------------------
function columnProfile(canvas: HTMLCanvasElement): Float64Array {
  const bin = binarize(canvas);
  const w = canvas.width, h = canvas.height;
  const prof = new Float64Array(w);
  const stepY = 4;
  for (let x = 0; x < w; x++) {
    let b = 0;
    for (let y = 0; y < h; y += stepY) b += bin[y * w + x];
    prof[x] = b;
  }
  // glätten breit (relativ zur Breite)
  const win = Math.max(5, Math.floor(w * 0.012));
  const smooth = new Float64Array(w);
  for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let k = -win; k <= win; k++) {
      const xx = x + k;
      if (xx >= 0 && xx < w) { s += prof[xx]; n++; }
    }
    smooth[x] = s / n;
  }
  return smooth;
}

export function detectDoublePage(canvas: HTMLCanvasElement): { split: boolean, columnX: number | null, evidence: string } {
  const small = downscale(canvas, 1400);
  const prof = columnProfile(small);
  const { w, h, lum } = luminanceGrid(small);
  const lumProf = new Float64Array(w);
  const stepY = 4;
  for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let y = 0; y < h; y += stepY) { s += lum[y * w + x]; n++; }
    lumProf[x] = s / n;
  }
  const scale = canvas.width / small.width;
  const threshold = 1.7;
  const bandMinFraction = 0.012; // Band muss >= 1.2% der Seitenbreite sein

  const evaluate = (bandX0: number, bandX1: number, valley: number, kind: string): { ratio: number, side: number } => {
    const left = avg(prof, Math.floor(w * 0.15), bandX0 - Math.floor(w * 0.02));
    const right = avg(prof, bandX1 + Math.floor(w * 0.02), Math.floor(w * 0.85));
    const side = Math.min(left, right);
    if (side <= 0) return { ratio: 0, side: 0 };
    // auch beide Lum-Seiten vergleichen (Falz dunkel, Bandweiss/stehend)
    return { ratio: side / Math.max(0.001, valley), side };
  };

  // Tinte-Tal: breiteste Zusammenhangszone UNTER q%-Quantil im Zentrum
  const center = prof.slice(Math.floor(w * 0.42), Math.floor(w * 0.58));
  const sorted = [...center].sort((a, b) => a - b);
  const cutoff = sorted[Math.floor(sorted.length * 0.25)];
  // Bänder finden
  let bestInk = { x: -1, ratio: 0, bandW: 0 };
  let xs = -1;
  for (let x = Math.floor(w * 0.42); x < Math.floor(w * 0.58); x++) {
    if (prof[x] <= cutoff) { if (xs < 0) xs = x; }
    else if (xs >= 0) {
      const bw = x - xs;
      if (bw >= w * bandMinFraction) {
        const v = avg(prof, xs, x - 1);
        const { ratio } = evaluate(xs, x - 1, v, 'ink');
        if (ratio > bestInk.ratio) bestInk = { x: Math.round((xs + x - 1) / 2), ratio, bandW: bw };
      }
      xs = -1;
    }
  }
  if (xs >= 0) {
    const x = Math.floor(w * 0.58);
    const bw = x - xs;
    if (bw >= w * bandMinFraction) {
      const v = avg(prof, xs, x - 1);
      const { ratio } = evaluate(xs, x - 1, v, 'ink');
      if (ratio > bestInk.ratio) bestInk = { x: Math.round((xs + x - 1) / 2), ratio, bandW: bw };
    }
  }

  // Luminanz-Tal (Zweitspur): tiefster Mittelwert eines verschieblichen Fensters
  const win = Math.floor(w * 0.018);
  let bestLum = { x: -1, depth: 0 };
  for (let x = Math.floor(w * 0.42); x < Math.floor(w * 0.58); x++) {
    const v = avg(lumProf, x - win, x + win);
    const left = avg(lumProf, Math.floor(w * 0.15), x - win);
    const right = avg(lumProf, x + win, Math.floor(w * 0.85));
    const sideMin = Math.min(left, right);
    const depth = sideMin / Math.max(1, v);
    if (depth > bestLum.depth) bestLum = { x, depth };
  }

  const useInk = bestInk.ratio >= threshold;
  const useLum = !useInk && bestLum.depth >= 1.35;
  const splitX = useInk ? bestInk.x : (useLum ? bestLum.x : null);
  const evidence = `Tinte-Tal ${bestInk.ratio.toFixed(2)} (bw ${bestInk.bandW}px), Lum-Tal ${bestLum.depth.toFixed(2)} -> ${splitX !== null ? 'Split @' + splitX : 'kein Split'}`;
  return { split: splitX !== null, columnX: splitX !== null ? Math.round(splitX * scale) : null, evidence };
}

function avg(arr: Float64Array, from: number, to: number): number {
  let s = 0, n = 0;
  for (let i = Math.max(0, from); i <= Math.min(arr.length - 1, to); i++) { s += arr[i]; n++; }
  return n ? s / n : 0;
}

// --- Schatten-/Illuminations-Normalisierung ---------------------------------
// Hintergrundschätzung über hohe Perzentile in Tiles (Schatten sind dunkler als
// Papier, aber nie so dunkel wie Tinte). Weisz-Punkt wird überall einheitlich.
export function normalizeIllumination(canvas: HTMLCanvasElement, tileFrac = 0.045, whitePt = 245): HTMLCanvasElement {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const tileW = Math.max(24, Math.floor(w * tileFrac));
  const tileH = Math.max(24, Math.floor(h * tileFrac));
  const tilesX = Math.ceil(w / tileW), tilesY = Math.ceil(h / tileH);
  const bg = new Float64Array(tilesX * tilesY);
  const colCount = new Uint32Array(256);
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      colCount.fill(0);
      const x0 = tx * tileW, y0 = ty * tileH;
      const x1 = Math.min(w, x0 + tileW), y1 = Math.min(h, y0 + tileH);
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 4;
          colCount[Math.floor(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])]++;
        }
      }
      let acc = 0, target = 0;
      for (let i = y0; i < y1; i += 2) for (let j = x0; j < x1; j++) target++;
      let bgv = 250;
      for (let v = 255; v >= 0; v--) {
        acc += colCount[v];
        if (acc >= target * 0.08) { bgv = v; break; } // 92%-Perzentil
      }
      bg[ty * tilesX + tx] = Math.max(80, bgv); // nie durch Schatten ueber-hellen
    }
  }
  // bilinear gesampelte Hintergrundkarte
  const bgAt = (x: number, y: number): number => {
    const fx = Math.min(tilesX - 1.001, Math.max(0, (x / w) * tilesX - 0.5));
    const fy = Math.min(tilesY - 1.001, Math.max(0, (y / h) * tilesY - 0.5));
    const x0i = Math.floor(fx), y0i = Math.floor(fy);
    const dx = fx - x0i, dy = fy - y0i;
    const b00 = bg[y0i * tilesX + x0i];
    const b10 = bg[y0i * tilesX + Math.min(tilesX - 1, x0i + 1)];
    const b01 = bg[Math.min(tilesY - 1, y0i + 1) * tilesX + x0i];
    const b11 = bg[Math.min(tilesY - 1, y0i + 1) * tilesX + Math.min(tilesX - 1, x0i + 1)];
    return b00 * (1 - dx) * (1 - dy) + b10 * dx * (1 - dy) + b01 * (1 - dx) * dy + b11 * dx * dy;
  };
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = out.getContext('2d')!;
  const oimg = octx.createImageData(w, h);
  const od = oimg.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const bgv = bgAt(x, y);
      const gain = bgv > 1 ? whitePt / bgv : 1;
      for (let c = 0; c < 3; c++) {
        const val = d[i + c] * gain;
        od[i + c] = val > 255 ? 255 : val;
      }
      od[i + 3] = 255;
    }
  }
  octx.putImageData(oimg, 0, 0);
  return out;
}

// --- Hilfen ------------------------------------------------------------------
export function downscale(src: HTMLCanvasElement, maxDim: number): HTMLCanvasElement {
  const f = Math.min(1, maxDim / Math.max(src.width, src.height));
  if (f >= 1) {
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    c.getContext('2d')!.drawImage(src, 0, 0);
    return c;
  }
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * f); c.height = Math.round(src.height * f);
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

// --- Orchestrierte Normalisierung (Stufe 1) ---------------------------------
export async function restoreScanImage(srcCanvas: HTMLCanvasElement): Promise<RestoredPage[]> {
  const debug: ScanDebug = {
    orientationVotes: '', fineAngleDeg: 0, split: 'einseitig', splitColumnX: null, splitEvidence: '', stageImages: []
  };

  debug.stageImages.push({ label: 'Original', dataUrl: downscale(srcCanvas, 700).toDataURL('image/jpeg', 0.75) });

  // 1. Groborientierung (inkl. 90°!)
  const o = estimateOrientation90(srcCanvas);
  debug.orientationVotes = o.votes;
  let work = srcCanvas;
  if (o.rotate90) {
    const r = document.createElement('canvas');
    r.width = srcCanvas.height; r.height = srcCanvas.width;
    const rctx = r.getContext('2d')!;
    rctx.translate(r.width / 2, r.height / 2);
    rctx.rotate(Math.PI / 2);
    rctx.drawImage(srcCanvas, -srcCanvas.width / 2, -srcCanvas.height / 2);
    work = r;
  }

  // 2. Feinwinkel
  const fa = estimateFineAngle(work);
  debug.fineAngleDeg = fa.angleDeg;
  if (fa.angleDeg !== 0) work = rotateCanvas(work, fa.angleDeg);
  debug.stageImages.push({ label: `Ausgerichtet (${o.rotate90 ? '90°+' : ''}${fa.angleDeg.toFixed(2)}°)`, dataUrl: downscale(work, 700).toDataURL('image/jpeg', 0.75) });

  // 3. Perspektivische Rektifizierung (Papierkontur), wenn möglich
  const pc = detectPageCorners(work);
  if (pc.corners) {
    // Rahmen-Kopie erkennen: Alle Ecken nahe am Bildrand -> Homographie ~Identitaet (kein Gewinn, aber auch kein Risiko)
    const smallW = downscale(work, 900);
    const near = (p: [number, number]) => Math.min(p[0], p[1], smallW.width - p[0], smallW.height - p[1]) < smallW.width * 0.04;
    const allNear = pc.corners.every(near);
    if (allNear) debug.splitEvidence += '[Kontur=Rahmen, homographie identisch] ';
    // Ausgabeformat: Seitenverhaeltnis aus Ecken-Geometrie schätzen, sonst A4-Quer/Port je Lage
    const estW = Math.max( Math.hypot(pc.corners[1][0]-pc.corners[0][0], pc.corners[1][1]-pc.corners[0][1]), Math.hypot(pc.corners[2][0]-pc.corners[3][0], pc.corners[2][1]-pc.corners[3][1]) );
    const estH = Math.max( Math.hypot(pc.corners[3][0]-pc.corners[0][0], pc.corners[3][1]-pc.corners[0][1]), Math.hypot(pc.corners[2][0]-pc.corners[1][0], pc.corners[2][1]-pc.corners[1][1]) );
    const tgtW = Math.min(2400, Math.round(estW * 3.2));
    const tgtH = Math.min(3400, Math.round(estH * 3.2));
    work = rectifyPerspective(work, pc.corners, tgtW, tgtH);
    debug.stageImages.push({ label: 'Perspektive entzerrt (Kontur)', dataUrl: downscale(work, 700).toDataURL('image/jpeg', 0.75) });
  }
  debug.splitEvidence = (pc.corners ? 'Kontur OK. ' : 'Kontur nicht sicher (' + pc.evidence + '). ');

  // 4. Doppelseiten-Erkennung auf dem entzerrten Bild
  const dp = detectDoublePage(work);
  debug.splitEvidence += dp.evidence;
  const halves: HTMLCanvasElement[] = [];
  if (dp.split && dp.columnX !== null) {
    debug.split = 'doppelseitig';
    debug.splitColumnX = dp.columnX;
    for (const [x0, w] of [[0, dp.columnX], [dp.columnX, work.width - dp.columnX]] as const) {
      const h2 = document.createElement('canvas');
      h2.width = w; h2.height = work.height;
      h2.getContext('2d')!.drawImage(work, x0, 0, w, work.height, 0, 0, w, work.height);
      halves.push(h2);
    }
  } else {
    halves.push(work);
  }

  // 5. Illuminations-Normalisierung je Halbseite
  const results: RestoredPage[] = [];
  halves.forEach((hc, idx) => {
    const norm = normalizeIllumination(hc);
    if (idx === 0) debug.stageImages.push({ label: 'Schatten entfernt', dataUrl: downscale(norm, 700).toDataURL('image/jpeg', 0.75) });
    results.push({ canvas: norm, debug });
  });
  return results;
}
