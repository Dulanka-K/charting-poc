// main.js - Orchestrates Main Thread UI, DOM Canvases, and Worker Spawning

const NUM_CHARTS = 16;
const GRID_SIZE = Math.ceil(Math.sqrt(NUM_CHARTS));

// 1. Get Mode from URL Query Parameters
const urlParams = new URLSearchParams(window.location.search);
const currentMode = urlParams.get('mode') || 'single-pixi';

// 2. Setup Mode Switcher Dropdown
const modeSelect = document.getElementById('mode-select');
modeSelect.value = currentMode;
modeSelect.addEventListener('change', () => {
    urlParams.set('mode', modeSelect.value);
    window.location.search = urlParams.toString();
});

// 3. Setup Grid Layout
const grid = document.getElementById('ui-grid');
grid.style.setProperty('grid-template-columns', `repeat(${GRID_SIZE}, 1fr)`);
grid.style.setProperty('grid-template-rows', `repeat(${GRID_SIZE}, 1fr)`);

const globalCanvas = document.getElementById('chartCanvas');
let renderWorker;

// 4. Chart Configurations (Symbols & Aggregated Timeframes)
const CHART_CONFIGS = [
    { symbol: 'AAPL', interval: '1m' },
    { symbol: 'TSLA', interval: '1m' },
    { symbol: 'NVDA', interval: '1m' },
    { symbol: 'MSFT', interval: '1m' },

    { symbol: 'AAPL', interval: '5m' },
    { symbol: 'TSLA', interval: '5m' },
    { symbol: 'NVDA', interval: '5m' },
    { symbol: 'MSFT', interval: '5m' },

    { symbol: 'AAPL', interval: '15m' },
    { symbol: 'TSLA', interval: '15m' },
    { symbol: 'NVDA', interval: '15m' },
    { symbol: 'MSFT', interval: '15m' },

    { symbol: 'AAPL', interval: '1h' },
    { symbol: 'TSLA', interval: '1h' },
    { symbol: 'NVDA', interval: '1h' },
    { symbol: 'MSFT', interval: '1h' },
];

// Track loaded bars per chart for live HUD calculation
const chartLoadedCounts = new Uint32Array(NUM_CHARTS).fill(500);

// 5. Create MessageChannel between Data Worker and Render Worker
const channel = new MessageChannel();

// 6. Spawn Data Worker (Identical across all modes!)
const dataWorker = new Worker('data.worker.js?v=23');
dataWorker.postMessage({
    type: 'INIT',
    port: channel.port1,
    numCharts: NUM_CHARTS
}, [channel.port1]);

// 7. Branch Based on Mode
if (currentMode === 'single-pixi') {
    // Mode 1: Single Full-Screen PixiJS WebGL Canvas
    globalCanvas.style.display = 'block';
    globalCanvas.width = window.innerWidth;
    globalCanvas.height = window.innerHeight;

    for (let i = 0; i < NUM_CHARTS; i++) {
        const cfg = CHART_CONFIGS[i] || { symbol: `Chart_${i + 1}`, interval: '1m' };
        const box = document.createElement('div');
        box.className = 'ui-box';
        box.innerHTML = `<div class="ui-label">${cfg.symbol} (${cfg.interval})</div>`;
        grid.appendChild(box);
    }

    const offscreen = globalCanvas.transferControlToOffscreen();
    renderWorker = new Worker('render.worker.js?v=23', { type: 'module' });

    renderWorker.postMessage({
        type: 'INIT',
        port: channel.port2,
        canvas: offscreen,
        width: globalCanvas.width,
        height: globalCanvas.height,
        numCharts: NUM_CHARTS
    }, [channel.port2, offscreen]);

    // Forward pointer events from the single canvas
    hookGlobalPointerEvents(globalCanvas, renderWorker);

    window.addEventListener('resize', () => {
        renderWorker.postMessage({
            type: 'RESIZE',
            width: window.innerWidth,
            height: window.innerHeight
        });
    });

} else {
    // Modes 2 & 3: 16 Separate Canvases!
    globalCanvas.style.display = 'none'; // Hide single canvas
    grid.style.pointerEvents = 'auto'; // Enable pointer events for DOM grid

    const cellWidth = Math.floor(window.innerWidth / GRID_SIZE);
    const cellHeight = Math.floor(window.innerHeight / GRID_SIZE);

    const offscreenList = [];

    for (let i = 0; i < NUM_CHARTS; i++) {
        const cfg = CHART_CONFIGS[i] || { symbol: `Chart_${i + 1}`, interval: '1m' };
        const box = document.createElement('div');
        box.className = 'ui-box';
        box.style.position = 'relative';

        const label = document.createElement('div');
        label.className = 'ui-label';
        label.innerText = `${cfg.symbol} (${cfg.interval})`;
        box.appendChild(label);

        // Create independent canvas for this cell!
        const cellCanvas = document.createElement('canvas');
        cellCanvas.className = 'chart-cell-canvas';
        cellCanvas.width = cellWidth;
        cellCanvas.height = cellHeight;
        box.appendChild(cellCanvas);

        grid.appendChild(box);

        // Transfer control of each canvas individually
        const offscreen = cellCanvas.transferControlToOffscreen();
        offscreenList.push(offscreen);

        // Hook individual pointer events
        hookCellPointerEvents(cellCanvas, i, (msg) => renderWorker.postMessage(msg));
    }

    const workerFile = currentMode === 'multi-webgl' 
        ? 'render.multi-webgl.worker.js?v=23' 
        : 'render.multi-2d.worker.js?v=23';

    renderWorker = new Worker(workerFile, { type: 'module' });

    renderWorker.postMessage({
        type: 'INIT',
        port: channel.port2,
        canvasList: offscreenList,
        width: cellWidth,
        height: cellHeight,
        numCharts: NUM_CHARTS
    }, [channel.port2, ...offscreenList]);

    window.addEventListener('resize', () => {
        const newW = Math.floor(window.innerWidth / GRID_SIZE);
        const newH = Math.floor(window.innerHeight / GRID_SIZE);
        renderWorker.postMessage({
            type: 'RESIZE',
            width: newW,
            height: newH
        });
    });
}

// Global memory release trigger helper
window.releaseMemory = (idx) => {
    if (renderWorker) {
        renderWorker.postMessage({ type: 'RELEASE_MEMORY', chartIdx: idx });
    }
};

// 8. Setup Metrics, Bar Allocation HUD, and Heartbeats
const fpsMainEl = document.getElementById('fps-main');
const fpsWorkerEl = document.getElementById('fps-worker');
const timeRenderEl = document.getElementById('time-render');
const timeDataEl = document.getElementById('time-data');
const dragOffsetEl = document.getElementById('drag-offset-info');
const ipcModeEl = document.getElementById('ipc-mode');

let lastTime = performance.now();
let frames = 0;
function loop() {
    frames++;
    const now = performance.now();
    if (now - lastTime >= 1000) {
        fpsMainEl.innerText = `Main Thread FPS: ${frames}`;
        fpsMainEl.className = frames >= 55 ? 'metric success' : 'metric danger';
        frames = 0;
        lastTime = now;
    }
    requestAnimationFrame(loop);
}
loop();

renderWorker.onmessage = (e) => {
    if (e.data.type === 'METRICS') {
        if (e.data.onDemand) {
            const stateLabel = (e.data.isDragging || e.data.fps >= 25) ? 'Active Drag' : 'On-Demand Sleep';
            fpsWorkerEl.innerText = `Render Draws: ${e.data.fps}/s (${stateLabel})`;
            fpsWorkerEl.className = 'metric success';
        } else {
            fpsWorkerEl.innerText = `Render Worker FPS: ${e.data.fps}`;
            fpsWorkerEl.className = e.data.fps >= 55 ? 'metric success' : 'metric danger';
        }
        if (e.data.renderTimeMs !== undefined) {
            timeRenderEl.innerText = `Render Draw Time: ${e.data.renderTimeMs} ms`;
        }
    } else if (e.data.type === 'DRAG_STATUS') {
        const { chartIdx, offset, maxOffset, visibleCandles, totalCandles, totalAvailable, isDragging, justPaged, memoryReleased } = e.data;
        const cfg = CHART_CONFIGS[chartIdx];
        const label = cfg ? `${cfg.symbol} (${cfg.interval})` : `Chart_${chartIdx + 1}`;
        const endBar = totalCandles - offset;
        const startBar = endBar - visibleCandles;

        // Update chart loaded bars tracking
        chartLoadedCounts[chartIdx] = totalCandles;
        let totalAggregatedInRam = 0;
        for (let c = 0; c < NUM_CHARTS; c++) totalAggregatedInRam += chartLoadedCounts[c];

        const elAgg = document.getElementById('bar-agg');
        const elAggTotal = document.getElementById('bar-agg-total');
        if (elAggTotal) elAggTotal.innerText = `${totalAggregatedInRam.toLocaleString()} in RAM`;

        if (dragOffsetEl) {
            const availText = totalAvailable ? totalAvailable.toLocaleString() : '30,000';
            if (offset === 0) {
                const memHint = totalCandles > 500 ? ` <button style="background: #2a2e39; color: #ffb74d; border: 1px solid #4b5563; border-radius: 3px; padding: 1px 6px; cursor: pointer; font-size: 10px; margin-left: 4px;" onclick="window.releaseMemory(${chartIdx})">Release (${totalCandles}B → 500B)</button>` : '';
                dragOffsetEl.innerHTML = `• Drag: <b style="color: #fff;">${label}</b> [Live edge] (${totalCandles.toLocaleString()} bars in RAM / ${availText} in store)${memHint}`;
            } else {
                const statusColor = isDragging ? '#e040fb' : '#ce93d8';
                const pageBadge = justPaged ? ` <span style="background: #2e7d32; color: #fff; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: bold;">+500 Paged!</span>` : '';
                const releaseBtn = totalCandles > 500 ? ` <button style="background: #2a2e39; color: #ffb74d; border: 1px solid #4b5563; border-radius: 3px; padding: 1px 6px; cursor: pointer; font-size: 10px; margin-left: 4px;" title="Double-click chart or click to release back to 500 bars" onclick="window.releaseMemory(${chartIdx})">Release Memory</button>` : '';
                dragOffsetEl.innerHTML = `• Drag: <b style="color: #fff;">${label}</b> [Offset: <b style="color: ${statusColor};">${offset}</b> / ${maxOffset}] (Loaded: <b>${totalCandles.toLocaleString()}</b> / ${availText})${pageBadge}${releaseBtn}`;
            }
        }
    }
};

dataWorker.onmessage = (e) => {
    if (e.data.type === 'DATA_METRICS') {
        timeDataEl.innerText = `Math/Data Time: ${e.data.mathTimeMs} ms`;
        if (ipcModeEl && e.data.bytesTransferred !== undefined) {
            ipcModeEl.innerText = `IPC Stream: Delta (${e.data.bytesTransferred} B / tick)`;
        }
    } else if (e.data.type === 'DATA_INFO') {
        const { rawBarsPerSymbol, candlesPerChart, numCharts, symbolsCount } = e.data;
        const elRaw = document.getElementById('bar-raw');
        const elRawTotal = document.getElementById('bar-raw-total');
        const elAgg = document.getElementById('bar-agg');
        const elAggTotal = document.getElementById('bar-agg-total');
        const elVis = document.getElementById('bar-vis');
        const elVisTotal = document.getElementById('bar-vis-total');

        if (elRaw) elRaw.innerText = rawBarsPerSymbol.toLocaleString();
        if (elRawTotal) elRawTotal.innerText = `${(rawBarsPerSymbol * symbolsCount).toLocaleString()} total`;
        if (elAgg) elAgg.innerText = candlesPerChart.toLocaleString();
        if (elAggTotal) elAggTotal.innerText = `${(candlesPerChart * numCharts).toLocaleString()} in RAM`;
        if (elVis) elVis.innerText = '150';
        if (elVisTotal) elVisTotal.innerText = `${(150 * numCharts).toLocaleString()} total`;
    }
};

// Pointer Event Helpers
function hookGlobalPointerEvents(canvas, worker) {
    canvas.addEventListener('pointerdown', (e) => {
        canvas.setPointerCapture(e.pointerId);
        canvas.style.cursor = 'grabbing';
        worker.postMessage({ type: 'POINTER', action: 'down', x: e.clientX, y: e.clientY, pointerId: e.pointerId });
    });
    canvas.addEventListener('pointermove', (e) => {
        worker.postMessage({ type: 'POINTER', action: 'move', x: e.clientX, y: e.clientY, pointerId: e.pointerId });
    });
    const end = (e) => {
        canvas.style.cursor = 'grab';
        worker.postMessage({ type: 'POINTER', action: 'up', pointerId: e.pointerId });
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    // Double-click to release historical memory and return to live edge
    canvas.addEventListener('dblclick', (e) => {
        const cellWidth = canvas.width / GRID_SIZE;
        const cellHeight = canvas.height / GRID_SIZE;
        const col = Math.floor(e.clientX / cellWidth);
        const row = Math.floor(e.clientY / cellHeight);
        const chartIdx = row * GRID_SIZE + col;
        worker.postMessage({ type: 'RELEASE_MEMORY', chartIdx: chartIdx });
    });
}

function hookCellPointerEvents(canvas, chartIndex, postFn) {
    canvas.addEventListener('pointerdown', (e) => {
        canvas.setPointerCapture(e.pointerId);
        canvas.style.cursor = 'grabbing';
        postFn({ type: 'POINTER', action: 'down', x: e.offsetX, y: e.offsetY, pointerId: e.pointerId, chartIdx: chartIndex });
    });
    canvas.addEventListener('pointermove', (e) => {
        postFn({ type: 'POINTER', action: 'move', x: e.offsetX, y: e.offsetY, pointerId: e.pointerId, chartIdx: chartIndex });
    });
    const end = (e) => {
        canvas.style.cursor = 'grab';
        postFn({ type: 'POINTER', action: 'up', pointerId: e.pointerId, chartIdx: chartIndex });
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    // Double-click to release historical memory and return to live edge
    canvas.addEventListener('dblclick', () => {
        postFn({ type: 'RELEASE_MEMORY', chartIdx: chartIndex });
    });
}
