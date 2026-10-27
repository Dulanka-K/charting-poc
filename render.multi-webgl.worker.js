// render.multi-webgl.worker.js - 16 Separate Canvases using PixiJS WebGL (Testing Context Limits)

import * as PIXI from './pixi-worker.min.mjs';

let apps = [];
let graphicsList = [];
let canvases = [];
let NUM_CHARTS = 16;
let cellWidth = 0;
let cellHeight = 0;
let dataPort = null;

const VISIBLE_CANDLES = 500;
const FLOATS_PER_CANDLE = 30;

let rightOffsets = new Float32Array(16).fill(0);
let activeDrag = null;
let chartStores = []; // Array of { ohlcv, sma, rsi, count, isLoadingOlder, hasMore, totalAvailable }

// Selective Invalidation / Dirty Flags (1 = dirty, 0 = clean)
let dirtyFlags = new Uint8Array(16).fill(1);
let isAnyDirty = true;
let rafId = null;

// Telemetry counters
let lastRenderTime = 0;
let totalRenderDuration = 0;
let renderCount = 0;
let drawnFramesThisSec = 0;

// ON-DEMAND RENDER SCHEDULER ("Wake-on-Dirty")
function scheduleRedraw() {
    isAnyDirty = true;
    if (rafId === null) {
        rafId = requestAnimationFrame(renderDirtyFrame);
    }
}

function renderDirtyFrame() {
    rafId = null;
    if (!isAnyDirty || chartStores.length === 0) return;

    const t0 = performance.now();
    let drawnCount = 0;

    for (let i = 0; i < apps.length; i++) {
        if (dirtyFlags[i] && chartStores[i]) {
            renderSinglePixiChart(graphicsList[i], i, chartStores[i]);
            if (apps[i] && apps[i].renderer) {
                apps[i].renderer.render(apps[i].stage);
            }
            dirtyFlags[i] = 0;
            drawnCount++;
        }
    }
    isAnyDirty = false;

    if (drawnCount > 0) {
        const duration = performance.now() - t0;
        totalRenderDuration += duration;
        renderCount++;
        lastRenderTime = duration;
        drawnFramesThisSec++;
    }
}

onmessage = (e) => {
    if (e.data.type === 'INIT') {
        const { port, canvasList, width, height, numCharts } = e.data;
        dataPort = port;
        NUM_CHARTS = numCharts;
        canvases = canvasList;
        cellWidth = width;
        cellHeight = height;
        rightOffsets = new Float32Array(NUM_CHARTS).fill(0);
        dirtyFlags = new Uint8Array(NUM_CHARTS).fill(1);

        console.log(`[Multi-WebGL Worker] Attempting to spawn ${NUM_CHARTS} separate WebGL contexts...`);

        // Initialize 16 separate PIXI.Application instances with autoStart: false (On-Demand)!
        for (let i = 0; i < NUM_CHARTS; i++) {
            const canvas = canvases[i];
            
            canvas.addEventListener('webglcontextlost', (event) => {
                event.preventDefault();
                console.error(`🚨 WebGL Context LOST on Chart_${i + 1}! Browser killed this context due to limit exhaustion!`);
            });

            try {
                const app = new PIXI.Application({
                    view: canvas,
                    width: cellWidth,
                    height: cellHeight,
                    backgroundColor: 0x121212,
                    resolution: 1,
                    autoStart: false
                });
                if (app.ticker) app.ticker.stop();
                
                const g = new PIXI.Graphics();
                app.stage.addChild(g);
                
                apps.push(app);
                graphicsList.push(g);
            } catch (err) {
                console.error(`💥 Failed to create WebGL context for Chart_${i + 1}:`, err);
            }
        }

        console.log(`[Multi-WebGL Worker] Successfully created ${apps.length} / ${NUM_CHARTS} WebGL applications.`);

        dataPort.onmessage = (msg) => {
            if (msg.data.type === 'SNAPSHOT') {
                const { ohlcv, sma, rsi, candlesPerChart, floatsPerCandle } = msg.data;
                const baseCount = candlesPerChart || 1000;
                chartStores = [];
                for (let i = 0; i < NUM_CHARTS; i++) {
                    const ohlcvSlice = new Float32Array(baseCount * FLOATS_PER_CANDLE);
                    ohlcvSlice.set(ohlcv.subarray(i * baseCount * FLOATS_PER_CANDLE, (i + 1) * baseCount * FLOATS_PER_CANDLE));
                    
                    const smaSlice = new Float32Array(baseCount);
                    smaSlice.set(sma.subarray(i * baseCount, (i + 1) * baseCount));

                    const rsiSlice = new Float32Array(baseCount);
                    rsiSlice.set(rsi.subarray(i * baseCount, (i + 1) * baseCount));

                    chartStores[i] = {
                        ohlcv: ohlcvSlice,
                        sma: smaSlice,
                        rsi: rsiSlice,
                        count: baseCount,
                        isLoadingOlder: false,
                        hasMore: true,
                        totalAvailable: 90000
                    };
                }
                dirtyFlags.fill(1);
                scheduleRedraw();
            } else if (msg.data.type === 'DELTA') {
                if (!chartStores.length) return;
                const { deltas } = msg.data;
                for (let d = 0; d < deltas.length; d++) {
                    const delta = deltas[d];
                    const store = chartStores[delta.chartIdx];
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

                    dirtyFlags[delta.chartIdx] = 1;
                }
                scheduleRedraw();
            } else if (msg.data.type === 'OLDER_BARS_RESPONSE') {
                const { chartIdx, count, ohlcv: olderOhlcv, sma: olderSma, rsi: olderRsi, hasMore, totalAvailable } = msg.data;
                const store = chartStores[chartIdx];
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

                    dirtyFlags[chartIdx] = 1;
                    scheduleRedraw();

                    postMessage({
                        type: 'DRAG_STATUS',
                        chartIdx: chartIdx,
                        offset: Math.round(rightOffsets[chartIdx]),
                        maxOffset: newCount - VISIBLE_CANDLES,
                        visibleCandles: VISIBLE_CANDLES,
                        totalCandles: newCount,
                        totalAvailable: totalAvailable,
                        isDragging: (activeDrag && activeDrag.chartIdx === chartIdx),
                        justPaged: true
                    });
                }
            }
        };

        // Lightweight 1Hz Telemetry Reporter
        setInterval(() => {
            const avgDrawTime = renderCount > 0 ? (totalRenderDuration / renderCount).toFixed(2) : '0.00';
            postMessage({
                type: 'METRICS',
                fps: drawnFramesThisSec,
                renderTimeMs: avgDrawTime,
                onDemand: true,
                isDragging: activeDrag !== null
            });
            drawnFramesThisSec = 0;
            totalRenderDuration = 0;
            renderCount = 0;
        }, 1000);

    } else if (e.data.type === 'POINTER') {
        const { action, x, y, pointerId, chartIdx } = e.data;

        if (action === 'down') {
            if (chartIdx >= 0 && chartIdx < NUM_CHARTS) {
                activeDrag = {
                    pointerId,
                    chartIdx,
                    startX: x,
                    startOffset: rightOffsets[chartIdx]
                };
            }
        } else if (action === 'move') {
            if (activeDrag && activeDrag.pointerId === pointerId) {
                const idx = activeDrag.chartIdx;
                const store = chartStores[idx];
                if (!store) return;

                const deltaX = x - activeDrag.startX;
                const slotWidth = cellWidth / VISIBLE_CANDLES;
                const newOffset = activeDrag.startOffset + (deltaX / slotWidth);
                const maxOffset = store.count - VISIBLE_CANDLES;
                const clamped = Math.max(0, Math.min(maxOffset, newOffset));
                rightOffsets[idx] = clamped;

                dirtyFlags[idx] = 1;
                scheduleRedraw();

                // Threshold trigger (< 80 bars remaining)
                const endBar = store.count - Math.round(clamped);
                const startBar = endBar - VISIBLE_CANDLES;

                if (startBar < 150 && !store.isLoadingOlder && store.hasMore && dataPort) {
                    store.isLoadingOlder = true;
                    dataPort.postMessage({
                        type: 'FETCH_OLDER_BARS',
                        chartIdx: idx,
                        currentLoadedCount: store.count,
                        batchSize: 500
                    });
                }

                postMessage({
                    type: 'DRAG_STATUS',
                    chartIdx: idx,
                    offset: Math.round(clamped),
                    maxOffset: maxOffset,
                    visibleCandles: VISIBLE_CANDLES,
                    totalCandles: store.count,
                    totalAvailable: store.totalAvailable || 90000,
                    isDragging: true
                });
            }
        } else if (action === 'up' || action === 'cancel') {
            if (activeDrag && activeDrag.pointerId === pointerId) {
                const idx = activeDrag.chartIdx;
                const store = chartStores[idx];
                const clamped = rightOffsets[idx];
                const maxOffset = store ? store.count - VISIBLE_CANDLES : 0;
                activeDrag = null;
                postMessage({
                    type: 'DRAG_STATUS',
                    chartIdx: idx,
                    offset: Math.round(clamped),
                    maxOffset: maxOffset,
                    visibleCandles: VISIBLE_CANDLES,
                    totalCandles: store ? store.count : 1000,
                    totalAvailable: store ? store.totalAvailable : 90000,
                    isDragging: false
                });
            }
        }
    } else if (e.data.type === 'RESIZE') {
        cellWidth = e.data.width;
        cellHeight = e.data.height;
        apps.forEach(app => {
            if (app && app.renderer) app.renderer.resize(cellWidth, cellHeight);
        });
        dirtyFlags.fill(1);
        scheduleRedraw();
    } else if (e.data.type === 'RELEASE_MEMORY') {
        const chartIdx = e.data.chartIdx;
        if (chartIdx !== undefined && chartStores[chartIdx]) {
            releaseChartMemory(chartIdx);
        } else {
            for (let i = 0; i < NUM_CHARTS; i++) {
                releaseChartMemory(i);
            }
        }
    }
};

function releaseChartMemory(idx) {
    const store = chartStores[idx];
    if (!store || store.count <= 1000) return;
    const retainCount = 1000;
    const dropCount = store.count - retainCount;

    store.ohlcv = store.ohlcv.slice(dropCount * FLOATS_PER_CANDLE);
    store.sma = store.sma.slice(dropCount);
    store.rsi = store.rsi.slice(dropCount);
    store.count = retainCount;
    store.hasMore = true;
    store.isLoadingOlder = false;
    rightOffsets[idx] = 0;
    dirtyFlags[idx] = 1;
    scheduleRedraw();

    postMessage({
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

function renderSinglePixiChart(g, chartIndex, store) {
    if (!g) return;
    g.clear();

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

    // Cell boundary
    g.lineStyle(1, 0x2a2e39);
    g.drawRect(0, 0, cellWidth, cellHeight);

    const offset = Math.round(rightOffsets[chartIndex]);
    const endBar = Math.max(visibleCount, totalCandles - offset);
    const startBar = endBar - visibleCount;

    // PASS 1: Min/Max
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

    // PASS 2: Candles & Volume
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
        const color = isUp ? 0x26a69a : 0xef5350;

        // Volume Bar
        const maxVol = 60000;
        const volHeight = Math.min((volume / maxVol) * (mainHeight * 0.2), mainHeight * 0.2);
        g.lineStyle(0);
        g.beginFill(color, 0.22);
        g.drawRect(x, mainHeight - volHeight, bodyWidth, volHeight);
        g.endFill();

        // Wick
        g.lineStyle(1, color);
        g.moveTo(centerX, highY);
        g.lineTo(centerX, lowY);

        // Body
        g.lineStyle(0);
        g.beginFill(color);
        const bodyTop = Math.min(openY, closeY);
        const bodyHeight = Math.max(Math.abs(closeY - openY), 1);
        g.drawRect(x, bodyTop, bodyWidth, bodyHeight);
        g.endFill();
    }

    // PASS 3: SMA 20 Overlay
    g.lineStyle(1.5, 0xffb300);
    let smaStarted = false;
    for (let j = 0; j < VISIBLE_CANDLES; j++) {
        const barIndex = startBar + j;
        const smaVal = smaBuffer[barIndex];
        if (!Number.isNaN(smaVal)) {
            const x = (j * slotWidth) + (bodyWidth / 2);
            const y = toY(smaVal);
            if (!smaStarted) {
                g.moveTo(x, y);
                smaStarted = true;
            } else {
                g.lineTo(x, y);
            }
        }
    }

    // PASS 4: RSI 14 Panel
    g.lineStyle(1, 0x333b47);
    g.moveTo(0, mainHeight);
    g.lineTo(cellWidth, mainHeight);

    const toRsiY = (val) => mainHeight + (1 - (val / 100)) * rsiHeight;
    g.lineStyle(1, 0x374151);
    g.moveTo(0, toRsiY(70));
    g.lineTo(cellWidth, toRsiY(70));
    g.moveTo(0, toRsiY(30));
    g.lineTo(cellWidth, toRsiY(30));

    g.lineStyle(1.5, 0xba68c8);
    let rsiStarted = false;
    for (let j = 0; j < VISIBLE_CANDLES; j++) {
        const barIndex = startBar + j;
        const rsiVal = rsiBuffer[barIndex];
        if (!Number.isNaN(rsiVal)) {
            const x = (j * slotWidth) + (bodyWidth / 2);
            const y = toRsiY(rsiVal);
            if (!rsiStarted) {
                g.moveTo(x, y);
                rsiStarted = true;
            } else {
                g.lineTo(x, y);
            }
        }
    }
}
