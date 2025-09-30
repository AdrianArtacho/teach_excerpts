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