# UI Blueprint

UI Blueprint is a lightweight visual utility for turning rough UI intent into an AI-readable blueprint as quickly as possible.

It is intentionally not a Figma replacement. The core loop is:

> choose a primitive -> draw -> Select activates automatically -> move or resize immediately -> add text and intent -> copy for AI

The editor stores exact bounds, text, hierarchy, semantic roles, notes, and lightweight appearance data. The active screen can be copied as a compact AI handoff or exported as an editable `.uib.json` document.

## Run

Requires Node.js 18+ and has no npm dependencies.

```bash
npm start
```

Then open `http://localhost:4173`.

Run checks with:

```bash
npm test
```

## Interaction model

| Action | Input |
| --- | --- |
| Select | `V` |
| Frame | `F` |
| Box | `B` |
| Button | `U` |
| Text | `T` |
| Image placeholder | `I` |
| Edit node text / Frame name | double-click or `Enter` |
| Nudge | arrow keys |
| Nudge 10px | `Shift` + arrow keys |
| Duplicate | `Ctrl/Cmd + D` |
| Delete | `Delete` / `Backspace` |
| Undo / Redo | `Ctrl/Cmd + Z` / `Ctrl/Cmd + Shift + Z` |
| Toggle 8px snap grid | `G` |
| Fit artboard | `0` |
| Zoom | `+` / `-` |
| Pan | hold `Space` and drag |
| Copy active screen for AI | `Ctrl/Cmd + Shift + C` |

Every drawing tool is one-shot. After a node is created, UI Blueprint immediately switches back to Select and shows an 8-handle resize gizmo on the new node.

## Frame vs Box

Frame and Box now have intentionally different jobs.

### Frame

A Frame is a large structural container.

- larger default size
- dashed, low-priority visual treatment
- nodes fully inside it become children automatically
- moving the Frame moves its descendants as a group
- shrinking or moving nodes can automatically update containment
- nested Frames are supported

### Box

A Box is a generic UI surface. Use it for cards, fields, panels, custom controls, and any rectangular object that does not need a dedicated primitive.

### Button

Button is a dedicated fast primitive because buttons are frequent enough that treating every button as a generic Box creates unnecessary handoff ambiguity. It defaults to the semantic role `action.button`.

## Detailed Inspector controls

Selected nodes expose exact bounds and intent. Appearance controls now include:

- fill and stroke colors
- border width and style
- corner radius
- text color
- font size and weight
- line height
- horizontal and vertical alignment
- X/Y padding

Text keeps surface controls out of the way and focuses on typography. Frames focus on container identity and surface treatment.

## Outputs

### Copy for AI

Copies only the active screen and strips editor-only state. The payload includes exact geometry, hierarchy, node type, text, roles, notes, and appearance. Frame child relationships are explicitly included.

### Copy preview

Copies a PNG of the current screen when the browser supports image clipboard. Otherwise it downloads the PNG.

### Export `.uib.json`

Exports the complete editable document, including multiple screens and reserved extension areas.

## Design principles

1. Hover should teach the next action without requiring documentation.
2. Creation is one-shot; Select is the stable resting state.
3. The canvas is direct manipulation. Move and resize where the result is visible.
4. Frame means structure, not just another rectangle.
5. Output is first-class. AI handoff is a primary action.
6. Meaning stays explicit. `type` is the primitive and `role` is target-interface semantics.
7. The format should outlive this editor.

## Project structure

```text
UI Blueprint/
|-- index.html
|-- styles.css
|-- server.mjs
|-- src/
|   |-- app.js
|   |-- model.js
|   |-- export.js
|   `-- storage.js
|-- docs/
|   `-- BLUEPRINT_FORMAT.md
|-- examples/
|   `-- vtt-session.uib.json
`-- tests/
    `-- model.test.mjs
```
