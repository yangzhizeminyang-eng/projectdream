# Cinematic Continuity Skill

## Purpose

Help the storyboard and video agents reduce wardrobe drift, spatial discontinuities, body/object intersections, and unmotivated camera motion. This skill is a set of generation and review controls, not a promise that a generative video model will obey every constraint.

## Source Material

Distilled from the supplied `基础运镜.pptx`, `视频篇pptx.pptx`, `tts.pptx`, the `tianjie-character-fen-jue` identity/diagnostic/layout/model/realism references, and the three `shot01-v1.mp4` through `shot03-v1.mp4` samples.

The character reference skill's three-view prompt is an optional reference only. ProjectDream's existing role-asset and three-view workflow remains authoritative and is not replaced by this document.

## Lock Order

1. **Identity and wardrobe:** use only the adopted character asset and its version. Preserve face, hair, age impression, body proportions, outfit silhouette, collar, front closure, layers, pockets, seams, cuffs, hem, footwear, and fixed accessories. When the character turns, reveal a plausible back of the same outfit; do not invent a new construction.
2. **Scene topology:** use the adopted scene view and scene anchors for foreground/midground/background, openings, fixed furniture, counter/table planes, lighting direction, and walkable paths. A reference image guides appearance and does not prove unseen geometry. Do not invent hidden geometry during a camera move.
3. **Screen direction and occlusion:** state who is nearer/farther, which object is in front, where hands contact the object, what supports it, and the path into/out of frame. Keep those relations stable for the duration of the shot.
4. **One action and one camera move:** each shot has one primary visible action and at most one motivated camera move. Prefer locked camera or a simple push/pull, pan/tilt, track, or follow. Use a reveal pan for new spatial information; use orbit only when the story needs it and the path is clear. Do not stack orbit, zoom, pan, and crossing actors in one short generation.
5. **Performance and sound:** specify who speaks and when, preserve approved dialogue wording, and keep original video audio when the workflow requests it. Dialogue timing belongs to the shot plan; do not accelerate speech to fit.

## Editorial Geography and Prop Continuity

- Keep the 180-degree axis and screen direction consistent across dialogue, eyelines, and handoffs. If a motivated crossing changes the axis, insert a neutral establishing shot before returning to reverse angles.
- A new character needs script evidence and a legible entrance path. Establish the entrance with a doorway, off-screen movement or sound, a reaction, or a revealing camera move; do not introduce them silently in a reverse angle.
- Track important props per shot: owner at shot start, visible contact/transfer, and owner or resting place at shot end. A cut must not silently change hands, duplicate, erase, or merge the prop.
- Keep the scene's entry/exit direction and fixed anchors stable. Before cutting to a new angle, verify that actor positions and walkable paths can exist in the same set layout.
- In the supplied 30-second review sample, the adopted outfits remain broadly recognizable, while the handoff's contact/ownership is difficult to read and a new character appears without a clear entrance beat. Treat these as continuity-review findings, not as claims that frame inspection proves the exact generation cause.

## Physical Interaction Contract

For every handoff, grasp, touch, sit, lean, or object placement, describe:

- the initiating body part and target surface/object;
- the visible contact point and support surface;
- the near/far occlusion order;
- the continuous path and end state;
- what must not intersect, merge, teleport, or float.

If the interaction requires multiple hands, several actors crossing, or an unseen side of the set, split it into clearer shots or use closer framing. Do not rely on a generic negative prompt to repair an under-specified action.

## Continuity Workflow

1. Read the adopted character, scene, prop, storyboard, and previous/next shot snapshots. Preserve confirmed facts; label inference instead of silently turning it into canon.
2. Choose the shot size, camera angle, composition, screen direction, one main action, and one camera move from the dramatic purpose. Low/high angle, front/side/back, push/pull, pan/tilt, tracking, and orbit must each have an explicit information or emotion purpose.
3. Write a compact shot prompt in this order: reference roles and adopted versions; opening state; spatial positions and occlusion; action beats; camera move; dialogue/audio timing; ending state and next-shot handoff.
4. When continuity is enabled, the previous adopted video's exact last frame is the next shot's first-frame reference. Preserve that frame in storage and verify its pixel hash against the final candidate's decoded first frame before adoption.
5. Review generated video against identity/wardrobe, space/occlusion, anatomy/contact, motion/camera, and audio. A failed category blocks adoption; the report names the failed evidence and affected time range when available.
6. Repair by diagnosis: preserve successful identity, framing, lighting, and action; name one primary failure and at most two secondary issues; change only the failed property. Do not rewrite the entire prompt by default.

## Failure Classes and Repair

- **Wardrobe drift:** compare silhouette, layer count, collar/front closure, pockets, cuffs/hem, color, and accessories with the adopted version. Keep successful face/action/camera; repair the divergent garment feature only.
- **Spatial discontinuity:** compare fixed anchors, screen direction, depth order, and scene view. Restore only missing/moved anchors and simplify camera motion if it reveals unsupported geometry.
- **Editorial jump:** compare shot-to-shot screen direction, axis, character entrance evidence, and prop ownership. Add a neutral geography shot or clarify the establishing beat; do not hide a continuity error with a dissolve.
- **穿模 / contact failure:** identify the exact body/object pair and time interval. Clarify contact point, support, near/far order, and movement path; simplify or split the action if necessary.
- **Identity/anatomy drift:** preserve the adopted identity reference and reduce simultaneous body/camera motion. Do not try to solve facial identity by adding unrelated costume adjectives.
- **Camera failure:** state the start/end camera position and one motivated movement. Remove competing moves and preserve the intended subject action.
- **Dialogue/audio timing:** keep approved words and speaker binding. Adjust shot duration or split the beat rather than changing the dialogue or forcing unnatural acceleration.

After two failures of the same class, change one supported control at a time (reference selection, camera complexity, duration, or local repair strategy). Keep the same confirmed assets. Never claim a text prompt guarantees frame-perfect clothing or zero intersections; use video inspection and human review as the final acceptance gate.

## Character Three-View Boundary

This skill does not author, normalize, or replace character three-view prompts. The existing role-agent method and approved character blueprint remain the source of truth; these rules only consume the adopted role asset during storyboard/video work.
