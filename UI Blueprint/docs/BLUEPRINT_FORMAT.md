# UI Blueprint Format `uib/0.2`

UI Blueprint documents are JSON. The format is an intermediate representation between a visual sketch, AI, and future code exporters.

## Core rules

- `type` describes the primitive that was drawn.
- `role` describes what that primitive means in the target interface.
- `parentId` is structural hierarchy. Frames are containers, not only visual rectangles.
- bounds are still absolute screen-space pixels in v0.2 for simple editing and fast AI handoff.

## Document

```json
{
  "schema": "uib/0.2",
  "id": "doc_...",
  "name": "Example",
  "screens": [],
  "components": [],
  "tokens": {},
  "flows": [],
  "extensions": {}
}
```

Imports from `uib/0.1` are upgraded to the current schema by the editor.

## Primitive types

- `frame` - structural container / region
- `box` - generic rectangular UI surface
- `button` - common action control
- `text` - standalone text
- `image` - visual / asset placeholder

Dedicated primitives should only be added when they materially reduce repeated ambiguity or editing friction. Domain-specific meaning still belongs in `role`.

## Node

```json
{
  "id": "button_...",
  "type": "button",
  "name": "Save Button",
  "role": "action.primary",
  "parentId": "frame_...",
  "bounds": {
    "x": 1180,
    "y": 820,
    "width": 160,
    "height": 48
  },
  "text": "Save",
  "note": "Enabled when there are unsaved changes.",
  "locked": false,
  "hidden": false,
  "layout": null,
  "constraints": null,
  "style": {
    "fill": "#eaf0fb",
    "stroke": "#50698f",
    "textColor": "#1b2a41",
    "radius": 8,
    "fontSize": 14,
    "fontWeight": 600,
    "lineHeight": 1.2,
    "textAlign": "center",
    "verticalAlign": "center",
    "borderWidth": 1,
    "borderStyle": "solid",
    "paddingX": 14,
    "paddingY": 8
  },
  "extensions": {}
}
```

## Frame containment

The editor derives `parentId` from geometry. A node fully contained by a Frame becomes a child of the smallest containing Frame. Nested Frames are allowed.

Moving a Frame in the editor moves all of its descendants by the same delta. Resizing a Frame does not scale children. If the new geometry no longer contains a child, hierarchy is reconciled after the gesture.

The coordinate origin remains the screen, even for children. This keeps handoff explicit and avoids hidden transform math.

## Appearance

`style` is lightweight visual intent, not a complete CSS model. Current fields are:

- `fill`
- `stroke`
- `textColor`
- `radius`
- `fontSize`
- `fontWeight`
- `lineHeight`
- `textAlign`
- `verticalAlign`
- `borderWidth`
- `borderStyle`
- `paddingX`
- `paddingY`

Consumers should preserve unknown style and extension fields where possible.

## Role

`role` remains an open string namespace. Examples:

```text
navigation.topbar
navigation.sidebar
content.card
action.button
action.primary
action.destructive
input.field
status.metric
game.character-status
project.custom-role
```

Consumers must not reject unknown roles.

## AI handoff subset

Copy for AI sends only the active screen and fields relevant to reproduction. Hidden nodes and editor-only state are omitted to reduce token cost and handoff latency.
