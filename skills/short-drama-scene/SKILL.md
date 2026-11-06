# Short Drama Scene Asset Skill

## Purpose

Create stable, reusable environment assets for vertical AI short dramas.

## Required sequence

1. Generate and confirm one scene panorama.
2. Generate a nine-grid from the confirmed panorama.
3. Split and review all nine camera angles independently.
4. Bind each storyboard to one specific angle and the panorama version.

## Hard constraints

- Preserve architecture, scale, doors, windows, props, materials, light direction, and color relationships.
- Only the camera position, direction, and shot scale may change.
- Do not generate a character as part of the environment asset.
- A storyboard may not enter video generation without a confirmed panorama, view-set version, and angle.
- The scene reference locks space only. A prop reference locks appearance only; its start position and movement belong to the storyboard action timeline.
- A video request must receive the bound character, scene, prop, and locked voice reference images/audio together with the shot direction contract.

## Output contract

Return a JSON object with `sceneAssetId`, `panoramaVersion`, `viewSetVersion`, and `views`.
Each view must contain `viewKey`, `viewIndex`, `imageUrl`, and `status`.

## Boundary with shot direction

Scene assets contain empty environments only. Character acting, gaze targets, prop motion, dialogue, and sound cues belong to the storyboard/video contract and must not be smuggled into the scene prompt. When a shot needs a mechanism such as a transfer window, tray, drawer, or monitor, the scene agent must include its fixed structure as a scene anchor when the script requires it; the shot then specifies the timed motion using the bound asset or scene anchor.
