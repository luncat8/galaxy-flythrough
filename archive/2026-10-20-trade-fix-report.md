## The bug, measured

Trade decisions (`pickDestination`, `pickExport`, `pickCandidate`, the frontier scan, the panel's `ly`) all read **birth** coordinates, while booking read live ones — so the caps (`MAX_LEG_LY`, `MAX_FOUND_LY`) were checked against a number the hull never flew. Through the shipping dispatch, field stars 250 pc from home:

| birth pair | 1 Myr | 10 Myr | 60 Myr (1 min at default 1 Myr/s) | 200 Myr |
|---|---|---|---|---|
| 1 007 ly | 989 | 1 517 | 6 213 | 18 984 |

Over the landmark sky the mean stretch of each star's birth-nearest pair is 4.4× at 10 Myr, 37× at 100 Myr (worst 583×). A 30 ly hop scored as one and flew 3 000.

## The design (trade-plan §9)

Four knowledge tiers, one cache, and **every** distance the network acts on is a live one:

- **frozen** (star clock stopped) → the whole layer is skipped; the network is bit-identical to before (tested).
- **closed form** (classic/apocenter) → live positions + prediction at any star time.
- **mirrored** (friction field) → a new *tracked mirror* in `orbit.js`: θ per record (≤512, the ports + candidate pool), seeded where the renderer seeds its θ buffer, stepped per frame with the shipping substep rule, reconstructed through `simplePositionFromTheta`, integrated forward for prediction.
- **blind** → birth coordinates only, never predicted.

Two laws: a **linear plan** from cached positions *and rates* (no resolver call — so reachability is answered for every partner in a scoring loop), then an **exact intercept solve** for the winner. The critical correction: the leg is measured as the **endpoints' separation at arrival, in the field's frame** — my first inertial version refused every route in the galaxy within a Myr, because at the synced rate a trade year is 10⁻³ Myr of sky and the disc turns 765 ly per star Myr. Rigid rotation must cancel; only differential shear tears routes.

In flight, hulls are **steering agents**: re-aimed twice a second, positioned by *flown distance over the current chord* (not elapsed time — with the time fraction a voyage whose chord grew to 12 000 years still read "97 % flown"), and **turned around** past `1.6×` their cap or when the target outruns them (`outrun`). Freighters fly home with cargo; founders refund their volunteers (verified across the arrival event: jump = party, exactly).

## Cost (measured)

43 µs/frame for 512 tracked records · 3 µs per friction-field prediction (0.85 µs classic) · 0.3–0.9 ms per geometry refresh · 0.4–1.4 ms per 128-hull maintenance pass, twice a second, zero when frozen.

## Validated

`trade-test.js` **134/134** (20 new §17 checks), `orbit-test.js` **134/134** (8 new), `wgsl-validate.js` **186/186** (ladder checks follow it into the θ twin), and `all-tests` **38/38**. A 120 s shearing-sky run: network keeps trading and growing (12 ports, 356 800 units vs 550 800 frozen), no hull ever left past the give-up margin.

Docs updated: `trade-plan.md` §5/§9, a `trade.8` worklog entry, and a `findings` note on measuring moving-sky legs in the field's frame. Not verified: the browser — the overlay riding stars, the panel's `live routes · N turned back` note, and a visible turn-around; and one product question is now on record (the default star clock stretches the network's geography 4× inside a minute, which is honest but reads as a network winding down).