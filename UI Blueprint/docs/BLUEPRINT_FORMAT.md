# UI Blueprint Format `uib/0.1`

UI Blueprint documents are JSON. The format is designed as an intermediate representation between a visual sketch, an AI system, and future code exporters.

## Core rule

Visual geometry and semantic meaning are separate:

- `type` says what primitive was drawn.
- `role` says what the primitive means in the target interface.

A generic `box` can therefore represent a button, card, input, HUD region, product tile, or project-specific concept without changing the core schema.

## Document

```json
{
  "schema": "uib/0.1",
  "id": "doc_...",
  "name": "Example",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "screens": [],
  "components": [],
  "tokens": {
    "spacing": {},
    "typography": {},
    "radius": {},
    "color": {}
  },
  "flows": [],
  "extensions": {}
}
```

`components`, `tokens`, `flows`, and `extensions` are intentionally reserved in v0.1. The editor does not require them to create a useful blueprint.

## Screen

```json
{
  "id": "screen_...",
  "name": "Dashboard",
  "platform": "desktop",
  "width": 1440,
  "height": 900,
  "background": "#ffffff",
  "nodes": []
}
```

`platform` is metadata, not a rendering constraint. Current editor presets include `desktop`, `web`, `mobile`, `tablet`, `game`, and `custom`.

## Node

```json
{
  "id": "box_...",
  "type": "box",
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
    "fill": "#f7f7f8",
    "stroke": "#73737d",
    "textColor": "#202124",
    "radius": 8,
    "fontSize": 14,
    "textAlign": "center"
  },
  "extensions": {}
}
```

### Primitive types

`uib/0.1` uses a deliberately small primitive set:

- `frame` — semantic region / container
- `box` — generic labeled rectangular UI object
- `text` — standalone text
- `image` — visual/asset placeholder

The primitive set should remain small. Domain meaning belongs in `role`.

## Coordinate model

In v0.1, node bounds use screen coordinates in pixels. `parentId` expresses semantic hierarchy but does not change the coordinate origin.

This choice keeps early drawing and AI handoff trivial. A future schema version may add local coordinate spaces for reusable components without invalidating the explicit screen-space geometry already stored here.

## Role

`role` is an open string namespace. Examples:

```text
navigation.topbar
navigation.sidebar
content.card
action.primary
action.destructive
input.field
status.metric
editor.toolbar
game.character-status
commerce.product-card
project.custom-role
```

Consumers must not reject unknown roles.

## Note

`note` carries behavior, state, or design intent that geometry cannot express:

```text
Collapsed until an action is chosen.
Visible only during initiative.
This panel should feel quiet and low priority.
Click opens the full character sheet without leaving the session.
```

Notes are intentionally free-form because they are primarily human/AI handoff context.

## Future-compatible fields

`layout` and `constraints` are nullable in v0.1. Future versions can describe relationships such as:

```json
{
  "layout": {
    "mode": "row",
    "gap": 12,
    "justify": "end",
    "align": "center"
  },
  "constraints": {
    "horizontal": "stretch",
    "vertical": "bottom"
  }
}
```

Unknown fields and extension data should be preserved by consumers where possible.

## AI handoff subset

The editor's **Copy for AI** action intentionally sends only one active screen plus the fields relevant to reproduction. It omits hidden nodes and document editor metadata to reduce token cost and handoff latency.
