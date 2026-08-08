# Suno AI – Stilvorgaben & Best Practices (Stand 2026, v5 / v5.5)

Zusammenfassung der recherchierten Best Practices: wie man Prompts formuliert, damit das
Ergebnis möglichst nah an der eigenen Vorstellung liegt.

> **Grundsatz vorweg:** Tags sind *probabilistische Hinweise*, keine Befehle. Suno befolgt sie
> meistens, kann sie aber ignorieren. "Erzwingen" gibt es nicht – man kann das Modell nur stark
> in eine Richtung drücken und dann iterativ nachschärfen.

---

## 1. Das mentale Modell: vier getrennte Kanäle

Der häufigste Fehler ist, alles in ein Feld zu kippen. Suno hat vier Kanäle mit klarer
Arbeitsteilung:

| Kanal | Zuständig für | Nicht hineinschreiben |
|---|---|---|
| **Style / Style of Music** | Klangwelt: Genre, Tempo, Stimmung, Instrumentierung, Vocal-Charakter, Produktion | Songtext, Strukturangaben, Negativwünsche |
| **Lyrics** | Wörter + Struktur-Tags + kurze lokale Performance-Hinweise | Genrebeschreibungen, Produktionswünsche |
| **Exclude Styles** | Alles, was *nicht* vorkommen soll | – |
| **Slider** (Weirdness, Style Influence, Audio Influence) | Wie *stark* die Vorgaben wirken | – |

Negativwünsche gehören in **Exclude Styles**, nicht in den Style-Prompt. Steht "kein Autotune"
im Style-Feld, liest das Modell vor allem das Wort "Autotune".

---

## 2. Das Style-Feld: die Formel

Kommagetrennte Deskriptoren, **keine ausformulierten Sätze**. Das Modell erwartet einen kurzen
Production Brief, keinen Fließtext und keine Adjektivhalde.

```
Genre/Subgenre, BPM, Stimmung, 3–5 konkrete Instrumente,
Vocal-Beschreibung, Produktions-/Ära-Ästhetik
```

**Beispiel:**

```
Indie folk, 92 BPM, melancholic, fingerstyle acoustic guitar, upright bass, brushed drums,
whispered female vocals, warm analog tape production, 2010s indie aesthetic
```

### Harte Regeln

1. **Reihenfolge = Gewichtung.** Die ersten ~20–30 Wörter wiegen am schwersten. Genre zuerst,
   Stimmung zweitens, Detailkram nach hinten.
2. **4–7 Kern-Deskriptoren, maximal 8–15 Tags.** Ab ~9 Elementen beginnt sich alles gegenseitig
   zu verwässern; über 20 Tags wird das Ergebnis wieder generisch. Weniger als 5 ist zu vage.
3. **Keine Widersprüche stapeln.** "Aggressive, dreamy, minimal, orchestral" ist kein Stil,
   sondern Rauschen. Contradiction Stacking ist eine der Hauptursachen für Fehlgriffe.
4. **Keine Künstlernamen.** Werden gefiltert oder produzieren generische Kopien – und sind
   kommerziell heikel. Stattdessen den *Klang* beschreiben:
   - ✗ `sounds like Drake`
   - ✓ `atmospheric trap, moody R&B, melodic male vocals, conversational delivery, 808 bass, reverb-heavy pads, 78 BPM`
5. **Vokale immer explizit benennen.** Fehlende Vocal-Direktive ist ein Standardfehler. Angeben:
   Geschlecht/Register, Timbre, Delivery – z. B. `raspy male baritone, close-mic'd, conversational,
   slight vibrato`. Kein Gesang gewünscht? `instrumental` explizit setzen.
6. **Konkret statt abstrakt.** "Punchy kick" sagt dem Parser nichts. Besser sind Begriffe mit
   echter klanglicher Bedeutung: `sidechained 808 kick`, `gated reverb snare`, `palm-muted
   telecaster`, `Rhodes through tape delay`.
7. **Style-Prompt auf Englisch** – auch bei deutschen Songs. Das Modell ist auf englische
   Musikterminologie trainiert.

### Zeichenlimits (Community-Messungen, nicht offiziell dokumentiert)

- Style-Feld: **~1.000 Zeichen** auf v5/v5.5, **~200 Zeichen** auf v4 und älter
- Lyrics: bis **~5.000 Zeichen** ab v4.5+
- Suno kürzt **still und ohne Warnung** – alles über dem Limit fällt weg.

Die Werte ändern sich mit App-Versionen; im Zweifel in der App gegenprüfen.

---

## 3. Das Lyrics-Feld: Struktur- und Meta-Tags

Meta-Tags stehen in eckigen Klammern, **allein auf einer Zeile**, direkt **vor** dem Abschnitt,
den sie betreffen. Sie werden nicht gesungen.

### Verlässliche Struktur-Tags

`[Intro]` · `[Verse]` / `[Verse 1]` · `[Pre-Chorus]` · `[Chorus]` · `[Post-Chorus]` ·
`[Bridge]` · `[Instrumental Break]` · `[Guitar Solo]` · `[Drop]` · `[Outro]` · `[End]`

- `[Chorus]` bei jeder Wiederholung erneut setzen – so bleibt der Hook konsistent.
- `[End]` / `[Outro]` verhindert das typische Ausfaden ins Nichts.

### Performance-Tags (lokal, sparsam)

`[Whispered]` · `[Belted]` · `[Scream]` · `[Chant]` · `[Spoken Word]` · `[Ad-libs]` ·
`[Half-time]` · `[Build]` · `[Breakdown]` · `[Harmonies]`

**Nicht jede Zeile taggen** – das verwirrt das Modell zuverlässig. Ein Tag pro Abschnitt, plus
maximal ein bis zwei gezielte Ausreißer.

### Beispielaufbau

```
[Intro]
[Verse 1]
…Text…

[Pre-Chorus]
…Text…

[Chorus]
…Text…

[Verse 2]
…Text…

[Chorus]

[Bridge]
[Whispered]
…Text…

[Chorus]
[Ad-libs]

[Outro]
[End]
```

---

## 4. Negativsteuerung

**Exclude Styles** ist der eigentliche Hebel gegen unerwünschte Elemente. Typische Einträge:

```
autotune, heavy reverb, falsetto, EDM drop, brass, screaming vocals, lo-fi hiss
```

Auch im Style-Feld funktionieren Negationen teilweise (`no autotune`, `no heavy reverb`), aber
weniger zuverlässig als das dedizierte Feld.

---

## 5. Die Slider

| Slider | Wirkung | Empfehlung für "so wie ich es mir vorstelle" |
|---|---|---|
| **Weirdness** (Safe ↔ Chaos) | Wie experimentell/unvorhersehbar. 50 % = Normalfall. Über 80 % oft nicht mehr musikalisch verwertbar. | **20–40 %** |
| **Style Influence** (Loose ↔ Strong) | Wie streng der Style-Prompt befolgt wird. Niedrig = generisch. | **75–95 %** |
| **Audio Influence** (nur bei Upload) | Wie stark die Referenzaufnahme durchschlägt. Hoch = nah am Original, niedrig = freiere Neuinterpretation. | je nach Ziel |

Kombinationen: hohe Weirdness + hohe Style Influence = ungewöhnlich, aber im Genre. Hohe
Weirdness + niedrige Style Influence = Chaos ohne Leitplanken.

Wichtig: Was die Slider regeln, gehört **nicht** zusätzlich in den Prompt. Doppelt gemoppelt
verwässert nur.

---

## 6. Deutsche Songs

- Style-Prompt englisch, **Lyrics deutsch**.
- Explizit `German vocals` bzw. `sung in German` (für Rap: `German rap, rapping in German`) in
  den Style-Prompt, sonst driftet die Aussprache ins Englische.
- **Aussprache-Fixes:** Wörter phonetisch schreiben, wenn Suno sie verschluckt –
  `Glück` → `Glueck`, oder Bindestriche zur Silbentrennung setzen.
- **Komma direkt nach einem wichtigen Wort** erzwingt eine natürlichere Atempause.
- Englische Wörter im deutschen Text lassen die Aussprache oft komplett umschalten – bewusst
  einsetzen oder vermeiden.
- Deutsche Zeilen sind silbenreicher als englische. Zu lange Zeilen führen zu Genuschel; kürzen
  hilft mehr als jeder Tag.

---

## 7. Iterationsmethode (der wichtigste Punkt)

Der Unterschied zwischen frustrierend und kontrollierbar liegt weniger im ersten Prompt als im
Vorgehen danach:

1. **Immer nur eine Variable ändern.** Nicht den ganzen Prompt neu schreiben.
2. **Erst diagnostizieren, welches Feld schuld ist:**

| Symptom | Zuständiges Feld |
|---|---|
| Falsches Genre / falscher Sound | Style |
| Struktur stimmt nicht (kein Refrain, falsche Reihenfolge) | Lyrics (Struktur-Tags) |
| Falsche Aussprache / Betonung | Lyrics (Text umschreiben, Phonetik) |
| Zu wild / zu abgedreht | Weirdness runter |
| Prompt wird ignoriert, klingt generisch | Style Influence hoch, Tag-Zahl runter |
| Ein Element stört dauerhaft | Exclude Styles |

3. **Was funktioniert, festnageln:** Sobald eine Stimme sitzt → als **Persona** speichern.
   Personas sind der einzige verlässliche Weg, dieselbe Stimme über mehrere Songs zu halten.
4. **Cover** = gleiche Song-DNA, andere Umsetzung. Mit Persona + Style Influence 100 % lässt
   sich gezielt nur die Stimme tauschen.
5. **Extend** verlängert und erhält Vocals, Arrangement und Persona – funktioniert aber nur,
   wenn Hook, Stimme und BPM in den ersten ~30 Sekunden stabil sind.
6. **Replace Section / Crop** für Präzisionskorrekturen an einzelnen Abschnitten, statt alles
   neu zu würfeln.

---

## 8. Copy-Paste-Vorlagen

### Vorlage: Style-Feld

```
[Genre/Subgenre], [BPM] BPM, [Stimmung], [Instrument 1], [Instrument 2], [Instrument 3],
[Vocal-Geschlecht + Register + Delivery], [Produktionsästhetik/Ära]
```

### Beispiel: Deutschsprachiger Indie-Pop

**Style**
```
German indie pop, 104 BPM, wistful but warm, jangly clean electric guitar, analog synth pads,
soft brushed drums, melodic male tenor vocals, close-mic'd conversational delivery,
sung in German, warm 2010s indie production
```

**Exclude Styles**
```
autotune, EDM drop, heavy distortion, falsetto, brass
```

**Slider:** Weirdness 30 % · Style Influence 85 %

**Lyrics**
```
[Intro]

[Verse 1]
…

[Chorus]
…

[Verse 2]
…

[Chorus]

[Bridge]
[Whispered]
…

[Chorus]

[Outro]
[End]
```

### Beispiel: Instrumental

**Style**
```
Cinematic post-rock, 76 BPM, slow build to cathartic peak, tremolo-picked electric guitar,
swelling strings, tom-heavy drums, instrumental, no vocals, wide reverberant mix
```

---

## 9. Checkliste vor dem Generieren

- [ ] Genre steht an erster Stelle
- [ ] 4–7 Kern-Deskriptoren, insgesamt unter 15 Tags
- [ ] BPM angegeben
- [ ] Vocals explizit beschrieben (oder `instrumental` gesetzt)
- [ ] 3–5 **konkrete** Instrumente statt vager Adjektive
- [ ] Keine Künstlernamen
- [ ] Keine sich widersprechenden Stimmungen/Genres
- [ ] Negativwünsche in Exclude Styles, nicht im Style-Feld
- [ ] Struktur-Tags jeweils allein auf einer Zeile
- [ ] Style Influence hoch, Weirdness niedrig
- [ ] Bei deutschen Texten: `sung in German` im Style-Feld

---

## Quellen

- [Suno Meta Tags Guide 2026 – Jack Righteous](https://jackrighteous.com/en-us/pages/suno-ai-meta-tags-guide)
- [Suno Prompt Guide: Styles vs Lyrics (v5.5) – Jack Righteous](https://jackrighteous.com/en-us/blogs/guides-using-suno-ai-music-creation/where-to-put-your-suno-prompt-guide)
- [Suno Prompt Guide 2026: Style Tags, Lyric Formatting & Technique – HookGenius](https://hookgenius.app/learn/suno-prompt-guide-2026/)
- [Best Suno V5 Prompt Guide: Formula, Examples, and Mistakes](https://suno-v5.com/blog/how-to-write-better-suno-v5-prompts)
- [Suno Guide: Tags, Meta Tags & Prompts (V5.5) – Blake Crosley](https://blakecrosley.com/guides/suno)
- [Suno Meta Tags Guide: 1000+ Tags & How to Use Them](https://sunometatagcreator.com/metatags-guide)
- [Suno Character Limits (2026) – HookGenius](https://hookgenius.app/learn/suno-character-limits/)
- [Suno Style character limit & field specs](https://usesuno.com/guide/limits/)
- [How to Use: Creative Sliders – Suno Help Center](https://help.suno.com/en/articles/6141377)
- [Suno Sliders Explained: Weirdness, Style & Audio Influence – Jack Righteous](https://jackrighteous.com/en-us/blogs/guides-using-suno-ai-music-creation/how-to-use-suno-s-advanced-sliders-weirdness-style-audio-influence)
- [SUNO Advanced Parameters Explained – AceTagGen](https://acetaggen.com/blog/weirdness-exclude-styles-reference-suno-advanced-parameters)
- [Why Most Suno AI Prompts Fail: 7 Mistakes + How to Fix – VORAX](https://www.genprompt.site/learn/suno-prompt-mistakes)
- [How to Avoid Artist Name Tags on Suno AI](https://sunoaipromptguide.org/how-to-avoid-artist-name-tags-on-suno-ai/)
- [Why Your Suno Songs Sound Generic – MusicSmith](https://musicsmith.ai/blog/ai-music-generation-prompts-best-practices)
- [Wie schreibt man den perfekten Suno AI Prompt auf Deutsch – TopMediai](https://de.topmediai.com/music-tips/suno-prompt-tutorial/)
- [Suno Prompts for German Music – HookGenius](https://hookgenius.app/learn/suno-german-prompts/)
- [Suno Remix Guide 2026: Cover, Extend, Reuse and Edit – Jack Righteous](https://jackrighteous.com/en-us/pages/suno-remix-v45-guide)
