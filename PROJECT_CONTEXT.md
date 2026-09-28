# PROJECT_CONTEXT — SIH26143 oil-spill investigation system (checkpoint)

Hand-over notes so a new developer/AI can continue from this snapshot. Read with `README.md`.

## Problem
Smart India Hackathon 2026, problem **SIH26143**: detect marine oil spills in satellite SAR imagery, characterise
them, **hindcast** the slick back to a probable source region/time (and forecast forward), then correlate with
**historical AIS** vessel tracks to rank *candidate* vessels with explainable evidence. Output is decision support —
never "vessel X caused the spill". Scores are an uncalibrated **Evidence Correlation Score**, not a probability.

## Current state (what works)
- Runs on **real, key-free data**: Sentinel-1 GRD (Microsoft Planetary Computer STAC), Open-Meteo marine
  currents + ERA5/forecast wind, Danish Maritime Authority (DMA) historical AIS, GSHHG coastline.
- Demo region is **Danish waters** (the only free historical AIS used). Indian waters: SAR + forcing work, but no free
  historical AIS exists — an `AISProvider` for an institutional/commercial feed is needed.
- End-to-end verified via API/UI on real scenes: fresh area ≈ 10 min (mostly one-time AIS day downloads,
  ~0.5–0.7 GB each); repeat investigation in a cached area ≈ 1–1.5 min. 33 tests pass (offline fixtures).

## Architecture (modular monolith)
```
frontend/ React 19 + Vite + TS + Tailwind v4 + shadcn/ui (Base UI) + MapLibre   (UI only, no science)
   │ REST + SSE
backend/app/api/main.py  FastAPI; single background worker thread; job queue (duplicate jobs refused, /api/v1/queue);
   │                     startup warm-up (OpenDrift import, landmask, model); interrupted jobs marked FAILED on restart
backend/app/services/pipeline.py  the ONLY orchestrator (CLI main.py uses the same functions)
   ├─ sar/sentinel1.py, sar/cogread.py   STAC search; AOI extraction via GCPs; parallel COG tile reads (HTTP/1.1,
   │                                     timeouts); land mask; calibrated radiometric normalisation (sos_normalize)
   ├─ segmentation/ (model_loader, inference, postprocess)   DeepLabV3+/ResNet34, sliding window, cropped components
   ├─ geospatial/ (georeference, polygon)                    GeoTIFF/sidecar georef, WGS84 polygons, geodesic area
   ├─ sar_ship_detection/detector.py                         CA-CFAR point targets + SAR/AIS matching
   ├─ lookalike/triage.py                                    per-slick OIL_LIKELY/LOOKALIKE_LIKELY/UNCERTAIN indicators
   ├─ environmental/forcing.py   NetCDF + Open-Meteo providers (probe-sized domain, snapped cache reuse, pacing,
   │                             fail-fast on hourly quota), cached OpenDrift readers
   ├─ drift/ (opendrift_runner, backtrack, source_probability)  OpenOil; ALL ensemble members in ONE run;
   │                             backward (weathering off) + forward 24 h; KDE + 50/80/95 % HDR source regions
   ├─ ais/ (dma_provider, local_provider, track_processing, corridor_filter, gaps, retrieval)
   │                             DMA daily zip -> Parquet cache; Arrow-side filtering/thinning; vectorised cleaning;
   │                             spatio-temporal corridor matching vs time-resolved particle cloud (vectorised)
   ├─ scoring/ (features, scorer, evidence_report)   feature scores, weighted score, epistemically-labelled statements
   ├─ reports/report.py   JSON/Markdown/HTML report       ├─ database/ File repo (default) + PostGIS repo (untested)
```

## Pipeline / state machine
Phase 1: `QUEUED → SCENE_ACQUISITION → SCENE_INSPECTION → GEOREFERENCING → PREPROCESSING → SEGMENTATION →
POLYGONIZATION → SAR_SHIP_DETECTION → LOOKALIKE_ANALYSIS → AWAITING_SLICK_SELECTION` (investigator ticks slick(s)).
Phase 2: `ENVIRONMENTAL_DATA → BACKWARD_DRIFT → SOURCE_ESTIMATION → AIS_PROCESSING → AIS_GAP_ANALYSIS →
SAR_AIS_MATCHING → CANDIDATE_SCORING → REPORT → COMPLETED | PARTIAL | FAILED`.
Key rules: release window offsets `[0,0.5,1,3,6,12,24,36,48] h`; starts at T only for ship-trail slicks, otherwise
≥ 1 h (assumption); SAR-attached vessel (AIS matched to SAR target touching slick) = strongest evidence (15 % weight).
Weights: spatial .25, temporal .25, trajectory .15, sar_attached .15, vessel_type .07, behaviour .08, continuity .05.

## Model
`models/best_oil_spill_deeplabv3_resnet34.pth` (Git LFS, 258 MB; torch zip format; includes optimizer state).
`smp.DeepLabV3Plus(encoder_name="resnet34", in_channels=3, classes=1)`, trained on the Refined Deep-SAR Oil Spill
(SOS) dataset (notebook: `models/training_notebook.ipynb`); input RGB/255 (no mean/std), 256×256 tiles, output logit
→ sigmoid → 0.5. Val Dice 0.746 / IoU 0.640 at epoch 3. Real Sentinel-1 must be normalised to SOS-like statistics
(`configs/config.yaml → sentinel1.normalization`: background grey 150, 40 grey per speckle σ, 10 km p60 background),
calibrated with `scripts/calibrate_radiometry.py` (clean-sea FP 15 % → 0.02 %; implanted −6 dB slicks 100 % recall).

## Important files
`configs/config.yaml` (every threshold/weight) · `backend/app/services/pipeline.py` · `backend/app/api/main.py` ·
`main.py` (CLI) · `frontend/src/App.tsx`, `frontend/src/components/{MapView,panels}.tsx` · `scripts/scan_real_slicks.py`
(shortlist real scenes) · `scripts/calibrate_radiometry.py` · `tests/` (fixtures in `tests/fixtures/`, app never reads them)
· `docs/ARCHITECTURE_AND_CONCEPTS.md`, `docs/SIH_PRESENTATION.md`.

## How to run
```powershell
python -m venv .venv; .\.venv\Scripts\Activate.ps1
pip install torch --index-url https://download.pytorch.org/whl/cu130   # or cu128/cpu
pip install -r requirements.txt
pip install --force-reinstall --no-deps torch --index-url https://download.pytorch.org/whl/cu130   # smp swaps in CPU torch
cd frontend; npm install; npm run build; cd ..
.\.venv\Scripts\python -m uvicorn app.api.main:app --app-dir backend --port 8000   # open http://localhost:8000
.\.venv\Scripts\python -m pytest -q tests
```
UI flow: draw AOI → search scenes → Acquire & detect → tick slick(s) in Triage → Investigate → Candidates → Evidence → Report.
CLI: `python main.py scenes|detect|triage|investigate|report|run|list` (see README §11).

## Known limitations / open issues
- Model trained only 3 epochs on SOS, no look-alike negatives; still needs analyst triage; fine-tuning on real
  Sentinel-1 (with look-alike negatives) is the top next step (retraining only if the owner asks).
- No genuine real ship-discharge slick found yet in 16 scanned Danish scenes (Aug–Sep 2026).
- Open-Meteo free tier: ~600 locations/min, 5,000/hour, 10,000/day — heavy use hits the hourly limit (fails fast with
  a clear message). CMEMS/ERA5 NetCDF (`environment.provider: netcdf`) is the alternative.
- First-time AIS per new day is network-bound (~0.5–0.7 GB DMA zip + ~30 s indexing); cached afterwards.
- Single analysis worker (one job at a time). Docker/PostGIS path written but never run (no Docker here).
- Optional keyed sources (CMEMS, CDSE, GFW, Indian AIS) listed in `/api/v1/sources` but not integrated.
- Windows gotchas: pandas 3 datetimes not ns (use `to_epoch_s`); MapLibre forces `position:relative` on its container.
