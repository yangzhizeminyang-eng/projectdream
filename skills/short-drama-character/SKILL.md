# Short Drama Character Asset Skill

## Purpose

Create production-ready character identity assets for vertical AI short dramas.

## Required sequence

1. Lock the character identity and costume description.
2. Confirm one reference portrait.
3. Generate a three-view sheet from that confirmed reference.
4. Split and review `front`, `side`, and `back` as independent views.
5. Store the view-set version and approval state.

## Hard constraints

- The three views must depict the same face, hairstyle, body, costume, accessories, and age.
- Only the camera direction may change.
- Do not introduce a second person, text, watermark, or new costume.
- A storyboard may not enter video generation without a confirmed character version and view-set version.

## Output contract

Return a JSON object with `characterId`, `characterVersionNo`, `viewSetVersion`, and `views`.
Each view must contain `viewKey`, `viewIndex`, `imageUrl`, and `status`.
