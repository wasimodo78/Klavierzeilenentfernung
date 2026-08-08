export async function analyzePixels(
  canvas: HTMLCanvasElement,
  onProgress: (msg: string) => void,
  pageIndex: number = 1
): Promise<{ debugImage: string, stats: string, croppedStrips: { dataUrl: string, height: number }[] }> {
  onProgress("Starte Bildanalyse (Binarisierung)...");
  const ctx = canvas.getContext('2d')!;
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

  const croppedStrips: { dataUrl: string, height: number }[] = [];
  let keepRegionsStats = '';
  if (akkoladen.length > 0) {
    const globalAvgSpatium = staves.reduce((s, st) => s + st.spatium, 0) / staves.length;
    // Exactly 5 spatiums below the lowest non-piano line as requested
    const safeMargin = Math.floor(globalAvgSpatium * 5); 
    const topMargin = Math.floor(globalAvgSpatium * 8); // Margin at the top of subsequent akkoladen

    for (let i = 0; i < akkoladen.length; i++) {
      const akk = akkoladen[i];
      // Find curly brackets that vertically overlap with this akkolade
      const akkCurlyBrackets = brackets.filter(b => b.type === 'curly' && b.minY < akk.endY && b.maxY > akk.startY);
      
      const bracketTolerance = globalAvgSpatium * 4;
      
      let keepStaves = akk.staves;
      if (akkCurlyBrackets.length > 0) {
        // "Schneide doch einfach alle Systeme mit der geschweiften Klammer ab."
        // We filter out any staff that falls within the vertical bounds of a curly bracket.
        keepStaves = akk.staves.filter(staff => {
          const centerY = (staff.y1 + staff.y5) / 2;
          return !akkCurlyBrackets.some(b => centerY >= b.minY - bracketTolerance && centerY <= b.maxY + bracketTolerance);
        });
      }
      
      // If we filtered out ALL staves (meaning the system ONLY had curly brackets),
      // we skip this akkolade entirely as per the user's request: "Schneid es einfach immer weg."
      if (keepStaves.length === 0) {
          keepRegionsStats += `  Region ${i+1}: NUR PIANO (übersprungen)\n`;
          continue;
      } else {
          keepRegionsStats += `  Region ${i+1}: CHOR (${keepStaves.length} Systeme)\n`;
      }

      const highestKeepStaff = keepStaves[0];
      const lowestKeepStaff = keepStaves[keepStaves.length - 1];
      
      let keepStartY = Math.max(0, highestKeepStaff.y1 - topMargin);
      let keepEndY = Math.min(height, lowestKeepStaff.y5 + safeMargin);

      if (i === 0 && pageIndex === 1) {
        // Keep from top of page for the very first akkolade to preserve the title/header
        keepStartY = 0;
      }

      const h = keepEndY - keepStartY;
      if (h > 0) {
          const stripCanvas = document.createElement('canvas');
          stripCanvas.width = width;
          stripCanvas.height = h;
          const stripCtx = stripCanvas.getContext('2d')!;
          stripCtx.fillStyle = 'white';
          stripCtx.fillRect(0, 0, width, h);
          stripCtx.drawImage(canvas, 0, keepStartY, width, h, 0, 0, width, h);
          croppedStrips.push({ dataUrl: stripCanvas.toDataURL('image/jpeg', 0.9), height: h });
          keepRegionsStats += `  Region ${i+1}: Y ${Math.floor(keepStartY)} bis ${Math.floor(keepEndY)} (Staves kept: ${keepStaves.length})\n`;

          // Draw a thick red line at the cut point on the debug image for visual feedback
          for (let y = Math.floor(keepEndY) - 2; y <= Math.floor(keepEndY) + 2; y++) {
             for (let x = 0; x < width; x++) {
                if (y >= 0 && y < height) {
                   const idx = (y * width + x) * 4;
                   data[idx] = 255; data[idx+1] = 0; data[idx+2] = 0;
                }
             }
          }
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);

  const debugImage = canvas.toDataURL('image/jpeg', 0.8);
  
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

  stats += `\nSchnittbereiche (Keep Regions):\n`;
  stats += keepRegionsStats;

  return { debugImage, stats, croppedStrips };
}
