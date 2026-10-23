# High-Performance Multi-Chart Engine (PoC)

A high-performance financial charting Proof of Concept (PoC) rendering **16 simultaneous real-time charts** (4 symbols × 4 timeframes: `1m`, `5m`, `15m`, `1h`) with zero UI lag.

## Key Architectural Highlights

- **Contiguous TypedArray Memory (`Float32Array`):** Flat binary OHLCV and indicator storage with zero JavaScript object overhead and zero Garbage Collection (GC) pauses.
- **Dedicated Data Worker (`data.worker.js`):** Offloads raw tick ingestion, multi-timeframe bar aggregation (`1m` -> `5m`, `15m`, `1h`), and technical indicators (`SMA`, `RSI`) from the Main Thread.
- **OffscreenCanvas Render Workers:** Direct worker-to-worker data pipeline via `MessageChannel`, transmitting compact binary deltas (`120 bytes` per tick).
- **On-Demand VSync Scheduler:** Event-driven `requestAnimationFrame` rendering with selective dirty-flag invalidation (`0%` background CPU when idle; `60 FPS` during interaction).
- **Canvas 2D Path Batching:** Groups bullish and bearish candlesticks into 2 batched GPU draw passes (`~1ms` total render time).
- **Lookahead Historical Pagination:** Dynamically streams 500-bar historical chunks from a 30,000-bar worker store while panning, with on-demand memory release.

## Rendering Modes Included

Switch between four architecture benchmarks directly from the HUD dropdown:
1. **16x Canvas 2D — Offscreen Worker (`render.multi-2d.worker.js`)** — *Recommended*: 16 independent `OffscreenCanvas` 2D contexts isolated in a worker thread (immune to Main-Thread UI freezes).
2. **16x Canvas 2D — Main Thread (`main.js`)**: Renders the exact same 16 Canvas 2D contexts directly on the Main Thread (no Render Worker) to compare Main-Thread UI contention vs. `OffscreenCanvas` isolation using the built-in **"⚡ Simulate 2s Main-Thread UI Freeze"** button.
3. **Single Canvas WebGL (`render.worker.js`)**: Single fullscreen PixiJS WebGL context partitioned into 16 chart viewports.
4. **16x WebGL (`render.multi-webgl.worker.js`)**: 16 separate PixiJS WebGL contexts (demonstrates browser 16-context hardware limits).

## Running Locally

Because the project uses pure ES Modules and Web Workers with zero build steps, serve the directory over any static HTTP server:

```bash
npx http-server . -p 8080 -c-1
```

Then open `http://localhost:8080/index.html` in your browser.

## Project Structure

- `index.html` — Workspace grid and telemetry HUD
- `main.js` — Main-thread orchestrator, worker lifecycle, and pointer/resize forwarding
- `data.worker.js` — Historical `Float32Array` store, tick generator, timeframe aggregator, and `SMA`/`RSI` calculator
- `render.multi-2d.worker.js` — 16-canvas Native 2D renderer with path batching
- `render.worker.js` — Single-canvas PixiJS WebGL renderer
- `render.multi-webgl.worker.js` — 16-canvas PixiJS WebGL renderer
