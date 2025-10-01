# 🎹 MusicXML/MIDI Visualizer

This app displays a piano roll, score (via OSMD), and an interactive keyboard.  
It supports playback, highlighting of notes, and several configuration options via URL flags.

## 🔧 URL Flags

You can configure the app by adding query parameters to the URL, e.g.:  
```
index.html?xml=score.musicxml&title=My%20Piece&loop=1
```

### File loading
- **`xml=URL`** → Load a MusicXML file from URL.  
- **`midi=URL`** → Load a MIDI file from URL.  
- **`autoplay=1`** → Start playback automatically (⚠️ browser may still require a click first).

### Tempo
- **`bpm=NUMBER`** → Override the playback tempo (in BPM).  
- If no tempo flag is given, the parser will attempt to detect tempo from the file.

### Keyboard
- **`low=NOTE/MIDI`** → Set lowest note of the keyboard (example: `low=C2` or `low=36`).  
- **`high=NOTE/MIDI`** → Set highest note of the keyboard.  
- **`transposeVis=NUMBER`** → Transpose the **keyboard visualization only** (not the audio).  
   - Example: `transposeVis=12` shifts the keys one octave higher visually.

### Playback
- **`loop=1`** → Loop playback enabled by default.  
- **`loop=0`** → Loop disabled (default).

### UI
- **`hideLog=1`** → Hide the status log block.  
- **`fitScore=1`** → Make the score fit the full page width.

### Title
- **`title=TEXT`** → Replace only the text part of the title, keeping the 🎹 emoji.  
  - Example:  
    ```
    ?title=Alors%20on%20danse
    ```
    → Displays: 🎹 Allours on danse  

- **`titleFull=1&title=TEXT`** → Replace the entire `<h1>`, including emoji.  
  - Example:  
    ```
    ?titleFull=1&title=🎵%20Alors%20on%20danse
    ```
    → Displays: 🎵 Alurs on danse  
