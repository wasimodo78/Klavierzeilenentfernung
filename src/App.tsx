import React, { useState, useCallback, useMemo } from 'react';
import { UploadCloud, Loader2, Download, Eye, ArrowLeft, Layout, List } from 'lucide-react';
import { generatePdf, ExtractedSystem, groupSystemsIntoPages, layoutSize, PAGE_LAYOUT } from './utils/pdfProcessor';

const CONTENT_WIDTH_MM = PAGE_LAYOUT.A4_WIDTH_MM - 2 * PAGE_LAYOUT.MARGIN_MM;
import { analyzePdfVectors } from './utils/vectorAnalyzer';
import { analyzePixels } from './utils/cvAnalyzer';
import * as pdfjsLib from 'pdfjs-dist';

export default function App() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressMsg, setProgressMsg] = useState('');
  const [progressPct, setProgressPct] = useState(0);
  const [isDragOver, setIsDragOver] = useState(false);
  
  const [previewImages, setPreviewImages] = useState<ExtractedSystem[] | null>(null);
  const [debugOutputs, setDebugOutputs] = useState<string[]>([]);
  const [cvDebugImages, setCvDebugImages] = useState<string[]>([]);
  const [cvCroppedImages, setCvCroppedImages] = useState<string[]>([]);
  const [mainDebug, setMainDebug] = useState<{ image: string, stats: string }[]>([]);
  const [download, setDownload] = useState<{ url: string, name: string } | null>(null);
  const [outputMode, setOutputMode] = useState<'sb600' | 'sb300' | 'foto300'>('sb600');
  
  const [currentFile, setCurrentFile] = useState<File | null>(null);
  const [viewMode, setViewMode] = useState<'systems' | 'pages'>('pages');

  const previewPages = useMemo(() => {
    if (!previewImages) return [];
    return groupSystemsIntoPages(previewImages);
  }, [previewImages]);

  const handleFile = async (file: File) => {
    if (file.type !== 'application/pdf') {
      alert('Bitte lade eine PDF-Datei hoch.');
      return;
    }

    setCurrentFile(file);
    setIsProcessing(true);
    setPreviewImages(null);
    setDebugOutputs([]);
    setCvDebugImages([]);
    setCvCroppedImages([]);
    setMainDebug([]);
    setDownload(null);
    setProgressMsg('Analysiere PDF...');
    setProgressPct(0);

    try {
      // Haupt-Workflow: CV-basierte Erkennung (Notenlinien, Akkoladen, Klammern)
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      const numPages = pdf.numPages;

      const allStrips: ExtractedSystem[] = [];
      const allDebug: { image: string, stats: string }[] = [];

      for (let i = 1; i <= numPages; i++) {
        setProgressMsg(`Analysiere Seite ${i} von ${numPages}...`);
        setProgressPct(10 + (i / numPages) * 85);

        const page = await pdf.getPage(i);

        // 300-dpi-Analyse-Render (2480px), identisch zum validierten CV-Inspektor
        const unscaledViewport = page.getViewport({ scale: 1.0 });
        const scale = 2480 / unscaledViewport.width;
        const viewport = page.getViewport({ scale });
        const mmPerPx = (unscaledViewport.width * 25.4 / 72) / viewport.width;
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d')!;

        await page.render({ canvasContext: ctx, viewport }).promise;

        // Zusätzlicher hochauflösender Render nur für die Ausgabe (600-dpi-Modus)
        let outCanvas: HTMLCanvasElement | null = null;
        if (outputMode === 'sb600') {
          setProgressMsg(`Seite ${i}: Rendere hochauflösend...`);
          const hiViewport = page.getViewport({ scale: scale * 2 });
          outCanvas = document.createElement('canvas');
          outCanvas.width = hiViewport.width;
          outCanvas.height = hiViewport.height;
          const hiCtx = outCanvas.getContext('2d')!;
          await page.render({ canvasContext: hiCtx, viewport: hiViewport }).promise;
        }

        const { croppedStrips, debugImage, stats } = await analyzePixels(canvas, (msg) => {
          setProgressMsg(`Seite ${i}: ${msg}`);
        }, i, { canvas: outCanvas ?? canvas, bilevel: outputMode !== 'foto300', mmPerPx });

        allStrips.push(...croppedStrips.map(s => ({ dataUrl: s.dataUrl, width: s.width, height: s.height, widthMm: s.widthMm, heightMm: s.heightMm })));
        allDebug.push({ image: debugImage, stats });
      }

      setProgressMsg('Fertig analysiert!');
      setProgressPct(100);
      setPreviewImages(allStrips);
      setMainDebug(allDebug);
    } catch (error) {
      console.error(error);
      alert('Es gab einen Fehler bei der Verarbeitung der Datei.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDownload = async () => {
    if (!previewImages || !currentFile) return;

    setIsProcessing(true);
    setProgressMsg('Erstelle PDF...');
    setProgressPct(0);

    try {
      const resultBlob = await generatePdf(previewImages, (msg, pct) => {
        setProgressMsg(msg);
        setProgressPct(pct);
      });

      const url = URL.createObjectURL(resultBlob);
      const name = currentFile.name.replace('.pdf', '_geschnitten.pdf');
      setDownload(prev => {
        if (prev) URL.revokeObjectURL(prev.url);
        return { url, name };
      });

      // Automatischen Download versuchen (wird in Sandbox-iframes ggf. blockiert –
      // der sichtbare Link unter der Vorschau ist der zuverlässige Weg)
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (error) {
      console.error(error);
      alert('Fehler beim PDF-Export.');
    } finally {
      setIsProcessing(false);
    }
  };

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFile(e.dataTransfer.files[0]);
    }
  }, []);

  const onFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFile(e.target.files[0]);
    }
  };

  const handleDebugVector = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      setCurrentFile(file);
      setIsProcessing(true);
      setPreviewImages(null);
      setDebugOutputs([]);
      setCvDebugImages([]);
      setCvCroppedImages([]);
    setMainDebug([]);
    setDownload(null);
      
      try {
        const output = await analyzePdfVectors(file, (msg) => {
          setProgressMsg(msg);
          setProgressPct(50); // Just a visual placeholder
        });
        setDebugOutputs([output]);
      } catch (error) {
        console.error(error);
        alert('Fehler bei der Vektoranalyse.');
      } finally {
        setIsProcessing(false);
      }
    }
  };

  const handleDebugCV = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      setCurrentFile(file);
      setIsProcessing(true);
      setPreviewImages(null);
      setDebugOutputs([]);
      setCvDebugImages([]);
      setCvCroppedImages([]);
    setMainDebug([]);
    setDownload(null);
      
      try {
        setProgressMsg('Lade PDF...');
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const numPages = pdf.numPages;
        
        const outDebugImages: string[] = [];
        const outStats: string[] = [];
        const allStrips: { dataUrl: string, height: number }[] = [];

        for (let i = 1; i <= numPages; i++) {
          setProgressMsg(`Rendere Seite ${i} von ${numPages}...`);
          const page = await pdf.getPage(i);
          
          const unscaledViewport = page.getViewport({ scale: 1.0 });
          const scale = 2480 / unscaledViewport.width;
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const ctx = canvas.getContext('2d')!;
          
          await page.render({ canvasContext: ctx, viewport }).promise;
          
          const { debugImage, stats, croppedStrips } = await analyzePixels(canvas, (msg) => {
            setProgressMsg(`Seite ${i}: ${msg}`);
          }, i);
          
          outDebugImages.push(debugImage);
          allStrips.push(...croppedStrips);
          outStats.push(stats);
        }

        setProgressMsg('Fasse Systeme auf Seiten zusammen...');
        
        // Pack strips to A4
        const a4Width = 2480;
        const a4Height = 3508;
        const pageMargin = 200; // top and bottom margin
        
        const packedPages: string[] = [];
        if (allStrips.length > 0) {
            let currentCanvas = document.createElement('canvas');
            currentCanvas.width = a4Width;
            currentCanvas.height = a4Height;
            let currentCtx = currentCanvas.getContext('2d')!;
            currentCtx.fillStyle = 'white';
            currentCtx.fillRect(0, 0, a4Width, a4Height);
            let currentY = pageMargin;

            for (const strip of allStrips) {
                const img = await new Promise<HTMLImageElement>((resolve) => {
                    const img = new Image();
                    img.onload = () => resolve(img);
                    img.src = strip.dataUrl;
                });

                if (currentY + strip.height > a4Height - pageMargin && currentY > pageMargin) {
                    packedPages.push(currentCanvas.toDataURL('image/jpeg', 0.85));
                    
                    currentCanvas = document.createElement('canvas');
                    currentCanvas.width = a4Width;
                    currentCanvas.height = a4Height;
                    currentCtx = currentCanvas.getContext('2d')!;
                    currentCtx.fillStyle = 'white';
                    currentCtx.fillRect(0, 0, a4Width, a4Height);
                    currentY = pageMargin;
                }

                currentCtx.drawImage(img, 0, currentY);
                currentY += strip.height;
            }

            if (currentY > pageMargin) {
                packedPages.push(currentCanvas.toDataURL('image/jpeg', 0.85));
            }
        }
        
        setCvDebugImages(outDebugImages);
        setCvCroppedImages(packedPages);
        setDebugOutputs(outStats);
      } catch (error) {
        console.error(error);
        alert('Fehler bei der Computer Vision Analyse.');
      } finally {
        setIsProcessing(false);
      }
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center py-10 px-4 font-sans text-slate-900">
      <div className="w-full max-w-4xl bg-white rounded-2xl shadow-xl overflow-hidden border border-slate-100">
        
        {/* Header */}
        <div className="bg-indigo-600 px-8 py-8 text-center relative">
          {(previewImages || debugOutputs.length > 0 || cvDebugImages.length > 0 || cvCroppedImages.length > 0) && !isProcessing && (
            <button 
              onClick={() => { setPreviewImages(null); setDebugOutputs([]); setCvDebugImages([]); setCvCroppedImages([]);
    setMainDebug([]);
    setDownload(null); setCurrentFile(null); }}
              className="absolute left-6 top-8 text-indigo-100 hover:text-white transition-colors flex items-center gap-1 text-sm font-medium"
            >
              <ArrowLeft className="w-4 h-4" /> Neue Datei
            </button>
          )}
          <h1 className="text-3xl font-bold text-white mb-2">Noten Extraktor <span className="text-xl font-normal text-indigo-200">v12</span></h1>
          <p className="text-indigo-100 text-sm max-w-lg mx-auto">
            Lade deine Partitur als PDF hoch. Die App schneidet automatisch die Klavierbegleitung weg. 
            Überprüfe das Ergebnis im Preview und lade das neue PDF herunter.
          </p>
        </div>

        {/* Main Content */}
        <div className="p-8">
          
          {!isProcessing && !previewImages && debugOutputs.length === 0 && cvDebugImages.length === 0 && cvCroppedImages.length === 0 && (
            <div className="space-y-6 max-w-2xl mx-auto">
              <div
                onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
                onDragLeave={() => setIsDragOver(false)}
                onDrop={onDrop}
                className={`relative border-2 border-dashed rounded-xl p-16 text-center transition-colors cursor-pointer w-full
                  ${isDragOver ? 'border-indigo-500 bg-indigo-50' : 'border-slate-300 hover:border-indigo-400 hover:bg-slate-50'}
                `}
              >
                <input
                  type="file"
                  accept="application/pdf"
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  onChange={onFileSelect}
                />
                <UploadCloud className="w-16 h-16 text-indigo-400 mx-auto mb-4" />
                <h3 className="text-xl font-semibold text-slate-700 mb-2">PDF zuschneiden</h3>
                <p className="text-slate-500">Klavierzeilen entfernen &amp; Chor neu anordnen — PDF hier ablegen oder klicken</p>
              </div>

              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 bg-slate-50 border border-slate-200 rounded-xl px-4 py-3">
                <label htmlFor="output-quality" className="text-sm font-medium text-slate-700">Ausgabequalität:</label>
                <select
                  id="output-quality"
                  value={outputMode}
                  onChange={(e) => setOutputMode(e.target.value as 'sb600' | 'sb300' | 'foto300')}
                  className="w-full sm:w-auto text-sm rounded-lg border-slate-300 px-3 py-2 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="sb600">Schwarz-Weiß 600 dpi (empfohlen: Druck &amp; Vektor-PDFs)</option>
                  <option value="sb300">Schwarz-Weiß 300 dpi (kleinere Datei)</option>
                  <option value="foto300">Foto/Farbe JPEG 300 dpi (für Graustufen-Scans)</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="relative border-2 border-dashed rounded-xl p-8 text-center transition-colors cursor-pointer w-full border-amber-300 hover:border-amber-500 hover:bg-amber-50">
                  <input
                    type="file"
                    accept="application/pdf"
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    onChange={handleDebugVector}
                  />
                  <h3 className="text-lg font-semibold text-amber-700 mb-1">Inspektor: PDF Vektoren</h3>
                  <p className="text-amber-600/80 text-sm">Rohe PDF-Zeichenbefehle lesen.</p>
                </div>
                
                <div className="relative border-2 border-dashed rounded-xl p-8 text-center transition-colors cursor-pointer w-full border-emerald-300 hover:border-emerald-500 hover:bg-emerald-50">
                  <input
                    type="file"
                    accept="application/pdf"
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    onChange={handleDebugCV}
                  />
                  <h3 className="text-lg font-semibold text-emerald-700 mb-1">Inspektor: Computer Vision</h3>
                  <p className="text-emerald-600/80 text-sm">Pixel in Linien umwandeln (Neuer Algorithmus).</p>
                </div>
              </div>
            </div>
          )}

          {isProcessing && (
            <div className="py-16 px-6 text-center max-w-2xl mx-auto">
              <Loader2 className="w-12 h-12 text-indigo-600 animate-spin mx-auto mb-6" />
              <h3 className="text-xl font-medium text-slate-800 mb-4">{progressMsg}</h3>
              
              <div className="w-full bg-slate-100 rounded-full h-3 mb-2 overflow-hidden shadow-inner">
                <div 
                  className="bg-indigo-600 h-3 rounded-full transition-all duration-300 ease-out" 
                  style={{ width: `${Math.max(5, progressPct)}%` }}
                ></div>
              </div>
              <p className="text-slate-500 text-sm font-medium">{Math.round(progressPct)}% abgeschlossen</p>
            </div>
          )}

          {cvCroppedImages.length > 0 && !isProcessing && (
            <div className="animate-in fade-in zoom-in-95 duration-300 mb-16">
              <h3 className="text-2xl font-bold text-slate-800 mb-6">Ergebnis: Komprimierte Ausgabe ({cvCroppedImages.length} Seiten)</h3>
              <div className="space-y-8">
                {cvCroppedImages.map((img, idx) => (
                  <div key={idx} className="bg-white border border-slate-200 rounded-xl overflow-hidden p-4 text-center shadow-sm">
                    <div className="flex justify-between items-center mb-4 px-4">
                       <p className="text-sm text-indigo-600 font-medium">Seite {idx + 1} (A4 300dpi)</p>
                       <a href={img} download={`zugeschnitten_seite_${idx + 1}.jpg`} className="inline-flex items-center gap-2 px-4 py-1.5 bg-indigo-100 text-indigo-700 rounded-lg text-sm font-medium hover:bg-indigo-200 transition-colors">
                          <Download className="w-4 h-4" /> Bild Downloaden
                       </a>
                    </div>
                    <img src={img} alt={`Packed Page ${idx + 1}`} className="max-h-[80vh] mx-auto object-contain border border-slate-100 shadow-sm rounded" />
                  </div>
                ))}
              </div>
            </div>
          )}

          {debugOutputs.length > 0 && !isProcessing && (
            <div className="animate-in fade-in zoom-in-95 duration-300">
              <h3 className="text-xl font-semibold text-slate-800 mb-4">Original Seiten (CV Debug)</h3>
              
              <div className="space-y-12">
                {debugOutputs.map((output, idx) => (
                  <div key={idx} className="border-b-2 border-indigo-100 pb-12">
                    <h4 className="text-lg font-medium text-slate-700 mb-4 bg-indigo-50 inline-block px-4 py-1 rounded-full">Seite {idx + 1}</h4>
                    
                    {cvDebugImages[idx] && (
                      <div className="mb-6 bg-slate-900 rounded-xl overflow-hidden p-2 text-center">
                        <p className="text-sm text-emerald-400 mb-2 font-mono">Computer Vision Debug: Rot = Erkannte Notenlinien</p>
                        <img src={cvDebugImages[idx]} alt={`CV Debug Page ${idx + 1}`} className="max-h-[50vh] mx-auto object-contain bg-white" />
                      </div>
                    )}
                    
                    <div className="bg-slate-900 rounded-xl p-4 overflow-hidden">
                      <textarea 
                        className="w-full h-48 bg-transparent text-emerald-400 font-mono text-xs focus:outline-none resize-none"
                        readOnly
                        value={output}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {previewImages && !isProcessing && (
            <div className="animate-in fade-in zoom-in-95 duration-300">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-6 pb-4 border-b border-slate-100 gap-4">
                <div className="flex items-center gap-2 text-slate-800">
                  <Eye className="w-5 h-5 text-indigo-600" />
                  <h3 className="text-xl font-semibold">Vorschau ({previewImages.length} Systeme, {previewPages.length} Seiten)</h3>
                </div>
                
                <div className="flex items-center gap-4">
                  <div className="flex bg-slate-100 p-1 rounded-lg">
                    <button
                      onClick={() => setViewMode('pages')}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${viewMode === 'pages' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
                    >
                      <Layout className="w-4 h-4" />
                      Seiten
                    </button>
                    <button
                      onClick={() => setViewMode('systems')}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${viewMode === 'systems' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
                    >
                      <List className="w-4 h-4" />
                      Systeme
                    </button>
                  </div>

                  <button
                    onClick={handleDownload}
                    className="inline-flex items-center gap-2 px-6 py-2 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 transition-colors shadow-sm"
                  >
                    <Download className="w-4 h-4" />
                    PDF Exportieren
                  </button>
                </div>
              </div>

              {download && (
                <div className="mb-6 bg-emerald-50 border border-emerald-200 rounded-xl p-4 flex flex-col sm:flex-row items-center justify-between gap-3">
                  <p className="text-emerald-800 text-sm font-medium">
                    Das PDF wurde erstellt. Falls der Download nicht automatisch gestartet ist:
                  </p>
                  <div className="flex items-center gap-2">
                    <a
                      href={download.url}
                      download={download.name}
                      className="inline-flex items-center gap-2 px-6 py-2.5 bg-emerald-600 text-white rounded-lg font-medium hover:bg-emerald-700 transition-colors shadow-sm whitespace-nowrap"
                    >
                      <Download className="w-4 h-4" />
                      {download.name} speichern
                    </a>
                    <a
                      href={download.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-2 px-4 py-2.5 bg-white text-emerald-700 border border-emerald-300 rounded-lg font-medium hover:bg-emerald-100 transition-colors whitespace-nowrap"
                    >
                      Im neuen Tab öffnen
                    </a>
                  </div>
                </div>
              )}

              <div className="bg-slate-100 p-6 rounded-xl border border-slate-200 overflow-y-auto max-h-[70vh] shadow-inner">
                {previewImages.length === 0 ? (
                  <div className="text-center py-10 text-slate-500">
                    Keine Notensysteme gefunden. Möglicherweise ist die PDF leer oder zu schwach gedruckt.
                  </div>
                ) : viewMode === 'systems' ? (
                  <div className="space-y-6">
                    {previewImages.map((img, idx) => (
                      <div key={idx} className="bg-white p-4 shadow-sm rounded-lg border border-slate-200 relative group">
                        <div className="absolute top-2 left-2 bg-slate-800/70 text-white text-xs font-mono px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity">
                          System {idx + 1}
                        </div>
                        <img 
                          src={img.dataUrl} 
                          alt={`System ${idx + 1}`} 
                          className="h-auto object-contain"
                          style={{ width: `${(layoutSize(img).wMm / CONTENT_WIDTH_MM) * 100}%` }}
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="space-y-8 flex flex-col items-center">
                    {previewPages.map((page, pageIdx) => (
                      <div key={pageIdx} className="bg-white shadow-md border border-slate-200 relative" style={{ width: '100%', maxWidth: '800px', aspectRatio: '210/297', padding: '4.76%' }}>
                        <div className="absolute -top-3 left-4 bg-indigo-100 text-indigo-800 text-xs font-semibold px-2 py-1 rounded-full shadow-sm">
                          Seite {pageIdx + 1}
                        </div>
                        <div className="w-full h-full flex flex-col gap-[3.8%]">
                           {page.map((item, sysIdx) => (
                             <img 
                               key={sysIdx}
                               src={item.img.dataUrl}
                               alt={`Seite ${pageIdx + 1} - System ${sysIdx + 1}`}
                               className="object-contain object-top"
                               style={{ width: `${(item.wMm / CONTENT_WIDTH_MM) * 100}%` }}
                             />
                           ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Diagnose pro Seite: Erkennungsdetails des Haupt-Workflows (für Feedbackschlaufen) */}
              {mainDebug.length > 0 && (
                <div className="mt-8">
                  <h4 className="text-lg font-semibold text-slate-800 mb-3">Diagnose: Was die Erkennung gesehen hat</h4>
                  <div className="space-y-3">
                    {mainDebug.map((d, idx) => (
                      <details key={idx} className="bg-white border border-slate-200 rounded-lg overflow-hidden group">
                        <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 select-none">
                          Seite {idx + 1} — Akkoladen, Klammern &amp; Schnittbereiche
                        </summary>
                        <div className="p-4 border-t border-slate-100 grid gap-4 md:grid-cols-2">
                          <img src={d.image} alt={`Diagnose Seite ${idx + 1}`} className="w-full h-auto object-contain border border-slate-100 rounded" />
                          <textarea
                            className="w-full h-64 bg-slate-900 text-emerald-400 font-mono text-xs rounded-lg p-3 focus:outline-none resize-none"
                            readOnly
                            value={d.stats}
                          />
                        </div>
                      </details>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
