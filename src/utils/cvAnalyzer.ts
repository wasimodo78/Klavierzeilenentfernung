export async function analyzePixels(
  canvas: HTMLCanvasElement,
  onProgress: (msg: string) => void,
  pageIndex: number = 1,
  output?: { canvas: HTMLCanvasElement; bilevel: boolean; mmPerPx?: number }
): Promise<{ debugImage: string, stats: string, croppedStrips: { dataUrl: string, height: number, width: number, widthMm: number, heightMm: number, newPiece: boolean }[] }> {
  onProgress("Starte Bildanalyse (Binarisierung)...");
  const ctx = canvas.getContext('2d')!;
  // Ausgabe erfolgt optional aus einem separaten hochauflösenden Render
  const outCanvas = output?.canvas ?? canvas;
  const outScale = outCanvas.width / canvas.width;
  const outBilevel = output?.bilevel ?? false;
  // echter Millimeter-Maßstab pro Analyse-Pixel (für Originalgröße im Layout)
  const mmPerPx = output?.mmPerPx ?? (210 / canvas.width);
  const width = canvas.width;
  const height = canvas.height;
  const imgData = ctx.getImageData(0, 0, width, height);
  const data = imgData.data;

  // 1. Binarize image (Black/White) & compute row sums
  // We consider a pixel "black" if its luminosity is below a threshold
  const threshold = 200;
  
  // We will build a matrix of black pixels to do line detection
  // To save memory, we can use a Uint8Array where 1 = black, 0 = white
  const binaryMap = new Uint8Array(width * height);
  
  let blackPixelCount = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    
    // Simple luminosity
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (lum < threshold) {
      const pixelIdx = i / 4;
      binaryMap[pixelIdx] = 1;
      blackPixelCount++;
      
      // Paint the debug image pure black for detected pixels
      data[i] = 0;
      data[i+1] = 0;
      data[i+2] = 0;
    } else {
      // Paint pure white
      data[i] = 255;
      data[i+1] = 255;
      data[i+2] = 255;
    }
  }

  // Seitenrahmen des Verlags erkennen: Spalten, die fast durchgehend schwarz sind,
  // werden beim späteren X-Zuschnitt nicht als Inhalt gewertet.
  const frameCols = new Uint8Array(width);
  for (let fx = 0; fx < width; fx++) {
    let colBlack = 0;
    for (let fy = 0; fy < height; fy++) colBlack += binaryMap[fy * width + fx];
    if (colBlack > height * 0.97) frameCols[fx] = 1;
  }

  onProgress("Suche nach Notenlinien (Run-Length)...");
  // 2. Horizontal Line Detection via Run-Length
  // Dies ignoriert Text (wie Instrumentennamen), da diese keine langen durchgehenden Linien bilden.
  
  const rawHorizontalLines: { y: number, startX: number, endX: number }[] = [];
  const MIN_LINE_LENGTH = Math.floor(width * 0.15); // Mindestens 15% der Seitenbreite durchgehend schwarz
  
  for (let y = 0; y < height; y++) {
    let currentRun = 0;
    for (let x = 0; x < width; x++) {
      if (binaryMap[y * width + x] === 1) {
        currentRun++;
      } else {
        if (currentRun > MIN_LINE_LENGTH) {
          rawHorizontalLines.push({ y, startX: x - currentRun, endX: x });
        }
        currentRun = 0;
      }
    }
    if (currentRun > MIN_LINE_LENGTH) {
      rawHorizontalLines.push({ y, startX: width - currentRun, endX: width });
    }
  }

  // Draw detected horizontal lines in Red
  for (const line of rawHorizontalLines) {
    for (let x = line.startX; x < line.endX; x++) {
      const i = (line.y * width + x) * 4;
      data[i] = 255;     // R
      data[i+1] = 0;     // G
      data[i+2] = 0;     // B
    }
  }

  // Merge thick lines (adjacent y coordinates, or broken segments on same line)
  const mergedLines: { y: number, startX: number, endX: number, thickness: number }[] = [];
  for (const line of rawHorizontalLines) {
    let merged = false;
    for (let i = mergedLines.length - 1; i >= 0; i--) {
      const ml = mergedLines[i];
      if (line.y - ml.y > 5) break; // Too far vertically
      
      // Check horizontal overlap
      if (Math.max(line.startX, ml.startX) < Math.min(line.endX, ml.endX)) {
        ml.y = (ml.y * ml.thickness + line.y) / (ml.thickness + 1);
        ml.thickness++;
        ml.startX = Math.min(ml.startX, line.startX);
        ml.endX = Math.max(ml.endX, line.endX);
        merged = true;
        break;
      }
    }
    if (!merged) {
      mergedLines.push({ ...line, thickness: 1 });
    }
  }

  // 3. Cluster lines into 5-line Staves
  const staves: { y1: number, y2: number, y3: number, y4: number, y5: number, minX: number, maxX: number, spatium: number }[] = [];
  for (let i = 0; i <= mergedLines.length - 5; i++) {
    const l1 = mergedLines[i];
    const l2 = mergedLines[i+1];
    const l3 = mergedLines[i+2];
    const l4 = mergedLines[i+3];
    const l5 = mergedLines[i+4];
    
    const d1 = l2.y - l1.y;
    const d2 = l3.y - l2.y;
    const d3 = l4.y - l3.y;
    const d4 = l5.y - l4.y;
    
    const avgDist = (d1 + d2 + d3 + d4) / 4;
    const maxDev = Math.max(Math.abs(d1-avgDist), Math.abs(d2-avgDist), Math.abs(d3-avgDist), Math.abs(d4-avgDist));
    
    // Toleranz: Spatium muss > 3px sein, Abweichung < 30%
    if (avgDist > 3 && maxDev < avgDist * 0.3) {
      const startXs = [l1.startX, l2.startX, l3.startX, l4.startX, l5.startX].sort((a, b) => a - b);
      const endXs = [l1.endX, l2.endX, l3.endX, l4.endX, l5.endX].sort((a, b) => a - b);
      
      // Robust minX and maxX using median to avoid artifacts
      const minX = startXs[2];
      const maxX = endXs[2];
      
      staves.push({ 
        y1: l1.y, y2: l2.y, y3: l3.y, y4: l4.y, y5: l5.y, 
        minX, maxX, spatium: avgDist 
      });
      i += 4; // Skip the lines we just consumed
    }
  }

  // 4. Akkoladen finden durch Gruppieren der Systeme, die vertikal nah beieinander liegen und (ungefähr) die gleichen x-Ränder haben.
  const akkoladen: { staves: typeof staves, startY: number, endY: number, minX: number, maxX: number }[] = [];
  
  if (staves.length > 0) {
    const avgSpatium = staves.reduce((sum, s) => sum + s.spatium, 0) / staves.length;
    let currentAkkolade = {
      staves: [staves[0]],
      startY: staves[0].y1,
      endY: staves[0].y5,
      minX: staves[0].minX,
      maxX: staves[0].maxX
    };
    
    for (let i = 1; i < staves.length; i++) {
      const staff = staves[i];
      const gap = staff.y1 - currentAkkolade.endY;
      const xDiffLeft = Math.abs(staff.minX - currentAkkolade.minX);
      
      let connected = false;
      if (gap > 0 && gap < avgSpatium * 40 && xDiffLeft < 30) {
          let yStart = Math.floor(currentAkkolade.endY);
          let yEnd = Math.floor(staff.y1);
          let connectedPixels = 0;
          let totalPixels = yEnd - yStart;
          
          let searchMinX = Math.floor(Math.min(currentAkkolade.minX, staff.minX)) - Math.floor(avgSpatium * 12);
          let searchMaxX = Math.floor(Math.max(currentAkkolade.minX, staff.minX)) + Math.floor(avgSpatium * 4);
          searchMinX = Math.max(0, searchMinX);
          searchMaxX = Math.min(width - 1, searchMaxX);

          for (let y = yStart; y < yEnd; y++) {
             let foundBlack = false;
             for (let x = searchMinX; x <= searchMaxX; x++) {
                 if (binaryMap[y * width + x] === 1) {
                     foundBlack = true;
                     break;
                 }
             }
             if (foundBlack) connectedPixels++;
          }
          
          if (totalPixels > 0 && connectedPixels / totalPixels > 0.7) {
              connected = true;
          }
      }

      // Group if there's a visual vertical connection OR if the gap is reasonably small (e.g., standard piano staff gap)
      if (connected || (gap < avgSpatium * 25 && xDiffLeft < 25)) {
        currentAkkolade.staves.push(staff);
        // Wir aktualisieren minX und maxX als Durchschnitt der Ränder
        currentAkkolade.minX = (currentAkkolade.minX * (currentAkkolade.staves.length - 1) + staff.minX) / currentAkkolade.staves.length;
        currentAkkolade.maxX = (currentAkkolade.maxX * (currentAkkolade.staves.length - 1) + staff.maxX) / currentAkkolade.staves.length;
        currentAkkolade.endY = staff.y5; // nach unten erweitern
      } else {
        akkoladen.push(currentAkkolade);
        currentAkkolade = {
          staves: [staff],
          startY: staff.y1,
          endY: staff.y5,
          minX: staff.minX,
          maxX: staff.maxX
        };
      }
    }
    akkoladen.push(currentAkkolade);
  }

  // 5. Den hellblauen Akkoladenstrich links und rechts zeichnen
  // Einfach vom ersten System zum letzten System durchziehen.
  for (const akk of akkoladen) {
    const lineX = Math.floor(akk.minX);
    const rightX = Math.floor(akk.maxX);
    
    for (let y = Math.floor(akk.startY); y <= Math.floor(akk.endY); y++) {
      // Linker Strich (dünne Linie)
      if (lineX >= 0 && lineX < width && y >= 0 && y < height) {
        const idx = (y * width + lineX) * 4;
        data[idx] = 0;       // R
        data[idx+1] = 200;   // G
        data[idx+2] = 255;   // B
      }
      
      // Rechter Strich (dünne Linie)
      if (rightX >= 0 && rightX < width && y >= 0 && y < height) {
        const idx = (y * width + rightX) * 4;
        data[idx] = 0;       // R
        data[idx+1] = 200;   // G
        data[idx+2] = 255;   // B
      }
    }
  }

  // 6. Klammern (Brackets) finden
  // Wir suchen links vom Akkoladenstrich nach schwarzen zusammenhängenden Bereichen (Connected Components),
  // die sich über mehrere Systeme erstrecken.
  const brackets: { minX: number, maxX: number, minY: number, maxY: number, type: 'straight' | 'curly' }[] = [];
  
  if (akkoladen.length > 0) {
    const avgSpatium = staves.reduce((sum, s) => sum + s.spatium, 0) / staves.length;
    
    for (const akk of akkoladen) {
      // Suchbereich links vom Akkoladenstrich (akk.minX)
      const searchStartX = Math.max(0, Math.floor(akk.minX - avgSpatium * 20));
      const searchEndX = Math.max(0, Math.floor(akk.minX - 2));
      const searchStartY = Math.floor(akk.startY - avgSpatium);
      const searchEndY = Math.floor(akk.endY + avgSpatium);
      
      const visited = new Uint8Array(width * height);
      
      for (let y = searchStartY; y <= searchEndY; y++) {
        if (y < 0 || y >= height) continue;
        for (let x = searchStartX; x <= searchEndX; x++) {
          if (binaryMap[y * width + x] === 1 && visited[y * width + x] === 0) {
            // Start a flood fill
            let compMinX = x, compMaxX = x, compMinY = y, compMaxY = y;
            const queue = [[x, y]];
            visited[y * width + x] = 1;
            
            let head = 0;
            while (head < queue.length) {
              const [qx, qy] = queue[head++];
              
              if (qx < compMinX) compMinX = qx;
              if (qx > compMaxX) compMaxX = qx;
              if (qy < compMinY) compMinY = qy;
              if (qy > compMaxY) compMaxY = qy;
              
              // Check 8 neighbors
              for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                  if (dx === 0 && dy === 0) continue;
                  const nx = qx + dx;
                  const ny = qy + dy;
                  
                  // Restrict to search box
                  if (nx >= searchStartX && nx <= searchEndX && ny >= searchStartY - 10 && ny <= searchEndY + 10) {
                     if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                       if (binaryMap[ny * width + nx] === 1 && visited[ny * width + nx] === 0) {
                         visited[ny * width + nx] = 1;
                         queue.push([nx, ny]);
                       }
                     }
                  }
                }
              }
            }
            
            // Check if this component is tall enough to be a bracket (e.g., taller than 2 * avgSpatium to catch broken pieces)
            if (compMaxY - compMinY > avgSpatium * 2) {
              const w = compMaxX - compMinX + 1;
              const h = compMaxY - compMinY + 1;
              const area = w * h;
              
              // Anzahl der schwarzen Pixel in dieser Komponente
              const blackPixels = queue.length;
              const fillRatio = blackPixels / area;
              
              // Eine gerade Klammer ist ein sehr schmales Rechteck und fast komplett gefüllt (hoher fillRatio).
              // Eine geschweifte Klammer ist deutlich breiter und hat viel Weissraum in ihrer Bounding Box (niedriger fillRatio ~ 0.6).
              const isCurly = w > avgSpatium * 0.8 && fillRatio < 0.80;
              
              brackets.push({
                minX: compMinX,
                maxX: compMaxX,
                minY: compMinY,
                maxY: compMaxY,
                type: isCurly ? 'curly' : 'straight'
              });
            }
          }
        }
      }
    }
  }

  // Merge curly brackets that are vertically close (broken pieces of the same bracket)
  const avgSpatiumGlobal = staves.length > 0 ? staves.reduce((sum, s) => sum + s.spatium, 0) / staves.length : 10;
  let mergedBrackets: typeof brackets = [];
  brackets.sort((a, b) => a.minY - b.minY);
  for (const br of brackets) {
    // Find a recently added bracket that might be a piece of this one
    // Only merge if they are vertically stacked (broken pieces), NOT if they are side-by-side (overlapping vertically)
    const matching = mergedBrackets.find(m => {
      const hDist = Math.abs(m.minX - br.minX);
      const vDist = Math.max(0, br.minY - m.maxY, m.minY - br.maxY);
      const overlap = Math.max(0, Math.min(br.maxY, m.maxY) - Math.max(br.minY, m.minY));
      
      if (overlap > avgSpatiumGlobal * 2) return false; // Too much vertical overlap = they are side-by-side, do not merge
      return hDist < avgSpatiumGlobal * 3 && vDist < avgSpatiumGlobal * 2;
    });
                                              
    if (matching) {
      // Merge this bracket
      matching.minY = Math.min(matching.minY, br.minY);
      matching.maxY = Math.max(matching.maxY, br.maxY);
      matching.minX = Math.min(matching.minX, br.minX);
      matching.maxX = Math.max(matching.maxX, br.maxX);
      // If either piece was classified as curly, the whole thing is curly
      if (br.type === 'curly') {
        matching.type = 'curly';
      }
    } else {
      mergedBrackets.push({...br});
    }
  }
  brackets.splice(0, brackets.length, ...mergedBrackets);

  // Zeichne Klammern
  for (const br of brackets) {
    // Farbe je nach Typ: Gerade = Grün, Geschweift = Orange
    const r = br.type === 'curly' ? 255 : 0;
    const g = br.type === 'curly' ? 165 : 255;
    const b = 0;
    
    for (let y = br.minY; y <= br.maxY; y++) {
      for (let x = br.minX; x <= br.maxX; x++) {
        if (binaryMap[y * width + x] === 1) {
          const idx = (y * width + x) * 4;
          data[idx] = r;       
          data[idx+1] = g;   
          data[idx+2] = b;     
        }
      }
    }
    
    // Bounding Box (Pink für Gerade, Gelb für Geschweifte)
    const boxR = br.type === 'curly' ? 255 : 255;
    const boxG = br.type === 'curly' ? 255 : 0;
    const boxB = br.type === 'curly' ? 0 : 255;
    
    for (let y = br.minY; y <= br.maxY; y++) {
      for (let x of [br.minX - 1, br.maxX + 1]) {
        if (x >= 0 && x < width && y >= 0 && y < height) {
           const idx = (y * width + x) * 4;
           data[idx] = boxR; data[idx+1] = boxG; data[idx+2] = boxB;
        }
      }
    }
    for (let x = br.minX; x <= br.maxX; x++) {
      for (let y of [br.minY - 1, br.maxY + 1]) {
        if (x >= 0 && x < width && y >= 0 && y < height) {
           const idx = (y * width + x) * 4;
           data[idx] = boxR; data[idx+1] = boxG; data[idx+2] = boxB;
        }
      }
    }
  }

  // --- 7. Segmentbasiertes Schneiden ---
  // Statt Akkoladen nur an den Außenkanten zu beschneiden, bilden wir aus den
  // Nicht-Klavier-Systemen zusammenhängende Keep-Segmente. Klavier-Läufe
  // (geschweifte Klammer) fallen so auch mitten auf der Seite als Lücke heraus –
  // unabhängig davon, wie die Akkolade-Gruppierung ausgefallen ist.
  const croppedStrips: { dataUrl: string, height: number, width: number, widthMm: number, heightMm: number, newPiece: boolean }[] = [];
  let keepRegionsStats = '';

  if (staves.length > 0) {
    const globalAvgSpatium = staves.reduce((s, st) => s + st.spatium, 0) / staves.length;
    const safeMargin = Math.floor(globalAvgSpatium * 5);
    const topMargin = Math.floor(globalAvgSpatium * 8);
    const bracketTolerance = globalAvgSpatium * 4;
    const curlyBrackets = brackets.filter(b => b.type === 'curly');

    // a) Systeme klassifizieren: Klavier = Systemmitte liegt in einer geschweiften Klammer
    const isPiano = staves.map(staff => {
      const centerY = (staff.y1 + staff.y5) / 2;
      return curlyBrackets.some(b => centerY >= b.minY - bracketTolerance && centerY <= b.maxY + bracketTolerance);
    });

    // b) Leere Zeilen-Bänder zwischen zwei Y-Werten finden (Weißraum-Analyse).
    // Akkolade-Linie/Klammer-Ränder erzeugen nur wenige schwarze Pixel pro Zeile
    // und fallen unter den Schwellwert, Text und Noten liegen deutlich darüber.
    const EMPTY_ROW_MAX_BLACK = Math.max(6, Math.floor(width * 0.003));
    type EmptyBand = { start: number; end: number; size: number };
    const findEmptyBands = (yFrom: number, yTo: number): EmptyBand[] => {
      const bands: EmptyBand[] = [];
      const from = Math.max(0, Math.floor(yFrom));
      const to = Math.min(height - 1, Math.floor(yTo));
      let runStart = -1;
      for (let y = from; y <= to; y++) {
        let black = 0;
        const rowOff = y * width;
        for (let x = 0; x < width; x++) black += binaryMap[rowOff + x];
        if (black <= EMPTY_ROW_MAX_BLACK) {
          if (runStart === -1) runStart = y;
        } else if (runStart !== -1) {
          bands.push({ start: runStart, end: y - 1, size: y - runStart });
          runStart = -1;
        }
      }
      if (runStart !== -1) bands.push({ start: runStart, end: to, size: to + 1 - runStart });
      return bands;
    };

    // c2) Inhalts-Cluster zwischen zwei Y-Werten (Invertierung der Lücken-Analyse,
    // z. B. Titel-/Textblöcke zwischen den Systemen)
    type ContentCluster = { start: number; end: number; size: number; maxLine: number };
    const findContentClusters = (yFrom: number, yTo: number): ContentCluster[] => {
      const clusters: ContentCluster[] = [];
      const from = Math.max(0, Math.floor(yFrom));
      const to = Math.min(height - 1, Math.floor(yTo));
      let runStart = -1;
      for (let y = from; y <= to; y++) {
        let black = 0;
        const rowOff = y * width;
        for (let x = 0; x < width; x++) black += binaryMap[rowOff + x];
        if (black > EMPTY_ROW_MAX_BLACK) {
          if (runStart === -1) runStart = y;
        } else if (runStart !== -1) {
          clusters.push({ start: runStart, end: y - 1, size: y - runStart, maxLine: y - runStart });
          runStart = -1;
        }
      }
      if (runStart !== -1) clusters.push({ start: runStart, end: to, size: to + 1 - runStart, maxLine: to + 1 - runStart });
      return clusters;
    };

    // c1b) Absatz-Cluster: Textzeilen, die enger als 2.5 Spatia beieinanderliegen,
    // zu Inhaltsblöcken verschmelzen (ein mehrzeiliger Titel ist EIN Block).
    const MERGE_GAP_SP = 2.5;
    // Fettdruck-Display-Titel: mindestens eine Zeile ~2 Spatia hoch, Block >= 2.5.
    // Kleine Untertitel/Liedtitel (~1-1.3 Spatia Zeilen) loesen nicht aus.
    // Geometriebasierte Titel-/Copyright-Erkennung (schriftgrößenunabhängig)
    const DISPLAY_LINE_SP = 1.8;          // Fettdruck-Versalzeile ~2 Spatia
    const DISPLAY_BLOCK_SP = 2.5;         // Block mit solcher Zeile
    const ZONE_TEXT_MIN_SP = 8;           // Summe der Texthöhen für eine Titelzone
    const ZONE_COVERAGE = 0.25;           // mind. 25% der Zone mit Text bedeckt
    const BOTTOM_GATE = 0.7;              // untere 30% der Seite: kein neuer Titel
    const COPYRIGHT_MIN_W_FRAC = 0.35;    // breite, flache Zeile = Copyright
    const ZONE_MIN_W_FRAC = 0.22;         // Titelzone: mind. eine Zeile so breit (% Seitenbreite)
    const findMergedClusters = (yFrom: number, yTo: number): ContentCluster[] => {
      const maxGap = globalAvgSpatium * MERGE_GAP_SP;
      const fine = findContentClusters(yFrom, yTo);
      const merged: ContentCluster[] = [];
      for (const cl of fine) {
        const last = merged[merged.length - 1];
        if (last && cl.start - last.end <= maxGap) {
          last.end = cl.end;
          last.size = last.end - last.start;
          if (cl.maxLine > last.maxLine) last.maxLine = cl.maxLine;
        } else {
          merged.push({ ...cl });
        }
      }
      return merged;
    };

    // Hilfsregeln für Titel-/Copyright-Erkennung (Geometrie, kein OCR)
    const clusterWidth = (cl: ContentCluster): number => {
      let cx0 = width, cx1 = -1;
      for (let y = Math.max(0, cl.start); y <= Math.min(height - 1, cl.end); y++) {
        const rowOff = y * width;
        for (let x = 0; x < width; x++) {
          if (binaryMap[rowOff + x] === 1 && !frameCols[x]) {
            if (x < cx0) cx0 = x;
            if (x > cx1) cx1 = x;
          }
        }
      }
      return cx1 >= cx0 ? (cx1 - cx0 + 1) : 0;
    };

    const isDisplayTitle = (cl: ContentCluster) =>
      cl.size >= globalAvgSpatium * DISPLAY_BLOCK_SP && cl.maxLine >= globalAvgSpatium * DISPLAY_LINE_SP &&
      clusterWidth(cl) >= globalAvgSpatium * 8; // breit! Uebungszeichen-Kaestchen sind schmal (~3-5 Spatia)

    // Eine echte Titelzone hat irgendeine breite Zeile (Titel/Untertitel/Absatz);
    // Kästchen+Dynamik-Paeckchen im Graben sind nur 2-5% breit.
    const hasWideLine = (clusters: ContentCluster[]) =>
      clusters.some(cl => clusterWidth(cl) >= width * ZONE_MIN_W_FRAC);

    const isWideShallowLine = (cl: ContentCluster, maxHsp: number, staffSpanX: number) =>
      cl.start >= height * BOTTOM_GATE &&
      cl.size < globalAvgSpatium * maxHsp &&
      clusterWidth(cl) > staffSpanX * COPYRIGHT_MIN_W_FRAC;

    // c) Zusammenhängende Läufe von behaltenen Systemen bilden (Klavier trennt)
    type Run = { staves: typeof staves; startIdx: number; endIdx: number };
    const runs: Run[] = [];
    let currentRun: Run | null = null;
    staves.forEach((staff, idx) => {
      if (!isPiano[idx]) {
        if (!currentRun) {
          currentRun = { staves: [staff], startIdx: idx, endIdx: idx };
          runs.push(currentRun);
        } else {
          currentRun.staves.push(staff);
          currentRun.endIdx = idx;
        }
      } else {
        currentRun = null;
      }
    });

    // d) Segmentgrenzen bestimmen
    type Segment = { top: number; bottom: number; staffCount: number; startIdx: number; endIdx: number;
                     firstY1: number; lastY5: number; firstMinX: number; lastMinX: number; minX: number; maxX: number; newPiece: boolean; pseudo?: boolean };
    const segments: Segment[] = [];

    for (const run of runs) {
      const firstStaff = run.staves[0];
      const lastStaff = run.staves[run.staves.length - 1];
      // Läufe werden nur von Klavier-Systemen getrennt, daher gilt:
      const prevStaff = run.startIdx > 0 ? staves[run.startIdx - 1] : null; // immer Klavier
      const nextStaff = run.endIdx < staves.length - 1 ? staves[run.endIdx + 1] : null; // immer Klavier

      // Oberkante: knapp unterhalb der ersten echten Weißraum-Band unter dem
      // vorherigen Klavier-System. So bleiben Übungszeichen/Tempoangaben, die
      // frei über dem Vokal-System schweben, im Segment erhalten.
      let segTop: number;
      let newPiece = false;
      if (!prevStaff) {
        // Seitenanfang: auf Seite 1 Kopfzeile/Titel mitnehmen, sonst Standardrand.
        // Ab Seite 2: steht da ein mehrzeiliger Titel (neues Stück im Heft), mitnehmen.
        if (pageIndex === 1) {
          segTop = 0;
        } else {
          // Kopfbereich: reine Textzone ohne Notenlinien. Ab ~20 Spatia Höhe
          // (Titelvorspann) ODER Fettdruck-Block dabei -> neuer Stückbeginn.
          // Nie in den unteren 30% (dort steht Copyright, kein Titel).
          const scanFrom = Math.max(0, Math.floor(firstStaff.y1 - globalAvgSpatium * 50));
          const headClusters = findMergedClusters(scanFrom, firstStaff.y1 - 1);
          const headStart = headClusters.length > 0 ? headClusters[0].start : 0;
          const headSpan = headClusters.length > 0 ? headClusters[headClusters.length - 1].end - headStart + 1 : 0;
          const sumH = headClusters.reduce((s, cl) => s + cl.size, 0);
          const coverage = headSpan > 0 ? sumH / headSpan : 0;
          // Dicht gepackte Textzone (viel Text auf engem Raum) = Titelvorspann;
          // vereinzelte Kopf-/Tempozeilen mit grossen Abständen dagegen nicht
          const isPieceHead = headClusters.length > 0 && headStart < height * BOTTOM_GATE &&
            ((sumH >= globalAvgSpatium * ZONE_TEXT_MIN_SP && coverage >= ZONE_COVERAGE && hasWideLine(headClusters)) || headClusters.some(isDisplayTitle));
          if (isPieceHead) {
            newPiece = true;
            segTop = Math.max(0, Math.floor(headStart - globalAvgSpatium));
          } else {
            segTop = Math.max(0, Math.floor(firstStaff.y1 - topMargin));
          }
        }
      } else {
        // Titelerkennung im Graben: hohe reine Textzone (~15+ Spatia) ODER
        // Fettdruck-Block = neuer Titel. Nie in den unteren 30% der Seite.
        const gapClusters = findMergedClusters(prevStaff.y5 + 1, firstStaff.y1 - 1);
        const gapStart = gapClusters.length > 0 ? gapClusters[0].start : 0;
        const gapSpan = gapClusters.length > 0 ? gapClusters[gapClusters.length - 1].end - gapStart + 1 : 0;
        const gatedByPosition = gapClusters.length > 0 && gapStart < height * BOTTOM_GATE;
        const sumH = gapClusters.reduce((s, cl) => s + cl.size, 0);
        const coverage = gapSpan > 0 ? sumH / gapSpan : 0;
        const zoneTitle = gatedByPosition && gapClusters.length > 0 && sumH >= globalAvgSpatium * ZONE_TEXT_MIN_SP && coverage >= ZONE_COVERAGE && hasWideLine(gapClusters);
        const displayCluster = gatedByPosition ? gapClusters.find(isDisplayTitle) : undefined;
        const titleStart = zoneTitle ? gapStart : (displayCluster ? displayCluster.start : null);

        if (pageIndex > 1 && titleStart !== null) {
          newPiece = true;
          segTop = Math.max(Math.floor(prevStaff.y5 + globalAvgSpatium), Math.floor(titleStart - globalAvgSpatium));
        } else {
        // Schnitt in die LETZTE große Lücke vor dem Vokal-System (die Luft direkt
        // darüber): Alles, was am Klavier klebt – tiefe Basstöne mit Hilfslinien,
        // Pedalmarken, Klammer – liegt oberhalb dieser Lücke und fällt weg; alles,
        // was am Vokal-System klebt (Liedtext, Dynamik, Übungszeichen), liegt
        // unterhalb ihres unteren Endes und bleibt erhalten.
        const topBands = findEmptyBands(prevStaff.y5 + 1, firstStaff.y1 - 1).filter(b => b.size >= globalAvgSpatium * 1.5);
        const lastBand = topBands[topBands.length - 1];
        if (lastBand) {
          const desired = Math.floor(firstStaff.y1 - globalAvgSpatium * 2);
          // Wunschposition 2 Spatia über dem System, falls sie in der Lücke liegt;
          // sonst knapp unterhalb der Lücke (direkt über dem vokalen Inhalt).
          segTop = (desired >= lastBand.start && desired <= lastBand.end) ? desired : lastBand.end + 1;
          segTop = Math.min(segTop, Math.floor(firstStaff.y1 - 1));
          segTop = Math.max(segTop, Math.floor(prevStaff.y5 + globalAvgSpatium));
        } else {
          segTop = Math.max(Math.floor(prevStaff.y5 + globalAvgSpatium), Math.floor(firstStaff.y1 - globalAvgSpatium * 4.5));
        }

        }
      }

      // Unterkante: Mitte der größten Weißraum-Lücke zum nächsten Klavier-System,
      // damit Liedtext unter dem letzten Vokal-System erhalten bleibt.
      let segBottom: number;
      if (!nextStaff) {
        segBottom = Math.min(height, Math.ceil(lastStaff.y5 + safeMargin));
      } else {
        const bottomBands = findEmptyBands(lastStaff.y5 + 1, nextStaff.y1 - 1);
        const bestBand = bottomBands.filter(b => b.size >= globalAvgSpatium * 2).sort((a, b) => b.size - a.size)[0];
        if (bestBand) {
          segBottom = bestBand.start + Math.floor(bestBand.size / 2);
          segBottom = Math.min(segBottom, Math.floor(nextStaff.y1 - globalAvgSpatium));
          segBottom = Math.max(segBottom, Math.ceil(lastStaff.y5 + globalAvgSpatium * 2));
        } else {
          segBottom = Math.min(Math.floor(nextStaff.y1 - globalAvgSpatium), Math.ceil(lastStaff.y5 + safeMargin));
        }

      }

      const top = Math.max(0, Math.floor(segTop));
      const bottom = Math.min(height, Math.ceil(segBottom));
      if (bottom > top) {
        segments.push({
          top, bottom, staffCount: run.staves.length, startIdx: run.startIdx, endIdx: run.endIdx,
          firstY1: firstStaff.y1, lastY5: lastStaff.y5, firstMinX: firstStaff.minX, lastMinX: lastStaff.minX,
          minX: Math.min(...run.staves.map(s => s.minX)), maxX: Math.max(...run.staves.map(s => s.maxX)),
          newPiece
        });
      }
    }

    // c3) Frontmatter/Titel am Seitenanfang: steht über einem reinen Klavier-Intro
    // ein grosser Titelblock (ab Seite 2 -> neues Stück im Heft), wird er als
    // eigener Streifen davor ausgegeben. Titel bleibt, Klavier-Intro bleibt weg.
    if (pageIndex > 1 && staves.length > 0 && isPiano[0] && segments.length > 0) {
      const headClusters = findMergedClusters(0, staves[0].y1 - 1);
      const headStart = headClusters.length > 0 ? headClusters[0].start : 0;
      const headSpan = headClusters.length > 0 ? headClusters[headClusters.length - 1].end - headStart + 1 : 0;
      const sumH = headClusters.reduce((s, cl) => s + cl.size, 0);
      const coverage = headSpan > 0 ? sumH / headSpan : 0;
      const isPieceHead = headClusters.length > 0 && headStart < height * BOTTOM_GATE &&
        ((sumH >= globalAvgSpatium * ZONE_TEXT_MIN_SP && coverage >= ZONE_COVERAGE && hasWideLine(headClusters)) || headClusters.some(isDisplayTitle));
      if (isPieceHead) {
        const fTop = Math.max(0, Math.floor(headStart - globalAvgSpatium));
        const fBottom = Math.min(height, Math.floor(staves[0].y1 - globalAvgSpatium));
        if (fBottom > fTop) {
          segments.unshift({
            top: fTop, bottom: fBottom, staffCount: 0, startIdx: -1, endIdx: -1,
            firstY1: staves[0].y1, lastY5: staves[0].y5, firstMinX: staves[0].minX, lastMinX: staves[0].minX,
            minX: staves[0].minX, maxX: staves[0].maxX, newPiece: true, pseudo: true
          });
          // Seitenumbruch nur einmal pro Quellseite: der Chortitel darunter
          // erzwingt dann keinen zweiten Umbruch
          for (const s of segments) if (!s.pseudo) s.newPiece = false;
        }
      }
    }

    // e) Streifen erzeugen (mit X-Zuschnitt auf den tatsächlichen Inhalt) +
    //    Schnittlinien im Debug-Bild (rot, oben und unten)
    for (const seg of segments) {
      const h = seg.bottom - seg.top;

      // Inhaltsgrenzen links/rechts bestimmen (Klammern, Stimmnamen, Taktnummern).
      // Seitenrahmen des Verlags (fast durchgehend schwarze Spalten) zählen nicht.
      let contentLeft = -1;
      let contentRight = -1;
      const leftScanEnd = Math.max(0, Math.floor(seg.minX));
      const rightScanStart = Math.min(width, Math.ceil(seg.maxX));
      for (let y = seg.top; y < seg.bottom; y++) {
        const rowOff = y * width;
        for (let x = 0; x < leftScanEnd; x++) {
          if (binaryMap[rowOff + x] === 1 && !frameCols[x]) {
            if (contentLeft === -1 || x < contentLeft) contentLeft = x;
          }
        }
        for (let x = rightScanStart; x < width; x++) {
          if (binaryMap[rowOff + x] === 1 && !frameCols[x]) {
            if (x > contentRight) contentRight = x;
          }
        }
      }

      const padX = globalAvgSpatium;
      let cropX0: number, cropX1: number;
      if (seg.pseudo) {
        // Titel-/Textstreifen: frei auf den Inhalt zuschneiden (keine Systeme)
        cropX0 = contentLeft >= 0 ? Math.max(0, Math.floor(contentLeft - padX)) : 0;
        cropX1 = contentRight >= 0 ? Math.min(width, Math.ceil(contentRight + padX)) : width;
      } else {
        cropX0 = contentLeft >= 0 ? contentLeft - padX : seg.minX - 3 * globalAvgSpatium;
        cropX1 = contentRight >= 0 ? contentRight + padX : seg.maxX + 2 * globalAvgSpatium;
        // Sanity: nie in die Systeme hinein schneiden, Ausreißer abfangen
        cropX0 = Math.min(Math.max(0, Math.floor(cropX0)), Math.floor(seg.minX - globalAvgSpatium * 0.5));
        cropX1 = Math.max(Math.min(width, Math.ceil(cropX1)), Math.ceil(seg.maxX + globalAvgSpatium * 0.5));
        if (seg.minX - cropX0 > globalAvgSpatium * 30) cropX0 = Math.floor(seg.minX - 3 * globalAvgSpatium);
        if (cropX1 - seg.maxX > globalAvgSpatium * 30) cropX1 = Math.ceil(seg.maxX + 2 * globalAvgSpatium);
      }

      // Streifen in Ausgabe-Auflösung zeichnen (Koordinaten -> Ausgabe-Raum)
      const outX0 = Math.floor(cropX0 * outScale);
      const outX1 = Math.ceil(cropX1 * outScale);
      const outW = outX1 - outX0;
      const outTop = Math.floor(seg.top * outScale);
      const outH = Math.max(1, Math.ceil(seg.bottom * outScale) - outTop);

      const stripCanvas = document.createElement('canvas');
      stripCanvas.width = outW;
      stripCanvas.height = outH;
      const stripCtx = stripCanvas.getContext('2d')!;
      stripCtx.fillStyle = 'white';
      stripCtx.fillRect(0, 0, outW, outH);
      stripCtx.drawImage(outCanvas, outX0, outTop, outW, outH, 0, 0, outW, outH);

      // Überhängende Reste des Akkoladen-Verbunds weiss übermalen
      const dangleMin = globalAvgSpatium * 1.5;
      const bottomZoneStart = Math.floor(seg.lastY5 * outScale) - outTop + Math.ceil(3 * outScale);
      const topZoneEnd = Math.floor(seg.firstY1 * outScale) - outTop - Math.ceil(2 * outScale);
      stripCtx.fillStyle = 'white';

      if (!seg.pseudo && bottomZoneStart < outH) {
        const bandsX = [{ x0: seg.lastMinX - 4, x1: seg.lastMinX + 3 }];
        for (const br of brackets) {
          if (br.type === 'straight' && br.maxY > seg.lastY5 + dangleMin) {
            bandsX.push({ x0: br.minX - 1, x1: br.maxX + 1 });
          }
        }
        for (const b of bandsX) {
          const bx0 = Math.max(outX0, Math.floor(b.x0 * outScale)) - outX0;
          const bx1 = Math.min(outX1, Math.ceil(b.x1 * outScale)) - outX0;
          stripCtx.fillRect(bx0, bottomZoneStart, Math.max(0, bx1 - bx0), outH - bottomZoneStart);
        }
      }
      if (!seg.pseudo && topZoneEnd > 0 && !(pageIndex === 1 && seg.top === 0)) {
        const bandsX = [{ x0: seg.firstMinX - 4, x1: seg.firstMinX + 3 }];
        for (const br of brackets) {
          if (br.type === 'straight' && br.minY < seg.firstY1 - dangleMin) {
            bandsX.push({ x0: br.minX - 1, x1: br.maxX + 1 });
          }
        }
        for (const b of bandsX) {
          const bx0 = Math.max(outX0, Math.floor(b.x0 * outScale)) - outX0;
          const bx1 = Math.min(outX1, Math.ceil(b.x1 * outScale)) - outX0;
          stripCtx.fillRect(bx0, 0, Math.max(0, bx1 - bx0), topZoneEnd);
        }
      }

      // Optional: 1-Bit Schwarz-Weiss (gestochen scharfe Kanten, kleine PNG-Datei,
      // Grauschleier aus Scans wird zu reinem Weiss)
      if (outBilevel) {
        const img = stripCtx.getImageData(0, 0, outW, outH);
        const px = img.data;
        for (let p = 0; p < px.length; p += 4) {
          const lum = 0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2];
          const v = lum < 200 ? 0 : 255;
          px[p] = v; px[p + 1] = v; px[p + 2] = v; px[p + 3] = 255;
        }
        stripCtx.putImageData(img, 0, 0);
      }

      croppedStrips.push({
        dataUrl: outBilevel ? stripCanvas.toDataURL('image/png') : stripCanvas.toDataURL('image/jpeg', 0.92),
        height: outH,
        width: outW,
        // Naturmaße in Millimetern (unabhängig von der Ausgabe-Auflösung)
        widthMm: (outW / outScale) * mmPerPx,
        heightMm: (outH / outScale) * mmPerPx,
        newPiece: seg.newPiece
      });

      // Rote Schnittlinien an Ober-/Unterkante im Debug-Bild
      for (const lineY of [seg.top, seg.bottom]) {
        for (let y = lineY - 2; y <= lineY + 2; y++) {
          if (y < 0 || y >= height) continue;
          for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            data[i] = 255; data[i + 1] = 0; data[i + 2] = 0;
          }
        }
      }
    }

    // f) Stats: Titel-Streifen und Segmente/Klavier-Läufe protokollieren
    const realSegs = segments.filter(s => !s.pseudo);
    segments.filter(s => s.pseudo).forEach((seg, k) => {
      keepRegionsStats += `  -> TITEL-Streifen ${k + 1}: neue Seite, Y ${seg.top} bis ${seg.bottom}  [NEUES STUECK -> Seitenumbruch]\n`;
    });
    segNumLoop: {
      let pianoRunStart = -1;
      let segIdx = 0;
      for (let i = 0; i <= staves.length; i++) {
        const pianoHere = i < staves.length && isPiano[i];
        if (pianoHere && pianoRunStart === -1) {
          pianoRunStart = i;
        } else if (!pianoHere && pianoRunStart !== -1) {
          keepRegionsStats += `  -> KLAVIER entfernt: ${i - pianoRunStart} System(e), Y ${Math.floor(staves[pianoRunStart].y1)} bis ${Math.floor(staves[i - 1].y5)}\n`;
          pianoRunStart = -1;
        }
        if (segIdx < realSegs.length && realSegs[segIdx].startIdx === i) {
          const seg = realSegs[segIdx];
          keepRegionsStats += `  Segment ${segIdx + 1}: CHOR (${seg.staffCount} Systeme), Y ${seg.top} bis ${seg.bottom}${seg.newPiece ? '  [NEUES STUECK -> Seitenumbruch]' : ''}\n`;
          segIdx++;
        }
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);

  // Debug-Bild zur Speicherschonung auf max. 1240px Breite verkleinern
  // (bei vielen Seiten summieren sich die Daten-URLs sonst massiv)
  const dbgScale = Math.min(1, 1240 / width);
  let debugImage: string;
  if (dbgScale < 1) {
    const dbgCanvas = document.createElement('canvas');
    dbgCanvas.width = Math.floor(width * dbgScale);
    dbgCanvas.height = Math.floor(height * dbgScale);
    const dbgCtx = dbgCanvas.getContext('2d')!;
    dbgCtx.drawImage(canvas, 0, 0, dbgCanvas.width, dbgCanvas.height);
    debugImage = dbgCanvas.toDataURL('image/jpeg', 0.8);
    dbgCanvas.width = 0; dbgCanvas.height = 0;
  } else {
    debugImage = canvas.toDataURL('image/jpeg', 0.8);
  }
  
  let stats = `Bildgröße: ${width}x${height}
Schwarze Pixel: ${blackPixelCount}
Gefundene horizontale Linien-Fragmente (Raw): ${rawHorizontalLines.length}
Zusammengefasste Linien: ${mergedLines.length}
Gefundene 5-Linien-Systeme: ${staves.length}
Spatium (Durchschnitt): ${staves.length > 0 ? (staves.reduce((s, st) => s + st.spatium, 0) / staves.length).toFixed(2) : 0} px`;

  stats += `\nGefundene Akkoladen: ${akkoladen.length}\n`;
  akkoladen.forEach((akk, i) => {
    stats += `  Akkolade ${i+1}: ${akk.staves.length} Systeme, X: ${Math.floor(akk.minX)} bis ${Math.floor(akk.maxX)}, Y: ${Math.floor(akk.startY)} bis ${Math.floor(akk.endY)}\n`;
  });

  stats += `\nGefundene Klammern: ${brackets.length}\n`;
  brackets.forEach((br, i) => {
    stats += `  Klammer ${i+1}: ${br.type} (X: ${Math.floor(br.minX)} bis ${Math.floor(br.maxX)}, Y: ${Math.floor(br.minY)} bis ${Math.floor(br.maxY)})\n`;
  });

  stats += `\nKeep-Segmente (Schnittbereiche):\n`;
  stats += keepRegionsStats;

  return { debugImage, stats, croppedStrips };
}
