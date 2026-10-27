// data.worker.js - Math, Data Store, and Multi-Timeframe Aggregation Engine

let renderPort;
let NUM_CHARTS = 16;
const CANDLES_PER_CHART = 1000; // Each chart stores 1,000 aggregated bars (500 visible + 500 drag buffer)
const FLOATS_PER_CANDLE = 30;

// Field index offsets for flat strided buffer
const FIELD = {
    TIME: 0,
    OPEN: 1,
    HIGH: 2,
    LOW: 3,
    CLOSE: 4,
    VOLUME: 5,
    TURNOVER: 6,
    TRADES: 7,
    VWAP: 8,
    BID: 9,
    ASK: 10,
    BID_VOL: 11,
    ASK_VOL: 12,
    EXTRA_START: 13
};

// 4 Underlying Symbols mapped across 4 Timeframes
const SYMBOLS = ['AAPL', 'TSLA', 'NVDA', 'MSFT'];
const RAW_BARS_PER_SYMBOL = 90000; // 90,000 raw 1-minute bars in raw base store (supports 1,500+ 1h bars)

// Chart Configurations:
// Row 0: AAPL, TSLA, NVDA, MSFT on 1m (ratio 1)
// Row 1: AAPL, TSLA, NVDA, MSFT on 5m (ratio 5)
// Row 2: AAPL, TSLA, NVDA, MSFT on 15m (ratio 15)
// Row 3: AAPL, TSLA, NVDA, MSFT on 1h (ratio 60)
const CHART_CONFIGS = [
    { symbolIdx: 0, symbol: 'AAPL', interval: '1m', ratio: 1 },
    { symbolIdx: 1, symbol: 'TSLA', interval: '1m', ratio: 1 },
    { symbolIdx: 2, symbol: 'NVDA', interval: '1m', ratio: 1 },
    { symbolIdx: 3, symbol: 'MSFT', interval: '1m', ratio: 1 },

    { symbolIdx: 0, symbol: 'AAPL', interval: '5m', ratio: 5 },
    { symbolIdx: 1, symbol: 'TSLA', interval: '5m', ratio: 5 },
    { symbolIdx: 2, symbol: 'NVDA', interval: '5m', ratio: 5 },
    { symbolIdx: 3, symbol: 'MSFT', interval: '5m', ratio: 5 },

    { symbolIdx: 0, symbol: 'AAPL', interval: '15m', ratio: 15 },
    { symbolIdx: 1, symbol: 'TSLA', interval: '15m', ratio: 15 },
    { symbolIdx: 2, symbol: 'NVDA', interval: '15m', ratio: 15 },
    { symbolIdx: 3, symbol: 'MSFT', interval: '15m', ratio: 15 },

    { symbolIdx: 0, symbol: 'AAPL', interval: '1h', ratio: 60 },
    { symbolIdx: 1, symbol: 'TSLA', interval: '1h', ratio: 60 },
    { symbolIdx: 2, symbol: 'NVDA', interval: '1h', ratio: 60 },
    { symbolIdx: 3, symbol: 'MSFT', interval: '1h', ratio: 60 },
];

// Raw 1-Minute Ingestion Stores (Stored ONCE per symbol, shared across timeframes!)
let rawSymbolStores = [];

// Aggregated Master Store for the 16 Visual Charts
let aggregatedDataStore;

onmessage = (e) => {
    if (e.data.type === 'INIT') {
        renderPort = e.data.port;
        NUM_CHARTS = e.data.numCharts;
        
        renderPort.onmessage = (msg) => {
            if (msg.data.type === 'FETCH_OLDER_BARS') {
                handleFetchOlderBars(msg.data);
            }
        };

        initData();
        sendInitialSnapshot();
        startDataStream();
        postMessage({
            type: 'DATA_INFO',
            rawBarsPerSymbol: RAW_BARS_PER_SYMBOL,
            candlesPerChart: CANDLES_PER_CHART,
            numCharts: NUM_CHARTS,
            symbolsCount: SYMBOLS.length
        });
    }
};

function sendInitialSnapshot() {
    console.log('[Data Worker] Sending INITIAL SNAPSHOT to Render Worker (one-time full transfer)...');
    const ohlcvSize = NUM_CHARTS * CANDLES_PER_CHART * FLOATS_PER_CANDLE;
    const indicatorSize = NUM_CHARTS * CANDLES_PER_CHART;

    const ohlcvSnapshot = new Float32Array(ohlcvSize);
    const smaSnapshot = new Float32Array(indicatorSize);
    const rsiSnapshot = new Float32Array(indicatorSize);

    // Initial master store copy
    ohlcvSnapshot.set(aggregatedDataStore);

    // Initial 500-bar indicator calculations
    for (let i = 0; i < NUM_CHARTS; i++) {
        const sma = calculateSMA(aggregatedDataStore, i, CANDLES_PER_CHART, 20);
        const rsi = calculateRSI(aggregatedDataStore, i, CANDLES_PER_CHART, 14);
        smaSnapshot.set(sma, i * CANDLES_PER_CHART);
        rsiSnapshot.set(rsi, i * CANDLES_PER_CHART);
    }

    renderPort.postMessage({
        type: 'SNAPSHOT',
        ohlcv: ohlcvSnapshot,
        sma: smaSnapshot,
        rsi: rsiSnapshot,
        numCharts: NUM_CHARTS,
        candlesPerChart: CANDLES_PER_CHART,
        floatsPerCandle: FLOATS_PER_CANDLE
    }, [ohlcvSnapshot.buffer, smaSnapshot.buffer, rsiSnapshot.buffer]);
}

function initData() {
    console.log('[Data Worker] Ingesting raw 1m base feeds for 4 symbols (30,000 raw bars each)...');

    // 1. Generate Raw 1-Minute Base Feeds for each symbol
    rawSymbolStores = [];
    for (let s = 0; s < SYMBOLS.length; s++) {
        const rawStore = new Float32Array(RAW_BARS_PER_SYMBOL * FLOATS_PER_CANDLE);
        const baseTier = 100 + (s * 45); // Different base prices for AAPL (100), TSLA (145), NVDA (190), MSFT (235)
        let price = baseTier;

        for (let j = 0; j < RAW_BARS_PER_SYMBOL; j++) {
            const open = price;
            // Realistic change per 1m candle (+/- 0.30) with weak mean reversion to keep symbol tier distinct
            const change = (Math.random() - 0.5) * 0.32 + (baseTier - price) * 0.001;
            const close = open + change;
            const high = Math.max(open, close) + Math.random() * 0.22;
            const low = Math.min(open, close) - Math.random() * 0.22;
            const volume = Math.floor(1000 + Math.random() * 2000);

            const offset = j * FLOATS_PER_CANDLE;
            rawStore[offset + FIELD.TIME] = j;
            rawStore[offset + FIELD.OPEN] = open;
            rawStore[offset + FIELD.HIGH] = high;
            rawStore[offset + FIELD.LOW] = low;
            rawStore[offset + FIELD.CLOSE] = close;
            rawStore[offset + FIELD.VOLUME] = volume;
            rawStore[offset + FIELD.TURNOVER] = open * volume;
            rawStore[offset + FIELD.TRADES] = Math.floor(10 + Math.random() * 30);
            rawStore[offset + FIELD.VWAP] = (open + close + high + low) / 4;
            rawStore[offset + FIELD.BID] = close - 0.05;
            rawStore[offset + FIELD.ASK] = close + 0.05;
            rawStore[offset + FIELD.BID_VOL] = 500;
            rawStore[offset + FIELD.ASK_VOL] = 500;

            price = close; // Continuous price action
        }
        rawSymbolStores.push(rawStore);
    }

    // 2. Pre-allocate the Aggregated Visual Store (16 Charts x 500 Bars x 30 Floats)
    const totalAggregatedSize = NUM_CHARTS * CANDLES_PER_CHART * FLOATS_PER_CANDLE;
    aggregatedDataStore = new Float32Array(totalAggregatedSize);

    // 3. Perform Initial Aggregation for all 16 charts
    for (let i = 0; i < NUM_CHARTS; i++) {
        const cfg = CHART_CONFIGS[i];
        const rawBuffer = rawSymbolStores[cfg.symbolIdx];
        aggregateSymbolBars(rawBuffer, cfg.ratio, i, CANDLES_PER_CHART);
    }

    console.log('[Data Worker] Aggregated 16 multi-timeframe chart series successfully.');
}

// Aggregation Engine: Rolls 'ratio' raw 1m bars into 1 aggregated bar
function aggregateSymbolBars(rawBuffer, ratio, chartIdx, count = CANDLES_PER_CHART) {
    const rawTotal = RAW_BARS_PER_SYMBOL;
    const chartBase = chartIdx * count * FLOATS_PER_CANDLE;

    for (let k = 0; k < count; k++) {
        const rawStart = rawTotal - ((count - k) * ratio);
        const rawEnd = rawStart + ratio;

        let high = -Infinity;
        let low = Infinity;
        let volume = 0;
        let turnover = 0;
        let trades = 0;

        const open = rawBuffer[rawStart * FLOATS_PER_CANDLE + FIELD.OPEN];
        const close = rawBuffer[(rawEnd - 1) * FLOATS_PER_CANDLE + FIELD.CLOSE];

        for (let r = rawStart; r < rawEnd; r++) {
            const barOffset = r * FLOATS_PER_CANDLE;
            const h = rawBuffer[barOffset + FIELD.HIGH];
            const l = rawBuffer[barOffset + FIELD.LOW];
            if (h > high) high = h;
            if (l < low) low = l;
            volume += rawBuffer[barOffset + FIELD.VOLUME];
            turnover += rawBuffer[barOffset + FIELD.TURNOVER];
            trades += rawBuffer[barOffset + FIELD.TRADES];
        }

        const targetOffset = chartBase + (k * FLOATS_PER_CANDLE);
        aggregatedDataStore[targetOffset + FIELD.TIME] = k;
        aggregatedDataStore[targetOffset + FIELD.OPEN] = open;
        aggregatedDataStore[targetOffset + FIELD.HIGH] = high;
        aggregatedDataStore[targetOffset + FIELD.LOW] = low;
        aggregatedDataStore[targetOffset + FIELD.CLOSE] = close;
        aggregatedDataStore[targetOffset + FIELD.VOLUME] = volume;
        aggregatedDataStore[targetOffset + FIELD.TURNOVER] = turnover;
        aggregatedDataStore[targetOffset + FIELD.TRADES] = trades;
        aggregatedDataStore[targetOffset + FIELD.VWAP] = turnover / (volume || 1);
        aggregatedDataStore[targetOffset + FIELD.BID] = close - 0.05;
        aggregatedDataStore[targetOffset + FIELD.ASK] = close + 0.05;
        aggregatedDataStore[targetOffset + FIELD.BID_VOL] = 1000;
        aggregatedDataStore[targetOffset + FIELD.ASK_VOL] = 1200;
    }
}

function startDataStream() {
    let tickCount = 0;
    let totalMathDuration = 0;
    const symbolTickCounts = new Uint32Array(SYMBOLS.length);
    const symbolRawBarCounts = new Uint32Array(SYMBOLS.length);

    // Randomly update raw data for a symbol every 100ms (1/10 second)
    // Add a new bar every 10 second
    // Update the latest bar (new bar/ existing bar)
    // Update the aggregated data only for charts of updated symbol
    // Extract the updated aggregated candle of all relevant charts of updated symbol (maintain deltas array with object list)
    // Send the updated candle along with its indicator values (deltas array) to renderer
    setInterval(() => {
        const t0 = performance.now();
        
        // 1. Pick an active symbol for this live tick
        const activeSymbolIdx = Math.floor(Math.random() * SYMBOLS.length);
        const rawStore = rawSymbolStores[activeSymbolIdx];
        const lastRawOffset = (RAW_BARS_PER_SYMBOL - 1) * FLOATS_PER_CANDLE;
        symbolTickCounts[activeSymbolIdx]++;

        // Simulate a new RAW 1m bar roll every 100 ticks (~10 seconds)
        const isNewRawBar = (symbolTickCounts[activeSymbolIdx] >= 100);
        if (isNewRawBar) {
            symbolTickCounts[activeSymbolIdx] = 0;
            symbolRawBarCounts[activeSymbolIdx]++;
            const prevClose = rawStore[lastRawOffset + FIELD.CLOSE];
            rawStore.copyWithin(0, FLOATS_PER_CANDLE, RAW_BARS_PER_SYMBOL * FLOATS_PER_CANDLE);
            rawStore[lastRawOffset + FIELD.TIME] = rawStore[lastRawOffset - FLOATS_PER_CANDLE + FIELD.TIME] + 1;
            rawStore[lastRawOffset + FIELD.OPEN] = prevClose;
            rawStore[lastRawOffset + FIELD.HIGH] = prevClose;
            rawStore[lastRawOffset + FIELD.LOW] = prevClose;
            rawStore[lastRawOffset + FIELD.CLOSE] = prevClose;
            rawStore[lastRawOffset + FIELD.VOLUME] = 10;
            rawStore[lastRawOffset + FIELD.TURNOVER] = prevClose * 10;
            rawStore[lastRawOffset + FIELD.TRADES] = 1;
            rawStore[lastRawOffset + FIELD.VWAP] = prevClose;
            rawStore[lastRawOffset + FIELD.BID] = prevClose - 0.05;
            rawStore[lastRawOffset + FIELD.ASK] = prevClose + 0.05;
        }

        const openPrice = rawStore[lastRawOffset + FIELD.OPEN];
        const curClose = rawStore[lastRawOffset + FIELD.CLOSE];

        // Micro-tick: realistic fluctuation in cents (+/- $0.02 - $0.04)
        const meanReversion = (openPrice - curClose) * 0.12;
        const tickNoise = (Math.random() - 0.5) * 0.04;
        let newClose = curClose + meanReversion + tickNoise;

        // Keep within realistic single-candle limits (+/- 0.35 of open)
        const maxRange = 0.35;
        newClose = Math.max(openPrice - maxRange, Math.min(openPrice + maxRange, newClose));

        rawStore[lastRawOffset + FIELD.CLOSE] = newClose;
        if (newClose > rawStore[lastRawOffset + FIELD.HIGH]) {
            rawStore[lastRawOffset + FIELD.HIGH] = newClose;
        }
        if (newClose < rawStore[lastRawOffset + FIELD.LOW]) {
            rawStore[lastRawOffset + FIELD.LOW] = newClose;
        }
        const tickVol = Math.floor(Math.random() * 20) + 1;
        rawStore[lastRawOffset + FIELD.VOLUME] += tickVol;
        rawStore[lastRawOffset + FIELD.TRADES] += 1;

        // 2. Package lightweight DELTA for ONLY the charts of this symbol!
        const deltas = [];
        const transferList = [];

        for (let i = 0; i < NUM_CHARTS; i++) {
            if (CHART_CONFIGS[i].symbolIdx === activeSymbolIdx) {
                const ratio = CHART_CONFIGS[i].ratio; // 1 (1m), 5 (5m), 15 (15m), 60 (1h)
                const chartBase = i * CANDLES_PER_CHART * FLOATS_PER_CANDLE;
                const lastBarOffset = chartBase + ((CANDLES_PER_CHART - 1) * FLOATS_PER_CANDLE);

                // An aggregate bar rolls ONLY when raw rolls AND this chart's interval ratio completes!
                const isNewAggBar = isNewRawBar && (symbolRawBarCounts[activeSymbolIdx] % ratio === 0);

                if (isNewAggBar) {
                    // Shift aggregated master store left by 1 candle (FIFO roll)
                    const chartEnd = (i + 1) * CANDLES_PER_CHART * FLOATS_PER_CANDLE;
                    aggregatedDataStore.copyWithin(chartBase, chartBase + FLOATS_PER_CANDLE, chartEnd);
                    
                    const prevClose = aggregatedDataStore[lastBarOffset - FLOATS_PER_CANDLE + FIELD.CLOSE];
                    aggregatedDataStore[lastBarOffset + FIELD.TIME] = aggregatedDataStore[lastBarOffset - FLOATS_PER_CANDLE + FIELD.TIME] + 1;
                    aggregatedDataStore[lastBarOffset + FIELD.OPEN] = prevClose;
                    aggregatedDataStore[lastBarOffset + FIELD.HIGH] = Math.max(prevClose, newClose);
                    aggregatedDataStore[lastBarOffset + FIELD.LOW] = Math.min(prevClose, newClose);
                    aggregatedDataStore[lastBarOffset + FIELD.CLOSE] = newClose;
                    aggregatedDataStore[lastBarOffset + FIELD.VOLUME] = tickVol;
                    aggregatedDataStore[lastBarOffset + FIELD.TRADES] = 1;
                } else {
                    // Ongoing candle: accumulate high, low, close, volume into the current live bar
                    aggregatedDataStore[lastBarOffset + FIELD.CLOSE] = newClose;
                    if (newClose > aggregatedDataStore[lastBarOffset + FIELD.HIGH]) {
                        aggregatedDataStore[lastBarOffset + FIELD.HIGH] = newClose;
                    }
                    if (newClose < aggregatedDataStore[lastBarOffset + FIELD.LOW]) {
                        aggregatedDataStore[lastBarOffset + FIELD.LOW] = newClose;
                    }
                    aggregatedDataStore[lastBarOffset + FIELD.VOLUME] += tickVol;
                    aggregatedDataStore[lastBarOffset + FIELD.TRADES] += 1;
                }

                // Extract ONLY this 1 candle (30 floats = 120 bytes)
                const candleSlice = new Float32Array(FLOATS_PER_CANDLE);
                candleSlice.set(aggregatedDataStore.subarray(lastBarOffset, lastBarOffset + FLOATS_PER_CANDLE));

                // Incremental Indicators (O(1) calculation for just the latest bar)
                const smaVal = calculateLatestSMA(aggregatedDataStore, i, CANDLES_PER_CHART, 20);
                const rsiVal = calculateLatestRSI(aggregatedDataStore, i, CANDLES_PER_CHART, 14);

                deltas.push({
                    chartIdx: i,
                    barIndex: CANDLES_PER_CHART - 1,
                    isNewBar: isNewAggBar, // Scoped strictly to THIS chart's aggregate timeframe!
                    candle: candleSlice,
                    sma: smaVal,
                    rsi: rsiVal
                });
                transferList.push(candleSlice.buffer);
            }
        }

        // 3. Send lightweight DELTA to Render Worker (~480 bytes total!)
        renderPort.postMessage({
            type: 'DELTA',
            deltas: deltas
        }, transferList);

        const mathDuration = performance.now() - t0;
        totalMathDuration += mathDuration;
        tickCount++;

        if (tickCount >= 10) {
            postMessage({
                type: 'DATA_METRICS',
                mathTimeMs: (totalMathDuration / tickCount).toFixed(2),
                bytesTransferred: deltas.length * FLOATS_PER_CANDLE * 4
            });
            tickCount = 0;
            totalMathDuration = 0;
        }
        
    }, 100);
}

// Incremental O(1) SMA for latest bar
function calculateLatestSMA(store, chartIndex, count = CANDLES_PER_CHART, period = 20) {
    const chartBase = chartIndex * count * FLOATS_PER_CANDLE;
    let sum = 0;
    for (let k = count - period; k < count; k++) {
        sum += store[chartBase + (k * FLOATS_PER_CANDLE) + FIELD.CLOSE];
    }
    return sum / period;
}

// Incremental O(1) RSI for latest bar
function calculateLatestRSI(store, chartIndex, count = CANDLES_PER_CHART, period = 14) {
    const chartBase = chartIndex * count * FLOATS_PER_CANDLE;
    let gains = 0, losses = 0;
    for (let k = count - period; k < count; k++) {
        const prev = store[chartBase + ((k - 1) * FLOATS_PER_CANDLE) + FIELD.CLOSE];
        const cur = store[chartBase + (k * FLOATS_PER_CANDLE) + FIELD.CLOSE];
        const diff = cur - prev;
        if (diff > 0) gains += diff;
        else losses -= diff;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

// Indicator 1: Simple Moving Average (SMA) calculated directly from aggregated flat memory
function calculateSMA(store, chartIndex, count = CANDLES_PER_CHART, period = 20) {
    const sma = new Float32Array(count);
    const chartBase = chartIndex * count * FLOATS_PER_CANDLE;
    let sum = 0;

    for (let i = 0; i < count; i++) {
        const close = store[chartBase + (i * FLOATS_PER_CANDLE) + FIELD.CLOSE];
        sum += close;
        if (i >= period) {
            const oldestClose = store[chartBase + ((i - period) * FLOATS_PER_CANDLE) + FIELD.CLOSE];
            sum -= oldestClose;
            sma[i] = sum / period;
        } else if (i === period - 1) {
            sma[i] = sum / period;
        } else {
            sma[i] = NaN;
        }
    }
    return sma;
}

// Indicator 2: Relative Strength Index (RSI) calculated directly from aggregated flat memory
function calculateRSI(store, chartIndex, count = CANDLES_PER_CHART, period = 14) {
    const rsi = new Float32Array(count);
    const chartBase = chartIndex * count * FLOATS_PER_CANDLE;
    let gains = 0;
    let losses = 0;

    for (let i = 0; i < count; i++) {
        if (i === 0) {
            rsi[i] = NaN;
            continue;
        }
        const prevClose = store[chartBase + ((i - 1) * FLOATS_PER_CANDLE) + FIELD.CLOSE];
        const curClose = store[chartBase + (i * FLOATS_PER_CANDLE) + FIELD.CLOSE];
        const diff = curClose - prevClose;
        const gain = diff > 0 ? diff : 0;
        const loss = diff < 0 ? -diff : 0;

        if (i <= period) {
            gains += gain;
            losses += loss;
            if (i === period) {
                const avgGain = gains / period;
                const avgLoss = losses / period;
                const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
                rsi[i] = 100 - (100 / (1 + rs));
            } else {
                rsi[i] = NaN;
            }
        } else {
            const prevAvgGain = gains / period;
            const prevAvgLoss = losses / period;
            const avgGain = (prevAvgGain * (period - 1) + gain) / period;
            const avgLoss = (prevAvgLoss * (period - 1) + loss) / period;
            gains = avgGain * period;
            losses = avgLoss * period;
            const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
            rsi[i] = 100 - (100 / (1 + rs));
        }
    }
    return rsi;
}

// Background Historical Paging Engine (Paging beyond 500 bars on demand)
function handleFetchOlderBars({ chartIdx, currentLoadedCount, batchSize = 500 }) {
    const cfg = CHART_CONFIGS[chartIdx];
    if (!cfg) return;

    const ratio = cfg.ratio;
    const rawBuffer = rawSymbolStores[cfg.symbolIdx];
    const maxAggregatedBars = Math.floor(RAW_BARS_PER_SYMBOL / ratio);

    if (currentLoadedCount >= maxAggregatedBars) {
        renderPort.postMessage({
            type: 'OLDER_BARS_RESPONSE',
            chartIdx,
            count: 0,
            hasMore: false,
            totalAvailable: maxAggregatedBars
        });
        return;
    }

    const fetchCount = Math.min(batchSize, maxAggregatedBars - currentLoadedCount);
    const hasMore = (currentLoadedCount + fetchCount < maxAggregatedBars);

    // Calculate window of older raw bars to aggregate
    const rawEnd = RAW_BARS_PER_SYMBOL - (currentLoadedCount * ratio);
    const rawStart = rawEnd - (fetchCount * ratio);

    const ohlcvChunk = new Float32Array(fetchCount * FLOATS_PER_CANDLE);

    for (let k = 0; k < fetchCount; k++) {
        const barRawStart = rawStart + (k * ratio);
        const barRawEnd = barRawStart + ratio;

        let high = -Infinity;
        let low = Infinity;
        let volume = 0;
        let turnover = 0;
        let trades = 0;

        const open = rawBuffer[barRawStart * FLOATS_PER_CANDLE + FIELD.OPEN];
        const close = rawBuffer[(barRawEnd - 1) * FLOATS_PER_CANDLE + FIELD.CLOSE];

        for (let r = barRawStart; r < barRawEnd; r++) {
            const barOffset = r * FLOATS_PER_CANDLE;
            const h = rawBuffer[barOffset + FIELD.HIGH];
            const l = rawBuffer[barOffset + FIELD.LOW];
            if (h > high) high = h;
            if (l < low) low = l;
            volume += rawBuffer[barOffset + FIELD.VOLUME];
            turnover += rawBuffer[barOffset + FIELD.TURNOVER];
            trades += rawBuffer[barOffset + FIELD.TRADES];
        }

        const targetOffset = k * FLOATS_PER_CANDLE;
        ohlcvChunk[targetOffset + FIELD.TIME] = k;
        ohlcvChunk[targetOffset + FIELD.OPEN] = open;
        ohlcvChunk[targetOffset + FIELD.HIGH] = high;
        ohlcvChunk[targetOffset + FIELD.LOW] = low;
        ohlcvChunk[targetOffset + FIELD.CLOSE] = close;
        ohlcvChunk[targetOffset + FIELD.VOLUME] = volume;
        ohlcvChunk[targetOffset + FIELD.TURNOVER] = turnover;
        ohlcvChunk[targetOffset + FIELD.TRADES] = trades;
        ohlcvChunk[targetOffset + FIELD.VWAP] = turnover / (volume || 1);
        ohlcvChunk[targetOffset + FIELD.BID] = close - 0.05;
        ohlcvChunk[targetOffset + FIELD.ASK] = close + 0.05;
        ohlcvChunk[targetOffset + FIELD.BID_VOL] = 1000;
        ohlcvChunk[targetOffset + FIELD.ASK_VOL] = 1200;
    }

    const smaChunk = calculateChunkSMA(ohlcvChunk, fetchCount, 20);
    const rsiChunk = calculateChunkRSI(ohlcvChunk, fetchCount, 14);

    renderPort.postMessage({
        type: 'OLDER_BARS_RESPONSE',
        chartIdx,
        count: fetchCount,
        ohlcv: ohlcvChunk,
        sma: smaChunk,
        rsi: rsiChunk,
        hasMore,
        totalAvailable: maxAggregatedBars
    }, [ohlcvChunk.buffer, smaChunk.buffer, rsiChunk.buffer]);
}

function calculateChunkSMA(store, count, period = 20) {
    const sma = new Float32Array(count);
    let sum = 0;
    for (let i = 0; i < count; i++) {
        const close = store[i * FLOATS_PER_CANDLE + FIELD.CLOSE];
        sum += close;
        if (i >= period) {
            const oldestClose = store[(i - period) * FLOATS_PER_CANDLE + FIELD.CLOSE];
            sum -= oldestClose;
            sma[i] = sum / period;
        } else if (i === period - 1) {
            sma[i] = sum / period;
        } else {
            sma[i] = close;
        }
    }
    return sma;
}

function calculateChunkRSI(store, count, period = 14) {
    const rsi = new Float32Array(count);
    let gains = 0;
    let losses = 0;
    for (let i = 0; i < count; i++) {
        if (i === 0) {
            rsi[i] = 50;
            continue;
        }
        const prevClose = store[(i - 1) * FLOATS_PER_CANDLE + FIELD.CLOSE];
        const curClose = store[i * FLOATS_PER_CANDLE + FIELD.CLOSE];
        const diff = curClose - prevClose;
        const gain = diff > 0 ? diff : 0;
        const loss = diff < 0 ? -diff : 0;
        if (i <= period) {
            gains += gain;
            losses += loss;
            if (i === period) {
                const rs = losses === 0 ? 100 : gains / losses;
                rsi[i] = 100 - (100 / (1 + rs));
            } else {
                rsi[i] = 50;
            }
        } else {
            const prevAvgGain = gains / period;
            const prevAvgLoss = losses / period;
            const avgGain = (prevAvgGain * (period - 1) + gain) / period;
            const avgLoss = (prevAvgLoss * (period - 1) + loss) / period;
            gains = avgGain;
            losses = avgLoss;
            const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
            rsi[i] = 100 - (100 / (1 + rs));
        }
    }
    return rsi;
}

