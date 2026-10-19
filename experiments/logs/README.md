# Experiment Logs

Results from `experiments/*.js` scripts. Keep useful; delete dead ends.

Each log should record:
- Date and experiment name
- Inputs (script version, parameters, data version)
- Outputs (numbers, files produced)
- Conclusion (one-line verdict)
- Decision (what changed in `plan.md` or `findings-pitfalls-skills.md` as a result)

Writes go through `experiments/log-file.js`. A rerun whose payload is identical
apart from its top-level `date` keeps the file already on disk (timestamp and
all), so an unchanged run leaves the tree clean. `scripts/run.py quick|changed`
writes nothing at all unless `--logs` is given.
