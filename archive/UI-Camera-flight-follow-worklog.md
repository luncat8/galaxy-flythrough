## UI Camera Fly-to flight and follow (2026-10-15)

**Feature.** `flyToStar` (key `F`, `V`'s system-view entry, search/radius re-centre) no
longer teleports the camera onto the stand-off orbit. It now flies (plan.md §18,
"Fly-to flight and follow"):

- `FLIGHT_DURATION_S = 2` wall-clock seconds: eased f64 position lerp
  (`smoothstep(s)`, `s = elapsed/duration`) plus shortest-path quaternion slerp from the
  recorded launch pose. Straight line + slerp — predictable, cannot sweep the camera
  through the disc, and dt-free, so 30/60/144 Hz land on the identical pose (tested to
  `< 1e-12 kpc` spread).
- The arrival pose is **re-derived every frame** from the live `objectTarget`:
  `E = T + approach·d` on the launch bearing, arrival orientation looking at `T` with
  galactic-north up. A target that moves mid-flight is therefore met where it arrives.
- Arrival hands over to orbit-object mode at exactly the pose the path reached
  (`orbitDistance = d`, `placeOnOrbit()`) — centred, continuous, zero velocity.
- Any user input (look delta, movement key, wheel notch, C/H/R) cancels the flight the
  same frame into the usual orbit re-snap — which is exact ("turn, not move": the snap
  lands on the sphere of the distance the camera already had). A second `flyToStar`
  mid-flight relaunches from the current pose.
- New `camera.updateTarget(x, y, z)` moves the orbited object in place. main.js feeds it
  the landmark's live position (`OrbitLib.simpleLandmarkPosition`) whenever the camera
  orbits or flies to a landmark under a `simple` engine mask — the same dispatch the
  label layer draws, so the camera follows exactly when the star visibly moves
  (`followLandmark` set by `flyToPrimary`/`openSystemView`/landmark click, cleared by
  `clearSelection`). Field stars keep the snapshot target (the documented CPU honest gap).
- `getState()` exposes `flying`, `flightProgress`, and reports `orbitDistance` as the
  distance being flown to while airborne; the overlay camera line reads
  `camera flying to <name> NN%`.

**Gotcha fixed during the work.** An approach straight along ±Z makes galactic-north up
unusable *and* the default Sun-view up (+Z) parallel to the arrival forward — one
degeneracy check against world Z is not enough. The arrival-up selection is now a
candidate chain (world Z → current up → current right): of two orthonormal vectors at
most one can be near-parallel to a given direction, so the chain always yields a usable
basis (`FLIGHT_UP_POLE_COS = 0.99`).

**Validation.** `camera-test.js` expanded 108 → 131 checks (launch/mid-flight/arrival
pose contracts, stand-off 0 and clamp cases, 30/60/144 Hz arrival identity, follow after
and during flight, cancel continuity via the sphere-radius invariant, pole-approach
orthonormality across all 125 frames, relaunch, action cancellation, allocation-free
flight). Full suite `python3 scripts/run.py all-tests` → 30/30 suites passed.

**Next step suggestion.** Optional polish: chain flights (N-cycling primaries) could
shorten the duration for short hops; a flight easing curve tuned on real hardware belongs
in the deferred browser pass (V7/V9 checklist rows).
