# UI Blueprint

UI Blueprint is a lightweight visual utility for turning rough UI intent into an AI-readable blueprint as quickly as possible.

It is intentionally **not** a Figma replacement. The core loop is:

> draw → label → add intent only where needed → copy for AI

The editor stores exact bounds, text, hierarchy, semantic roles, notes, and lightweight appearance data. The active screen can then be copied as a compact AI handoff or exported as an editable `.uib.json` document.

## Why this exists

Image-only wireframes are fast to make but ambiguous to reproduce. Design tools can describe everything, but creating a full design can be slower than the UI idea itself.

UI Blueprint sits between them:

- faster than a high-fidelity design tool
- more exact than a screenshot
- readable by humans
- structured for AI and code generation
- generic enough for web, desktop, mobile, game UI, dashboards, and utilities

## Run

Requires Node.js 18+ and has no npm dependencies.

```bash
npm start
```

Then open:

```text
http://localhost:4173
```

Run the model/export tests with:

```bash
npm test
```

## Fast interaction model

| Action | Input |
| --- | --- |
| Select | `V` |
| Frame | `F` |
| Box | `B` |
| Text | `T` |
| Image placeholder | `I` |
| Edit node text | double-click or `Enter` |
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

### The Box tool is the default sketch primitive

Drag a Box and release. Text editing starts immediately, so a rough interface can be built as a sequence of:

1. press `B`
2. drag
3. type label
4. press `Enter`
5. drag the next box

Use `Role` only when the visual shape alone is ambiguous, for example `navigation.sidebar`, `action.primary`, or a project-specific role.

## Outputs

### Copy for AI

Copies only the active screen and strips editor-only state. The payload includes:

- screen size and platform
- exact node bounds
- node type and name
- visible text
- semantic role
- parent frame when present in the blueprint
- notes / behavior intent
- lightweight appearance

This is the fastest handoff path.

### Copy preview

Copies a PNG of the current screen when the browser supports image clipboard. Otherwise it downloads the PNG.

### Export `.uib.json`

Exports the complete editable document, including multiple screens and reserved extension areas.

## Project structure

```text
UI Blueprint/
├─ index.html
├─ styles.css
├─ server.mjs
├─ src/
│  ├─ app.js        # editor interaction and rendering
│  ├─ model.js      # UI Blueprint document model
│  ├─ export.js     # SVG/PNG/JSON helpers
│  └─ storage.js    # local autosave
├─ docs/
│  └─ BLUEPRINT_FORMAT.md
├─ examples/
│  └─ vtt-session.uib.json
└─ tests/
   └─ model.test.mjs
```

## Design principles

1. **Hover should teach.** Controls explain action, shortcut, and expected result without opening documentation.
2. **The canvas is direct manipulation.** Position and size are edited where they are seen; the Inspector exists for precision and intent.
3. **Output is first-class.** AI handoff is a primary top-bar action, not an export submenu.
4. **Meaning is optional but explicit.** `type` describes the primitive; `role` describes its semantic purpose.
5. **The format outlives the editor.** Code generators and future editors should consume the blueprint format without depending on this UI.
6. **No mandatory design system.** A user can sketch immediately. Tokens, components, flows, layout constraints, and plugins can expand later without blocking the basic loop.

## Next expansion points

The `uib/0.1` format already reserves document-level areas for components, design tokens, flows, and extensions. Candidate editor features include:

- auto-layout / stack and grid intent
- constraints and responsive relationships
- reusable components and variants
- interaction flow links
- asset references
- code exporters
- AI-generated blueprint import
- plugin namespaces

Those should be added only when they make the draw → handoff loop faster rather than turning UI Blueprint into a general-purpose design suite.
