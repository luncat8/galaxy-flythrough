# Deferred: constellations from one saved observer

**Status: planned, not implemented or visually validated.** This replaces the
assumption that ui.22/23 already solved the own sky. Leave the current controls
and code in place until this work is taken up; a unit test passing is not a
verdict that the user's sky looks or behaves correctly.

## Goal and scope

Create one set of figures as an observer would see them from the position of
an explicitly selected object, typically an HQ. Rank stars by apparent
brightness from that position, not by distance from the camera or intrinsic
brightness. This is one saved observer per session/galaxy, not a cache per
selection or an automatic creation at every location. A later game mode may
consume this same saved set; no game-mode implementation is required here.
The Milky Way's curated figures and the created figures are mutually exclusive.

## Audit first

Reproduce with a selected star near the Sun and in a procedural galaxy, at
paused and running star time, and record the camera, selection, star budget,
engine mask and sky setting. Inspect the resulting candidate and drawn-edge
counts and a real browser frame. Do not assume the existing implementation is
correct merely because its isolated math tests pass. In particular:

- `main.js` scans resident records, excludes the entire landmark block, and
  feeds a fixed 8192-row pool; `pushCandidate` keeps the *first* qualifying
  rows, not necessarily the brightest if the pool fills. Its fixed 500 pc
  radius is not a physical naked-eye completeness guarantee. The selected
  star itself can enter the pool at zero distance. Drawn magnitudes and
  formation gates also need auditing against this selection calculation.
- `drawAsterisms` resolves live slots and projects from the camera; the
  resulting picture is only the observer's sky when the camera is at the
  anchor. Residency, identity, and simple-engine motion may diverge between
  building, rendering and selection. Measure rather than assume parity.
- `NamedSky.reasonOf` checks galaxy and epoch before rate, whereas own-sky
  suspension checks only whether that reason is `REASON_FAST`. Thus a fast
  clock in a non-Milky-Way or out-of-epoch sky can fail to suspend own figures.
- Failed creation and an anchor that streams out need explicit, tested
  behaviour; the existing last-eye fallback can silently build a different sky.

## Contract

1. A dedicated, collapsible **Constellations** panel is available in observe,
   fly and command workspaces, follows the existing panel layout/persistence
   rules, and owns creation, mode, auto-update and status. Move the related GUI
   out of Controls, retaining discoverable keyboard shortcuts. Show saved
   anchor, selected mode, creation/refresh status and suspension reason; disable
   Create with an explanation if no supported object is selected.
2. **Create** snapshots the selected object's stable identity and the drawn
   position at the current epoch. Success atomically replaces the previous
   anchor and set, selecting own mode. Selection changes never re-anchor or
   create; failed creation preserves the previous good set and reports why.
   Define supported object kinds during the audit; do not silently treat a
   stale or unresolvable object as the origin. The anchor follows the saved
   object's drawn motion when resolvable. If unavailable, suspend refresh and
   say so; do not quietly substitute a stale position. Regeneration or changing
   galaxy/seed must invalidate or re-resolve by explicit identity rules, never
   attach the saved set to an unrelated reused slot.
3. Choose **off / Milky Way / created** with a single authoritative state.
   Only one line set can draw. Milky Way remains subject to its existing
   galaxy/epoch applicability gate; an unavailable choice reports why. Merely
   changing the mode or selection never creates a set. Preserve the built-in
   Milky Way preset and clarify how P/Shift+P/K map to this state.
4. At creation/refresh evaluate the actual eligible stars' drawn positions and
   apparent magnitude `M + 5 log10(distance_pc) - 5`, accounting for birth and
   rendered brightness/evolution consistently. Exclude the observer itself,
   invalid positions and invisible/unformed stars. Include eligible named stars
   when their data are applicable: exclusivity concerns **lines**, not the
   existence of stars. Specify and display any magnitude limit, candidate
   coverage and approximations; an arbitrary radius or first-N pool must not
   silently discard a brighter eligible star. Use deterministic magnitude and
   identity tie-breaks, bounded top-K selection, and deterministic, legible
   angular figures. Handle sparse skies, identity collisions and no-edge sets.
   This describes the available simulated stars, not a promise of a complete
   real human sky; renderer thinning and residency limits must be made explicit.
5. Auto-update is opt-in. When the saved set becomes stale as star time moves
   in either direction, recompute from the same anchor: stars that are now too
   dim leave and newly bright ones can join. Keep the old valid set until a
   complete replacement is ready. Bound work and cadence; avoid flicker and
   preserve identity for unchanged stars where practical. With auto-update off,
   membership/edges do not change, though endpoints may follow the same drawn
   stars. Clock jumps and rewinds must not trigger an unbounded update loop.
6. Above the chosen absolute star-time speed threshold, suspend **both draw
   and update** for both sets regardless of galaxy/epoch; preserve choice,
   anchor and set. The fast-rate gate is independent of the Milky Way gate.
   Manual Create while fast should report suspension and leave the previous set
   intact; after slowing, drawing resumes and an enabled stale refresh may run.
   Document the inclusive boundary and handle paused/reverse clocks.
7. Draw edges at the same rendered positions and formation visibility as their
   sprites for every engine mask. Explain that the sky is defined from the
   saved observer; a camera away from it sees that 3-D geometry in parallax,
   not a newly generated sky. Streaming must not reconnect edges to a different
   star; report incomplete resident coverage rather than silently inventing it.

## Ordered work and acceptance

- **C0 — reproduce and instrument:** browser steps above plus deterministic
  fixture(s) for candidate ranking, pool overflow, zero-distance self exclusion,
  fast non-Milky-Way gating and engine/residency parity. Capture failing cases.
- **C1 — model and lifecycle:** one atomic saved-anchor/set owner, explicit
  invalidation and failure states, stable identities, unbiased bounded ranking,
  brightness/birth and draw-position parity. Define any coverage limitation.
- **C2 — refresh and gates:** independent speed gate, rewind/jump handling,
  opt-in refresh and cadence; stale and missing-anchor transitions exercised.
- **C3 — panel and integration:** dedicated workspace panel and status, one
  mode selector, shortcuts and preset behaviour, layout and persistence.
- **C4 — validation:** Node integration tests for creation only on action,
  selecting another object, failed replacement, regeneration, stream out/in,
  brightness changes, auto on/off, forward/reverse/jump, threshold boundary,
  both galaxy types and all masks, exclusive mode transitions and preset/shortcut
  parity. Run affected suites. Separately check 1280×800 and small viewport in
  a real WebGPU browser: edges land on visible stars from the saved position,
  figures read clearly, panel is usable, refresh is not distracting, and fast
  movement suspends then restores the view. Record evidence and limitations;
  mock/Node tests cannot close the visual verdict.
