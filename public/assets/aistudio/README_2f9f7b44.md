# sound_morph

**A multitouch XY sample morpher** – vier Samples in vier Ecken, mehrere Finger, ein Morph-Pad.

Schwester-App zu [sound_comp](https://soundcomp.vercel.app), gleiche minimalistische Gestaltung.

## Funktionen

- **Vier Ecken (A–D):** Samples per Mikrofon aufnehmen (max. 15 s, Stille wird automatisch abgeschnitten und normalisiert) oder als Audiodatei laden. Mit *Demo Sounds* sind vier synthetische Loops (Drone, Pulse, Pluck, Voice) sofort spielbar.
- **Multitouch-Pad:** Jeder Finger ist eine eigene Stimme. Touchpunkte lassen sich frei bewegen; die Position bestimmt die Klangparameter in Echtzeit.
- **Latch:** Punkte bleiben nach dem Loslassen stehen, können wieder gegriffen und verschoben oder per Antippen entfernt werden.
- **Performance-Recording:** Die Ausgabe aufnehmen und als Audiodatei herunterladen.

## Morph-Algorithmen

Grundlage ist die bilineare Gewichtung der vier Ecken (A = oben links, B = oben rechts, C = unten links, D = unten rechts).

| Algorithmus | Was passiert |
|---|---|
| **Blend** | Equal-Power-Crossfade zwischen den vier Samples. |
| **Filter** | Jede Ecke hat einen eigenen Tiefpass: ferne Ecken bleiben hörbar, klingen aber dumpf, nahe Ecken öffnen sich. Resonanz einstellbar. |
| **Grain** | Granulare Wolke: Grains werden gewichtet zufällig aus allen Ecken gezogen. Je weiter vom Zentrum, desto mehr Streuung (Position und Tonhöhe). Grain Size und Density einstellbar. |
| **Tape** | Blend plus Bandgeschwindigkeit auf der X-Achse (±Speed Range in Oktaven) und Helligkeit (Tiefpass) auf der Y-Achse. |

## Entwicklung

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # Ausgabe in dist/
```

Stack: Vite, React 19, TypeScript, Tailwind CSS 4, Web Audio API (keine weiteren Audio-Bibliotheken).

## Deployment auf Vercel

Repository in Vercel importieren – das Framework „Vite“ wird automatisch erkannt (Build: `npm run build`, Output: `dist`). `vercel.json` setzt Sicherheits-Header und erlaubt den Mikrofonzugriff.

## Struktur

```
src/
  audio/morph.ts     Morph-Algorithmen (XY → Parameter)
  audio/engine.ts    Web-Audio-Engine: Stimmen, Grains, Reverb, Limiter, Aufnahme
  audio/samples.ts   Laden, Aufnahme, Aufbereitung, Demo-Sounds
  components/        MorphPad (Canvas + Pointer Events), CornerSlot, Slider, Icons
  App.tsx            Oberfläche
```

## Hinweise

- iPhone: Ohne Ton bitte den Stummschalter ausschalten.
- Mikrofonaufnahme benötigt HTTPS (auf Vercel automatisch gegeben).
