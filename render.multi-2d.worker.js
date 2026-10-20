// render.multi-2d.worker.js - 16 Separate Canvases using Native Canvas2D (TradingView Architecture)

let canvases = [];
let contexts = [];
let NUM_CHARTS = 16;
let cellWidth = 0;
let cellHeight = 0;
let dataPort = null;

const VISIBLE_CANDLES = 150;
const FLOATS_PER_CANDLE = 30;

let rightOffsets = new Float32Array(16).fill(0);
let activeDrag = null; // { pointerId, chartIdx, startX, startOffset }
let chartStores = []; // Array of { ohlcv, sma, rsi, count, isLoadingOlder, hasMore, totalAvailable }

// Selective Invalidation / Dirty Flags (1 = dirty/needs repaint, 0 = clean)
let dirtyFlags = new Uint8Array(16).fill(1);
let isAnyDirty = true;
let rafId = null;

// Telemetry counters
let lastRenderTime = 0;
let totalRenderDuration = 0;
let renderCount = 0;
let drawnFramesThisSec = 0;

// ON-DEMAND RENDER SCHEDULER ("Wake-on-Dirty")
// Schedules a single requestAnimationFrame ONLY when at least one chart is marked dirty.
// When idle (no ticks, no mouse drag), 0 frames are scheduled -> 0% background CPU wakeup!
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

    for (let i = 0; i < NUM_CHARTS; i++) {
        if (dirtyFlags[i] && chartStores[i]) {
            renderSingleChart2D(contexts[i], i, chartStores[i]);
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
    // Notice: NO recursive requestAnimationFrame(renderDirtyFrame)!
    // The Render Worker sleeps completely until the next scheduleRedraw() event.
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

        // Initialize 16 Native Canvas2D Contexts!
        contexts = canvases.map(c => c.getContext('2d'));

        dataPort.onmessage = (msg) => {
            if (msg.data.type === 'SNAPSHOT') {
                const { ohlcv, sma, rsi, candlesPerChart, floatsPerCandle } = msg.data;
                const baseCount = candlesPerChart || 500;
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
                        totalAvailable: 30000
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

                    // If bar rolled, shift this chart's memory left by 1 candle (30 floats)
                    if (delta.isNewBar) {
                        store.ohlcv.copyWithin(0, FLOATS_PER_CANDLE, count * FLOATS_PER_CANDLE);
                        store.sma.copyWithin(0, 1, count);
                        store.rsi.copyWithin(0, 1, count);
                    }

                    // Mutate live bar directly in place! (Zero reallocations, 120 bytes)
                    const baseOffset = (count - 1) * FLOATS_PER_CANDLE;
                    store.ohlcv.set(delta.candle, baseOffset);
                    store.sma[count - 1] = delta.sma;
                    store.rsi[count - 1] = delta.rsi;

                    // Selective redraw: mark only this chart dirty!
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

                    // Prepend older bars before existing bars
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

                    // Note: rightOffsets[chartIdx] is anchored from the right (newest bar),
                    // so visible bars remain completely static with zero visual jump!
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

        // Lightweight 1Hz Telemetry Reporter (Only wakes 1x/sec for HUD stats, not 60x/sec!)
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

                // SELECTIVE ON-DEMAND DRAG REDRAW: Only the dragged chart is marked dirty and schedules 1 VSync frame!
                dirtyFlags[idx] = 1;
                scheduleRedraw();

                // Threshold trigger: user approaching the oldest loaded bars (< 80 bars remaining)
                const endBar = store.count - Math.round(clamped);
                const startBar = endBar - VISIBLE_CANDLES;

                if (startBar < 80 && !store.isLoadingOlder && store.hasMore && dataPort) {
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
                    totalAvailable: store.totalAvailable || 30000,
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
                    totalCandles: store ? store.count : 500,
                    totalAvailable: store ? store.totalAvailable : 30000,
                    isDragging: false
                });
            }
        }
    } else if (e.data.type === 'RESIZE') {
        cellWidth = e.data.width;
        cellHeight = e.data.height;
        canvases.forEach(c => {
            c.width = cellWidth;
            c.height = cellHeight;
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
    if (!store || store.count <= 500) return;
    const retainCount = 500;
    const dropCount = store.count - retainCount;

    // Release older historical bars back to 500 baseline
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

function renderSingleChart2D(ctx, chartIndex, store) {
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

    // 1. Clear background
    ctx.fillStyle = '#121212';
    ctx.fillRect(0, 0, cellWidth, cellHeight);

    // 2. Cell boundary
    ctx.strokeStyle = '#2a2e39';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, cellWidth, cellHeight);

    const offset = Math.round(rightOffsets[chartIndex]);
    const endBar = Math.max(visibleCount, totalCandles - offset);
    const startBar = endBar - visibleCount;

    // --- PASS 1: Calculate Visible Min / Max Prices ---
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

    // --- PASS 2: Render Candles & Volume Bars ---
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

        // 1. Draw Volume Bar
        const maxVol = 60000;
        const volHeight = Math.min((volume / maxVol) * (mainHeight * 0.2), mainHeight * 0.2);
        ctx.fillStyle = isUp ? 'rgba(38, 166, 154, 0.22)' : 'rgba(239, 83, 80, 0.22)';
        ctx.fillRect(x, mainHeight - volHeight, bodyWidth, volHeight);

        // 2. Draw Wick
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(centerX, highY);
        ctx.lineTo(centerX, lowY);
        ctx.stroke();

        // 3. Draw Candle Body
        ctx.fillStyle = color;
        const bodyTop = Math.min(openY, closeY);
        const bodyHeight = Math.max(Math.abs(closeY - openY), 1);
        ctx.fillRect(x, bodyTop, bodyWidth, bodyHeight);
    }

    // --- PASS 3: Render Indicator 1 (SMA 20 Overlay) ---
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

    // --- PASS 4: Render Sub-Panel & Indicator 2 (RSI 14 Oscillator) ---
    // Divider
    ctx.strokeStyle = '#333b47';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mainHeight);
    ctx.lineTo(cellWidth, mainHeight);
    ctx.stroke();

    // RSI 70 / 30 reference lines
    const toRsiY = (val) => mainHeight + (1 - (val / 100)) * rsiHeight;
    ctx.strokeStyle = '#374151';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, toRsiY(70));
    ctx.lineTo(cellWidth, toRsiY(70));
    ctx.moveTo(0, toRsiY(30));
    ctx.lineTo(cellWidth, toRsiY(30));
    ctx.stroke();

    // RSI Polyline
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
