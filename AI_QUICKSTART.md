# AI Quickstart

This document is the shortest safe path for a coding agent or local AI to clone this repository, start a deterministic simulation, and iterate a strategy. Read it before changing the simulator.

## Scope and Boundaries

- This repository is a **decision-logic simulator** for the 2026 wheeled combat robot event. It is not a claim of frame-by-frame real-robot physics fidelity.
- The browser page is for 3D observation and debugging. Local AI evaluation uses the Node HTTP service and does not need a browser.
- `wushu_ring_sim.html` is the single source for the deterministic CORE. Do not edit the copied CORE section in `wushu_ring_sim_3d.html`; edit the source, then run `node build_3d.js`.
- Read [AGENTS.md](AGENTS.md) and [CONTRACT.md](CONTRACT.md) before changing CORE, physics, sensor semantics, or the robot-process protocol.
- Do not claim that a score, friction value, or sensor model represents the real robot unless the matching entry in `fidelity.json` has real telemetry evidence and has been reviewed.

## Prerequisites

- Node.js 18 or newer.
- Python 3.10 or newer only when evaluating Python strategies. `sim_runner.py` uses only the Python standard library.
- No `npm install` is required. Three.js and Rapier assets are already in the repository.

Check the tools after cloning:

```powershell
node --version
python --version
```

If `python` is not on PATH, use the full interpreter path for the commands below, or set `SIM_PYTHON` to that executable when testing a Python robot process.

## Fastest AI Workflow

The recommended entry point is `sim_runner.py`. It starts `sim_server.js` only when necessary, reuses an already-running local server, and never shuts down a server it did not start.

```powershell
# From the repository root
python sim_runner.py doctor

# Evaluate candidate.py as US against the built-in FSM with fixed seeds:
# 42, 7, 21, 100, 123
python sim_runner.py eval --candidate candidate.py

# Compare two candidates using identical seeds, profiles, parameters, and opponent.
python sim_runner.py compare --candidate candidate.py --baseline fsm
```

Each `eval` or `compare` writes a reproducible record to `.sim_runs/<UTC-name>/result.json`. It includes the request payload, candidate SHA-256, server `coreHash`, vehicle profile, seed set, timing, and complete server result. `.sim_runs/` is intentionally ignored by Git.

Use `--trace` only when the trajectory is needed for diagnosis. The default is fast deterministic evaluation (`realtime=false`). Use `--realtime` only to exercise a real robot program whose internal threads or sleeps must advance in wall-clock time.

## Define a Strategy

An external Python strategy only needs this interface:

```python
def decide(obs):
    # Prefer rawSensors and sensorLayout for new strategies.
    # sensors contains legacy compatibility aliases.
    return {"v": 0.5, "w": 0.0}
```

`v` is linear speed and `w` is angular speed. The active vehicle profile limits both values. The observation includes `robot`, `sensors`, `rawSensors`, `sensorLayout`, `opponent`, and `objects`.

For the project vehicle profile, evaluate with:

```powershell
python sim_runner.py eval --candidate candidate.py --vehicles vehicle_profiles/robocup_wheeled_combat_11.json
```

A single vehicle profile is automatically wrapped as `{ "us": profile }`; a JSON file containing `{ "us": {...}, "them": {...} }` can describe both robots.

## Start Services and 3D Debugging

Use two terminals when a browser view or remote Python battle is needed:

```powershell
# Terminal 1: static 3D page
node static_server.js 8931

# Terminal 2: local simulation HTTP API
node sim_server.js 8932
```

Open `http://127.0.0.1:8931/wushu_ring_sim_3d.html`.

The service binds to `127.0.0.1` deliberately. It supports local code execution and must not be exposed directly to a public network. GitHub Pages can host the static 3D page, but cannot run Node, Python, remote battles, or strategy evaluation. A Pages URL may use `?api=http://127.0.0.1:8932` to target the local service.

Check service availability before attempting any operation:

```powershell
Invoke-RestMethod http://127.0.0.1:8932/api/v1/health
Invoke-RestMethod http://127.0.0.1:8932/api/v1/schema
Invoke-RestMethod http://127.0.0.1:8932/fidelity
```

If `coreBusy` is true, an evaluation or remote battle owns the singleton CORE. Wait for it to finish or use its documented `/battle/control` token. Do not issue `/step`, `/params`, `/scene`, or `/vehicle` writes against a busy CORE.

## Reproducible Field and Sensor Work

The default field grayscale and vision are placeholders. They are useful for strategy comparisons but not real-robot calibration.

To load a measured `0..1000` field-gray table, arrange rows from south to north and columns from west to east:

```powershell
$map = @{
  id = 'field-measurement-01'
  values = @(@(300, 420, 300), @(420, 1000, 420), @(300, 420, 300))
  interpolation = 'bilinear'
}
Invoke-RestMethod http://127.0.0.1:8932/field-gray -Method Post -ContentType 'application/json' -Body (@{ map = $map } | ConvertTo-Json -Depth 6)
```

Use the same table in an API evaluation/battle request as `fieldGray`, or load it once before `sim_runner.py` calls. Inspect it with `GET /field-gray?values=1`; restore the hand-drawn fallback with `POST /field-gray` body `{ "reset": true }`.

`SimVision` is synchronous by design: a real camera/YOLO process must maintain a latest-result cache outside CORE. CORE can only read that cache through `setSimVision({ id, classify(context) })`; do not await a network call or Promise inside a simulation step.

## Mandatory Checks After CORE Changes

Run these from the repository root after changing `wushu_ring_sim.html` CORE:

```powershell
node sim_selftest.js
node sim_dragtest.js
node sim_calibrate_selftest.js
node build_3d.js
node --check sim_server.js
git diff --check
```

`sim_selftest.js` currently has 29 deterministic scenarios. A legitimate code change that alters a decision contract must update or add a fixed-seed scenario and update [AGENTS.md](AGENTS.md), [CONTRACT.md](CONTRACT.md), and [SIMULATOR.md](SIMULATOR.md).

Also run these after changing the process bridge or API:

```powershell
node sim_lib_selftest.js
node sim_ai_selftest.js
```

In restricted desktop sandboxes these two may report `spawn EPERM`, because the environment prohibits child-process creation. Record that limitation; do not treat it as a CORE failure. Run them in a normal local terminal before merging bridge/API changes.

## Safe Change Order

1. Reproduce the behavior with a fixed seed and add a focused self-test.
2. Modify only the CORE source or the relevant server/runner layer. Preserve the public `decide(obs) -> {v,w}` interface.
3. Run the mandatory checks and rebuild the 3D page.
4. Use fixed-seed `sim_runner.py compare` results to assess a strategy change.
5. Update the contract documentation and `fidelity.json` only with auditable real-world evidence.

Do not commit or push unless the repository owner explicitly requests it.
