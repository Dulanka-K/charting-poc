// main.js - Orchestrates Main Thread UI, DOM Canvases, and Worker Spawning

const NUM_CHARTS = 16;
const GRID_SIZE = Math.ceil(Math.sqrt(NUM_CHARTS));
const VISIBLE_CANDLES = 150;
const FLOATS_PER_CANDLE = 30;

// 1. Get Mode from URL Query Parameters
const urlParams = new URLSearchParams(window.location.search);
const currentMode = urlParams.get('mode') || 'multi-2d';

// 2. Setup Mode Switcher Dropdown & Main-Thread Freeze Test Button
const modeSelect = document.getElementById('mode-select');
modeSelect.value = currentMode;
modeSelect.addEventListener('change', () => {
    urlParams.set('mode', modeSelect.value);
    window.location.search = urlParams.toString();
});

const freezeBtn = document.getElementById('freeze-btn');
if (freezeBtn) {
    freezeBtn.addEventListener('click', () => {
        freezeBtn.innerText = '🥶 Main Thread Frozen (2s)...';
        freezeBtn.style.background = '#ff6f00';
        // Allow button text to paint on next frame, then block the Main Thread for 2000ms!
        requestAnimationFrame(() => {
            setTimeout(() => {
                const start = performance.now();
                while (performance.now() - start < 2000) {
                    // Synchronous Main-Thread UI lock (simulates heavy Watchlist/DOM freeze)
                }
                freezeBtn.innerText = '⚡ Simulate 2s Main-Thread UI Freeze';
                freezeBtn.style.background = '#b71c1c';
            }, 16);
        });
    });
}

// 3. Setup Grid Layout
const grid = document.getElementById('ui-grid');
grid.style.setProperty('grid-template-columns', `repeat(${GRID_SIZE}, 1fr)`);
grid.style.setProperty('grid-template-rows', `repeat(${GRID_SIZE}, 1fr)`);

const globalCanvas = document.getElementById('chartCanvas');
let renderWorker = null;
let main2DState = null;

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

// 5. Create MessageChannel between Data Worker and Renderer (Worker or Main Thread)
const channel = new MessageChannel();

// 6. Spawn Data Worker (Identical across all 4 modes!)
const dataWorker = new Worker('data.worker.js?v=27');
dataWorker.postMessage({
    type: 'INIT',
    port: channel.port1,
    numCharts: NUM_CHARTS
}, [channel.port1]);

// 7. Setup Metrics, Bar Allocation HUD, and Heartbeats
const fpsMainEl = document.getElementById('fps-main');
const fpsWorkerEl = document.getElementById('fps-worker');
const timeRenderEl = document.getElementById('time-render');
const timeDataEl = document.getElementById('time-data');
const dragOffsetEl = document.getElementById('drag-offset-info');
const ipcModeEl = document.getElementById('ipc-mode');

function handleRenderTelemetry(data) {
    if (data.type === 'METRICS') {
        const threadTag = currentMode === 'main-2d' ? 'Main-Thread' : 'Worker';
        if (data.onDemand) {
            const stateLabel = (data.isDragging || data.fps >= 25) ? 'Active Drag' : 'On-Demand Sleep';
            fpsWorkerEl.innerText = `${threadTag} Draws: ${data.fps}/s (${stateLabel})`;
            fpsWorkerEl.className = 'metric success';
        } else {
            fpsWorkerEl.innerText = `${threadTag} FPS: ${data.fps}`;
            fpsWorkerEl.className = data.fps >= 55 ? 'metric success' : 'metric danger';
        }
        if (data.renderTimeMs !== undefined) {
            timeRenderEl.innerText = `Render Draw Time: ${data.renderTimeMs} ms`;
        }
    } else if (data.type === 'DRAG_STATUS') {
        const { chartIdx, offset, maxOffset, visibleCandles, totalCandles, totalAvailable, isDragging, justPaged } = data;
        const cfg = CHART_CONFIGS[chartIdx];
        const label = cfg ? `${cfg.symbol} (${cfg.interval})` : `Chart_${chartIdx + 1}`;

        chartLoadedCounts[chartIdx] = totalCandles;
        let totalAggregatedInRam = 0;
        for (let c = 0; c < NUM_CHARTS; c++) totalAggregatedInRam += chartLoadedCounts[c];

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
}

// 8. Branch Based on Mode
if (currentMode === 'single-pixi') {
    // Mode 1: Single Full-Screen PixiJS WebGL Canvas (Offscreen Worker)
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
    renderWorker = new Worker('render.worker.js?v=27', { type: 'module' });

    renderWorker.postMessage({
        type: 'INIT',
        port: channel.port2,
        canvas: offscreen,
        width: globalCanvas.width,
        height: globalCanvas.height,
        numCharts: NUM_CHARTS
    }, [channel.port2, offscreen]);

    renderWorker.onmessage = (e) => handleRenderTelemetry(e.data);
    hookGlobalPointerEvents(globalCanvas, renderWorker);

    window.addEventListener('resize', () => {
        renderWorker.postMessage({
            type: 'RESIZE',
            width: window.innerWidth,
            height: window.innerHeight
        });
    });

} else if (currentMode === 'main-2d') {
    // Mode 4: 16 Separate Canvases Rendered Directly on the MAIN THREAD (No Render Worker!)
    globalCanvas.style.display = 'none';
    grid.style.pointerEvents = 'auto';

    let cellWidth = Math.floor(window.innerWidth / GRID_SIZE);
    let cellHeight = Math.floor(window.innerHeight / GRID_SIZE);

    const mainCanvases = [];
    const mainContexts = [];

    for (let i = 0; i < NUM_CHARTS; i++) {
        const cfg = CHART_CONFIGS[i] || { symbol: `Chart_${i + 1}`, interval: '1m' };
        const box = document.createElement('div');
        box.className = 'ui-box';
        box.style.position = 'relative';

        const label = document.createElement('div');
        label.className = 'ui-label';
        label.innerText = `${cfg.symbol} (${cfg.interval})`;
        box.appendChild(label);

        const cellCanvas = document.createElement('canvas');
        cellCanvas.className = 'chart-cell-canvas';
        cellCanvas.width = cellWidth;
        cellCanvas.height = cellHeight;
        box.appendChild(cellCanvas);
        grid.appendChild(box);

        mainCanvases.push(cellCanvas);
        mainContexts.push(cellCanvas.getContext('2d'));

        hookCellPointerEvents(cellCanvas, i, (msg) => handleMain2DInput(msg));
    }

    initMainThread2DRenderer(channel.port2, mainCanvases, mainContexts, cellWidth, cellHeight);

} else {
    // Modes 2 & 3: 16 Separate Canvases in Offscreen Render Worker (multi-2d or multi-webgl)
    globalCanvas.style.display = 'none';
    grid.style.pointerEvents = 'auto';

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

        const cellCanvas = document.createElement('canvas');
        cellCanvas.className = 'chart-cell-canvas';
        cellCanvas.width = cellWidth;
        cellCanvas.height = cellHeight;
        box.appendChild(cellCanvas);

        grid.appendChild(box);

        const offscreen = cellCanvas.transferControlToOffscreen();
        offscreenList.push(offscreen);

        hookCellPointerEvents(cellCanvas, i, (msg) => renderWorker.postMessage(msg));
    }

    const workerFile = currentMode === 'multi-webgl'
        ? 'render.multi-webgl.worker.js?v=27'
        : 'render.multi-2d.worker.js?v=27';

    renderWorker = new Worker(workerFile, { type: 'module' });

    renderWorker.postMessage({
        type: 'INIT',
        port: channel.port2,
        canvasList: offscreenList,
        width: cellWidth,
        height: cellHeight,
        numCharts: NUM_CHARTS
    }, [channel.port2, ...offscreenList]);

    renderWorker.onmessage = (e) => handleRenderTelemetry(e.data);

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

// ============================================================================
// MAIN-THREAD CANVAS 2D RENDERER (Used when currentMode === 'main-2d')
// Identical drawing logic to render.multi-2d.worker.js, running on Main Thread
// ============================================================================

function initMainThread2DRenderer(dataPort, canvases, contexts, initialW, initialH) {
    main2DState = {
        dataPort,
        canvases,
        contexts,
        cellWidth: initialW,
        cellHeight: initialH,
        rightOffsets: new Float32Array(NUM_CHARTS).fill(0),
        dirtyFlags: new Uint8Array(NUM_CHARTS).fill(1),
        isAnyDirty: true,
        rafId: null,
        activeDrag: null,
        chartStores: [],
        totalRenderDuration: 0,
        renderCount: 0,
        drawnFramesThisSec: 0
    };

    function scheduleRedraw() {
        main2DState.isAnyDirty = true;
        if (main2DState.rafId === null) {
            main2DState.rafId = requestAnimationFrame(renderDirtyFrame);
        }
    }
    main2DState.scheduleRedraw = scheduleRedraw;

    function renderDirtyFrame() {
        main2DState.rafId = null;
        if (!main2DState.isAnyDirty || main2DState.chartStores.length === 0) return;

        const t0 = performance.now();
        let drawnCount = 0;

        for (let i = 0; i < NUM_CHARTS; i++) {
            if (main2DState.dirtyFlags[i] && main2DState.chartStores[i]) {
                renderSingleChartMain2D(
                    main2DState.contexts[i],
                    i,
                    main2DState.chartStores[i],
                    main2DState.cellWidth,
                    main2DState.cellHeight,
                    main2DState.rightOffsets[i]
                );
                main2DState.dirtyFlags[i] = 0;
                drawnCount++;
            }
        }
        main2DState.isAnyDirty = false;

        if (drawnCount > 0) {
            const duration = performance.now() - t0;
            main2DState.totalRenderDuration += duration;
            main2DState.renderCount++;
            main2DState.drawnFramesThisSec++;
        }
    }

    dataPort.onmessage = (msg) => {
        if (msg.data.type === 'SNAPSHOT') {
            const { ohlcv, sma, rsi, candlesPerChart } = msg.data;
            const baseCount = candlesPerChart || 500;
            main2DState.chartStores = [];
            for (let i = 0; i < NUM_CHARTS; i++) {
                const ohlcvSlice = new Float32Array(baseCount * FLOATS_PER_CANDLE);
                ohlcvSlice.set(ohlcv.subarray(i * baseCount * FLOATS_PER_CANDLE, (i + 1) * baseCount * FLOATS_PER_CANDLE));

                const smaSlice = new Float32Array(baseCount);
                smaSlice.set(sma.subarray(i * baseCount, (i + 1) * baseCount));

                const rsiSlice = new Float32Array(baseCount);
                rsiSlice.set(rsi.subarray(i * baseCount, (i + 1) * baseCount));

                main2DState.chartStores[i] = {
                    ohlcv: ohlcvSlice,
                    sma: smaSlice,
                    rsi: rsiSlice,
                    count: baseCount,
                    isLoadingOlder: false,
                    hasMore: true,
                    totalAvailable: 30000
                };
            }
            main2DState.dirtyFlags.fill(1);
            scheduleRedraw();
        } else if (msg.data.type === 'DELTA') {
            if (!main2DState.chartStores.length) return;
            const { deltas } = msg.data;
            for (let d = 0; d < deltas.length; d++) {
                const delta = deltas[d];
                const store = main2DState.chartStores[delta.chartIdx];
                if (!store) continue;
                const count = store.count;

                if (delta.isNewBar) {
                    store.ohlcv.copyWithin(0, FLOATS_PER_CANDLE, count * FLOATS_PER_CANDLE);
                    store.sma.copyWithin(0, 1, count);
                    store.rsi.copyWithin(0, 1, count);
                }

                const baseOffset = (count - 1) * FLOATS_PER_CANDLE;
                store.ohlcv.set(delta.candle, baseOffset);
                store.sma[count - 1] = delta.sma;
                store.rsi[count - 1] = delta.rsi;

                main2DState.dirtyFlags[delta.chartIdx] = 1;
            }
            scheduleRedraw();
        } else if (msg.data.type === 'OLDER_BARS_RESPONSE') {
            const { chartIdx, count, ohlcv: olderOhlcv, sma: olderSma, rsi: olderRsi, hasMore, totalAvailable } = msg.data;
            const store = main2DState.chartStores[chartIdx];
            if (!store) return;

            store.isLoadingOlder = false;
            store.hasMore = hasMore;
            store.totalAvailable = totalAvailable;

            if (count > 0) {
                const oldCount = store.count;
                const newCount = oldCount + count;

                const newOhlcv = new Float32Array(newCount * FLOATS_PER_CANDLE);
                const newSma = new Float32Array(newCount);
                const newRsi = new Float32Array(newCount);

                newOhlcv.set(olderOhlcv, 0);
                newSma.set(olderSma, 0);
                newRsi.set(olderRsi, 0);

                newOhlcv.set(store.ohlcv, count * FLOATS_PER_CANDLE);
                newSma.set(store.sma, count);
                newRsi.set(store.rsi, count);

                store.ohlcv = newOhlcv;
                store.sma = newSma;
                store.rsi = newRsi;
                store.count = newCount;

                main2DState.dirtyFlags[chartIdx] = 1;
                scheduleRedraw();

                handleRenderTelemetry({
                    type: 'DRAG_STATUS',
                    chartIdx,
                    offset: Math.round(main2DState.rightOffsets[chartIdx]),
                    maxOffset: newCount - VISIBLE_CANDLES,
                    visibleCandles: VISIBLE_CANDLES,
                    totalCandles: newCount,
                    totalAvailable,
                    isDragging: (main2DState.activeDrag && main2DState.activeDrag.chartIdx === chartIdx),
                    justPaged: true
                });
            }
        }
    };

    setInterval(() => {
        const avgDrawTime = main2DState.renderCount > 0
            ? (main2DState.totalRenderDuration / main2DState.renderCount).toFixed(2)
            : '0.00';
        handleRenderTelemetry({
            type: 'METRICS',
            fps: main2DState.drawnFramesThisSec,
            renderTimeMs: avgDrawTime,
            onDemand: true,
            isDragging: main2DState.activeDrag !== null
        });
        main2DState.drawnFramesThisSec = 0;
        main2DState.totalRenderDuration = 0;
        main2DState.renderCount = 0;
    }, 1000);

    window.addEventListener('resize', () => {
        main2DState.cellWidth = Math.floor(window.innerWidth / GRID_SIZE);
        main2DState.cellHeight = Math.floor(window.innerHeight / GRID_SIZE);
        main2DState.canvases.forEach(c => {
            c.width = main2DState.cellWidth;
            c.height = main2DState.cellHeight;
        });
        main2DState.dirtyFlags.fill(1);
        scheduleRedraw();
    });
}

function handleMain2DInput(data) {
    if (!main2DState) return;
    if (data.type === 'POINTER') {
        const { action, x, pointerId, chartIdx } = data;
        if (action === 'down') {
            if (chartIdx >= 0 && chartIdx < NUM_CHARTS) {
                main2DState.activeDrag = {
                    pointerId,
                    chartIdx,
                    startX: x,
                    startOffset: main2DState.rightOffsets[chartIdx]
                };
            }
        } else if (action === 'move') {
            if (main2DState.activeDrag && main2DState.activeDrag.pointerId === pointerId) {
                const idx = main2DState.activeDrag.chartIdx;
                const store = main2DState.chartStores[idx];
                if (!store) return;

                const deltaX = x - main2DState.activeDrag.startX;
                const slotWidth = main2DState.cellWidth / VISIBLE_CANDLES;
                const newOffset = main2DState.activeDrag.startOffset + (deltaX / slotWidth);
                const maxOffset = store.count - VISIBLE_CANDLES;
                const clamped = Math.max(0, Math.min(maxOffset, newOffset));
                main2DState.rightOffsets[idx] = clamped;

                main2DState.dirtyFlags[idx] = 1;
                main2DState.scheduleRedraw();

                const endBar = store.count - Math.round(clamped);
                const startBar = endBar - VISIBLE_CANDLES;
                if (startBar < 80 && store.hasMore && !store.isLoadingOlder) {
                    store.isLoadingOlder = true;
                    main2DState.dataPort.postMessage({
                        type: 'FETCH_OLDER_BARS',
                        chartIdx: idx,
                        currentLoadedCount: store.count,
                        batchSize: 500
                    });
                }

                handleRenderTelemetry({
                    type: 'DRAG_STATUS',
                    chartIdx: idx,
                    offset: Math.round(clamped),
                    maxOffset,
                    visibleCandles: VISIBLE_CANDLES,
                    totalCandles: store.count,
                    totalAvailable: store.totalAvailable,
                    isDragging: true
                });
            }
        } else if (action === 'up') {
            if (main2DState.activeDrag && main2DState.activeDrag.pointerId === pointerId) {
                const idx = main2DState.activeDrag.chartIdx;
                const store = main2DState.chartStores[idx];
                main2DState.activeDrag = null;
                handleRenderTelemetry({
                    type: 'DRAG_STATUS',
                    chartIdx: idx,
                    offset: Math.round(main2DState.rightOffsets[idx]),
                    maxOffset: store ? store.count - VISIBLE_CANDLES : 350,
                    visibleCandles: VISIBLE_CANDLES,
                    totalCandles: store ? store.count : 500,
                    totalAvailable: store ? store.totalAvailable : 30000,
                    isDragging: false
                });
            }
        }
    } else if (data.type === 'RELEASE_MEMORY') {
        const idx = data.chartIdx;
        const store = main2DState.chartStores[idx];
        if (!store || store.count <= 500) return;
        const retainCount = 500;
        const dropCount = store.count - retainCount;

        store.ohlcv = store.ohlcv.slice(dropCount * FLOATS_PER_CANDLE);
        store.sma = store.sma.slice(dropCount);
        store.rsi = store.rsi.slice(dropCount);
        store.count = retainCount;
        store.hasMore = true;
        store.isLoadingOlder = false;
        main2DState.rightOffsets[idx] = 0;
        main2DState.dirtyFlags[idx] = 1;
        main2DState.scheduleRedraw();

        handleRenderTelemetry({
            type: 'DRAG_STATUS',
            chartIdx: idx,
            offset: 0,
            maxOffset: retainCount - VISIBLE_CANDLES,
            visibleCandles: VISIBLE_CANDLES,
            totalCandles: retainCount,
            totalAvailable: store.totalAvailable,
            isDragging: false,
            memoryReleased: true
        });
    }
}

function renderSingleChartMain2D(ctx, chartIndex, store, cellWidth, cellHeight, rightOffset) {
    const totalCandles = store.count;
    const ohlcvBuffer = store.ohlcv;
    const smaBuffer = store.sma;
    const rsiBuffer = store.rsi;

    const mainHeight = cellHeight * 0.72;
    const rsiHeight = cellHeight * 0.28;
    const PADDING_Y = 10;
    const usableMainHeight = Math.max(10, mainHeight - (PADDING_Y * 2));

    const visibleCount = Math.min(VISIBLE_CANDLES, totalCandles);
    const slotWidth = cellWidth / visibleCount;
    const bodyWidth = Math.max(1, slotWidth * 0.7);

    ctx.fillStyle = '#121212';
    ctx.fillRect(0, 0, cellWidth, cellHeight);

    ctx.strokeStyle = '#2a2e39';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, cellWidth, cellHeight);

    const offset = Math.round(rightOffset);
    const endBar = Math.max(visibleCount, totalCandles - offset);
    const startBar = endBar - visibleCount;

    let minPrice = Infinity;
    let maxPrice = -Infinity;
    for (let j = startBar; j < endBar; j++) {
        const idx = j * FLOATS_PER_CANDLE;
        const high = ohlcvBuffer[idx + 2];
        const low = ohlcvBuffer[idx + 3];
        if (high > maxPrice) maxPrice = high;
        if (low < minPrice) minPrice = low;
    }
    const rawRange = (maxPrice - minPrice) || 1;
    const padding = rawRange * 0.08;
    const effectiveMin = minPrice - padding;
    const effectiveMax = maxPrice + padding;
    const priceRange = effectiveMax - effectiveMin;
    const toY = (price) => PADDING_Y + ((effectiveMax - price) / priceRange) * usableMainHeight;

    for (let j = 0; j < VISIBLE_CANDLES; j++) {
        const barIndex = startBar + j;
        const idx = barIndex * FLOATS_PER_CANDLE;
        const open = ohlcvBuffer[idx + 1];
        const high = ohlcvBuffer[idx + 2];
        const low = ohlcvBuffer[idx + 3];
        const close = ohlcvBuffer[idx + 4];
        const volume = ohlcvBuffer[idx + 5];

        const x = j * slotWidth;
        const centerX = x + (bodyWidth / 2);

        const openY = toY(open);
        const closeY = toY(close);
        const highY = toY(high);
        const lowY = toY(low);

        const isUp = close >= open;
        const color = isUp ? '#26a69a' : '#ef5350';

        const maxVol = 60000;
        const volHeight = Math.min((volume / maxVol) * (mainHeight * 0.2), mainHeight * 0.2);
        ctx.fillStyle = isUp ? 'rgba(38, 166, 154, 0.22)' : 'rgba(239, 83, 80, 0.22)';
        ctx.fillRect(x, mainHeight - volHeight, bodyWidth, volHeight);

        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(centerX, highY);
        ctx.lineTo(centerX, lowY);
        ctx.stroke();

        ctx.fillStyle = color;
        const bodyTop = Math.min(openY, closeY);
        const bodyHeight = Math.max(Math.abs(closeY - openY), 1);
        ctx.fillRect(x, bodyTop, bodyWidth, bodyHeight);
    }

    ctx.strokeStyle = '#ffb300';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let smaStarted = false;
    for (let j = 0; j < VISIBLE_CANDLES; j++) {
        const barIndex = startBar + j;
        const smaVal = smaBuffer[barIndex];
        if (!Number.isNaN(smaVal)) {
            const x = (j * slotWidth) + (bodyWidth / 2);
            const y = toY(smaVal);
            if (!smaStarted) {
                ctx.moveTo(x, y);
                smaStarted = true;
            } else {
                ctx.lineTo(x, y);
            }
        }
    }
    if (smaStarted) ctx.stroke();

    ctx.strokeStyle = '#333b47';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mainHeight);
    ctx.lineTo(cellWidth, mainHeight);
    ctx.stroke();

    const toRsiY = (val) => mainHeight + (1 - (val / 100)) * rsiHeight;
    ctx.strokeStyle = '#374151';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, toRsiY(70));
    ctx.lineTo(cellWidth, toRsiY(70));
    ctx.moveTo(0, toRsiY(30));
    ctx.lineTo(cellWidth, toRsiY(30));
    ctx.stroke();

    ctx.strokeStyle = '#ba68c8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let rsiStarted = false;
    for (let j = 0; j < VISIBLE_CANDLES; j++) {
        const barIndex = startBar + j;
        const rsiVal = rsiBuffer[barIndex];
        if (!Number.isNaN(rsiVal)) {
            const x = (j * slotWidth) + (bodyWidth / 2);
            const y = toRsiY(rsiVal);
            if (!rsiStarted) {
                ctx.moveTo(x, y);
                rsiStarted = true;
            } else {
                ctx.lineTo(x, y);
            }
        }
    }
    if (rsiStarted) ctx.stroke();
}

// Global memory release trigger helper
window.releaseMemory = (idx) => {
    if (currentMode === 'main-2d') {
        handleMain2DInput({ type: 'RELEASE_MEMORY', chartIdx: idx });
    } else if (renderWorker) {
        renderWorker.postMessage({ type: 'RELEASE_MEMORY', chartIdx: idx });
    }
};

// Main Thread FPS Heartbeat Loop
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

    canvas.addEventListener('dblclick', () => {
        postFn({ type: 'RELEASE_MEMORY', chartIdx: chartIndex });
    });
}
