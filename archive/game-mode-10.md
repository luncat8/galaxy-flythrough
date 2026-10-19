**Plan first** (per AGENTS.md): the full G4 design now lives in `game-mode-plan.md` §10 — the station contract, dockable conditions, the dock commit, the docked ride, life support's teeth, the home port, the cargo hook, and the refusal matrix.

**The station** — any natural flight target (locked destination or primary selection). `O` docks when settled (≤ 1 m/s relative) inside the stand-off shell; the commit re-arms the tank, restores life support, registers the **port of registry**, and lands a `dock-port` asset in ui.1's typed asset history. Docked, the ship rides the station's drawn motion (life support pauses at the port); thrust keys, Space, `O`, class swap, `R` and hull switches undock; a station leaving residency breaks the dock honestly.

**Life support bites** — exact countdown, critical warning inside the class's 10 %-floored band, and at zero a **hard return-home marker**: an amber chrome frame plus a persistent HUD line pointing at the port of registry (last docked station, else the frame-fixed galaxy home), dismissed only by the next dock.

**Cargo hook** — `L`/`Shift+L` load/unload at the dock only, free (economy stays omitted, matching 0.5).
