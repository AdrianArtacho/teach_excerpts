# Interactive Excerpts

The idea is to show little music excerpts in ways the kids can practice at home.

---

PYTHON

```bash
python3 -m http.server 5500
```

then open:
http://localhost:5500/yourfile.html

NODE.JS

```
npx serve .
```

---

## Load piece with URL

/your-page.html?xml=https://example.com/path/your-piece.musicxml&autoplay=1

Example:

/alter31.html?xml=excerpt0.musicxml&autoplay=1

## Set keyboard ranges:

/your-page.html?xml=https://example.com/piece.musicxml&low=C3&high=G5&rangeStrict=1

Example:

/alter31.html?xml=excerpt0.musicxml&low=C3&high=G5&rangeStrict=1

MIDI numbers: ?low=48&high=72

Note names: ?low=C3&high=G5, ?low=F#2&high=Eb5

Strict range (default): &rangeStrict=1 → exactly this window (snapped to octaves)

Flexible baseline: &rangeStrict=0 → at least this; auto-fit may expand

Force auto-fit even if a range was given: &fit=1

Examples

Exact 4-octave window C3–B6:

?page.html?xml=...&low=C3&high=B6&rangeStrict=1


Baseline C3–G5, but expand if needed:

?page.html?xml=...&low=C3&high=G5&rangeStrict=0


Ignore any provided range and auto-fit to notes:

?page.html?xml=...&fit=1

---

## Titling

Examples

Custom title text (keeps emoji):
?title=My%20Lovely%20Excerpt

Full title override (you provide everything, including emoji/HTML):
?title=<span>🎼%20Bach%20Invention%20No.%201</span>&titleFull=1

Load a score and show a custom title:
?xml=https://example.com/piece.musicxml&title=Beispiel%20Stücke

---

Query parameters you can use

?xml=URL or ?midi=URL

?title=Custom%20Title

?bpm=120

?low=C3&high=G5 (also accepts MIDI numbers)

?rangeStrict=0 (let auto-fit expand beyond your low/high if needed)

?fit=1 (force fit-to-notes)

?autoplay=1 (subject to browser gesture rules)

---

Notes:

Keep XML files in the same domain (e.g., /scores/alors0.xml). Then ?xml=./scores/alors0.xml avoids cross-origin/CORS altogether.

If you do cross-origin later, the other host must send Access-Control-Allow-Origin: * (or your domain).

---

This is the default URL (served by GitHub):

https://adrianartacho.github.io/teach_excerpts/

Example:

https://adrianartacho.github.io/teach_excerpts/?xml=./scores/alors0.musicxml&title=Alors%20On%20Danse

All your existing URL flags continue to work (low, high, bpm, autoplay, fit, rangeStrict, and the title override that keeps the emoji).

---

## How to embed

```html
<iframe
  src="https://<user>.github.io/<repo>/?xml=./scores/alors0.xml&title=Alors%20On%20Danse&autoplay=1"
  width="100%"
  height="980"
  style="border:0; max-width:1000px; width:100%; display:block; margin:0 auto;"
  allow="autoplay"
  loading="lazy"
></iframe>
```

---
