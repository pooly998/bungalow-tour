# Three-bedroom bungalow tour

A walkable 3D tour of the living room, dining area, kitchen, corridor and front porch, built to scale from a 2D floor plan.
Everything runs in the browser: open `index.html` from a web server, or publish this folder with GitHub Pages.

- Drag to look around. Click or tap the floor to walk. W A S D or the arrow keys also move you.
- The room buttons, the mini plan and the guided tour move you between rooms.
- The Finishes button swaps the floor and upholstery colours.

## Files

- `index.html`, `app.js`: the page and the viewer.
- `scene.json`: geometry, materials, navigation data and viewpoints.
- `lm_*.jpg`: baked lighting. Other `.jpg` / `.png` files: surface textures.
- `vendor/three.module.min.js`: three.js 0.170.0 (MIT licence, see `vendor/THREE-LICENSE.txt`).

Furniture and finishes are indicative. The plan carried no dimensions, so the scale is an estimate.
