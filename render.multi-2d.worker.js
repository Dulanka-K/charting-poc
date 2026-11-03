// render.multi-2d.worker.js - 16 Separate Canvases using Native Canvas2D (TradingView Architecture)

let canvases = [];
let contexts = [];
let NUM_CHARTS = 16;
let cellWidth = 0;
let cellHeight = 0;
let dataPort = null;

const VISIBLE_CANDLES = 500;
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
                const baseCount = candlesPerChart || 1000;
                chartStores = [];
                const RATIOS = [1, 1, 1, 1, 5, 5, 5, 5, 15, 15, 15, 15, 60, 60, 60, 60];

                for (let i = 0; i < NUM_CHARTS; i++) {
                    const ohlcvSlice = new Float32Array(baseCount * FLOATS_PER_CANDLE);
                    ohlcvSlice.set(ohlcv.subarray(i * baseCount * FLOATS_PER_CANDLE, (i + 1) * baseCount * FLOATS_PER_CANDLE));
                    
                    const smaSlice = new Float32Array(baseCount);
                    smaSlice.set(sma.subarray(i * baseCount, (i + 1) * baseCount));

                    const rsiSlice = new Float32Array(baseCount);
                    rsiSlice.set(rsi.subarray(i * baseCount, (i + 1) * baseCount));

                    const spareOhlcv = new Float32Array(baseCount * FLOATS_PER_CANDLE);
                    const spareSma = new Float32Array(baseCount);
                    const spareRsi = new Float32Array(baseCount);

                    const ratio = RATIOS[i] || 1;
                    const totalAvail = Math.floor(90000 / ratio);

                    chartStores[i] = {
                        ohlcv: ohlcvSlice,
                        sma: smaSlice,
                        rsi: rsiSlice,
                        spareOhlcv,
                        spareSma,
                        spareRsi,
                        sliceStart: totalAvail - baseCount,
                        sliceEnd: totalAvail,
                        count: baseCount,
                        totalAvailable: totalAvail,
                        isFetchingSlice: false
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

                    if (delta.isNewBar) {
                        store.totalAvailable++;
                        if (store.sliceEnd >= store.totalAvailable - 1) {
                            store.ohlcv.copyWithin(0, FLOATS_PER_CANDLE, store.count * FLOATS_PER_CANDLE);
                            store.sma.copyWithin(0, 1, store.count);
                            store.rsi.copyWithin(0, 1, store.count);
                            store.sliceStart++;
                            store.sliceEnd++;
                        }
                    }

                    if (store.sliceEnd >= store.totalAvailable) {
                        const baseOffset = (store.count - 1) * FLOATS_PER_CANDLE;
                        store.ohlcv.set(delta.candle, baseOffset);
                        store.sma[store.count - 1] = delta.sma;
                        store.rsi[store.count - 1] = delta.rsi;
                        dirtyFlags[delta.chartIdx] = 1;
                    }
                }
                scheduleRedraw();
            } else if (msg.data.type === 'WINDOW_SLICE_RESPONSE') {
                const { chartIdx, sliceStart, sliceEnd, count, totalAvailable, ohlcv: newOhlcv, sma: newSma, rsi: newRsi } = msg.data;
                const store = chartStores[chartIdx];
                if (!store) return;

                store.spareOhlcv = store.ohlcv;
                store.spareSma = store.sma;
                store.spareRsi = store.rsi;

                store.ohlcv = newOhlcv;
                store.sma = newSma;
                store.rsi = newRsi;
                store.sliceStart = sliceStart;
                store.sliceEnd = sliceEnd;
                store.count = count;
                store.totalAvailable = totalAvailable;
                store.isFetchingSlice = false;

                dirtyFlags[chartIdx] = 1;
                scheduleRedraw();

                postMessage({
                    type: 'DRAG_STATUS',
                    chartIdx: chartIdx,
                    offset: Math.round(rightOffsets[chartIdx]),
                    maxOffset: totalAvailable - VISIBLE_CANDLES,
                    visibleCandles: VISIBLE_CANDLES,
                    totalCandles: count,
                    totalAvailable: totalAvailable,
                    isDragging: (activeDrag && activeDrag.chartIdx === chartIdx)
                });
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
                const maxOffset = (store.totalAvailable || 1000) - VISIBLE_CANDLES;
                const clamped = Math.max(0, Math.min(maxOffset, Number.isFinite(newOffset) ? newOffset : 0));
                rightOffsets[idx] = clamped;

                dirtyFlags[idx] = 1;
                scheduleRedraw();

                // Ping-Pong Window Slice check:
                const globalEnd = Math.max(VISIBLE_CANDLES, store.totalAvailable - Math.round(clamped));
                const globalStart = globalEnd - VISIBLE_CANDLES;
                const localStart = globalStart - (store.sliceStart || 0);
                const localEnd = globalEnd - (store.sliceStart || 0);

                const needsOlder = localStart < 120 && store.sliceStart > 0;
                const needsNewer = localEnd > store.count - 120 && store.sliceEnd < store.totalAvailable;

                if ((needsOlder || needsNewer) && !store.isFetchingSlice && store.spareOhlcv && dataPort) {
                    store.isFetchingSlice = true;
                    const spareO = store.spareOhlcv;
                    const spareS = store.spareSma;
                    const spareR = store.spareRsi;
                    store.spareOhlcv = null;
                    store.spareSma = null;
                    store.spareRsi = null;

                    dataPort.postMessage({
                        type: 'GET_WINDOW_SLICE',
                        chartIdx: idx,
                        targetRightOffset: Math.round(clamped),
                        windowSize: 1000,
                        recycledOhlcv: spareO.buffer,
                        recycledSma: spareS.buffer,
                        recycledRsi: spareR.buffer
                    }, [spareO.buffer, spareS.buffer, spareR.buffer]);
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
                const maxOffset = store ? store.totalAvailable - VISIBLE_CANDLES : 0;
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
        canvases.forEach(c => {
            c.width = cellWidth;
            c.height = cellHeight;
        });
        dirtyFlags.fill(1);
        scheduleRedraw();
    } else if (e.data.type === 'RESET_TO_LIVE' || e.data.type === 'RELEASE_MEMORY') {
        const idx = e.data.chartIdx;
        const store = chartStores[idx];
        if (!store) return;
        rightOffsets[idx] = 0;
        dirtyFlags[idx] = 1;

        if (store.sliceEnd < store.totalAvailable && !store.isFetchingSlice && store.spareOhlcv && dataPort) {
            store.isFetchingSlice = true;
            const spareO = store.spareOhlcv;
            const spareS = store.spareSma;
            const spareR = store.spareRsi;
            store.spareOhlcv = null;
            store.spareSma = null;
            store.spareRsi = null;

            dataPort.postMessage({
                type: 'GET_WINDOW_SLICE',
                chartIdx: idx,
                targetRightOffset: 0,
                windowSize: 1000,
                recycledOhlcv: spareO.buffer,
                recycledSma: spareS.buffer,
                recycledRsi: spareR.buffer
            }, [spareO.buffer, spareS.buffer, spareR.buffer]);
        }
        scheduleRedraw();

        postMessage({
            type: 'DRAG_STATUS',
            chartIdx: idx,
            offset: 0,
            maxOffset: store.totalAvailable - VISIBLE_CANDLES,
            visibleCandles: VISIBLE_CANDLES,
            totalCandles: store.count,
            totalAvailable: store.totalAvailable,
            isDragging: false
        });
    }
};

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

    const totalAvail = store.totalAvailable || totalCandles;
    const offset = Math.round(Number.isFinite(rightOffsets[chartIndex]) ? rightOffsets[chartIndex] : 0);
    const globalEnd = Math.max(visibleCount, totalAvail - offset);
    const globalStart = globalEnd - visibleCount;

    let localStart = globalStart - (store.sliceStart || 0);
    localStart = Math.max(0, Math.min(totalCandles - visibleCount, localStart));
    const startBar = Math.floor(Number.isFinite(localStart) ? localStart : 0);
    const endBar = startBar + visibleCount;

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
