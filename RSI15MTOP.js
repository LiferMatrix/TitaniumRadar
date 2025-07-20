require('dotenv').config();
const ccxt = require('ccxt');
const TechnicalIndicators = require('technicalindicators');
const { Bot } = require('grammy');
const winston = require('winston');
const axios = require('axios');

// ================= CONFIGURAÇÃO ================= //
const config = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  INTERVALO_ALERTA_MS: 5 * 60 * 1000, // 5 minutos
  RSI_PERIOD: 14,
  ATR_PERIOD: 14,
  CACHE_TTL: 5 * 60 * 1000, // 5 minutos
  MAX_CACHE_SIZE: 100,
  LIMIT_TRADES_DELTA: 100,
  VOLUME_SPIKE_THRESHOLD: 2,
  FUNDING_RATE_CHANGE_THRESHOLD: 0.005,
  RSI_OVERSOLD_THRESHOLD: 35, // Ajustado para teste
  RSI_OVERBOUGHT_THRESHOLD: 65, // Ajustado para teste
  MAX_COINS_PER_ALERT: 10, // Limite de moedas por mensagem
  MAX_MESSAGE_LENGTH: 4000 // Limite de caracteres por mensagem
};

// Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.File({ filename: 'monitor.log' }),
    new winston.transports.Console()
  ]
});

// Estado global
const state = {
  dataCache: new Map(),
  lastFundingRates: new Map(),
  rsiPeaks: new Map()
};

// Validação de variáveis de ambiente
function validateEnv() {
  const required = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
  for (const key of required) {
    if (!process.env[key]) {
      logger.error(`Variável de ambiente ausente: ${key}`);
      process.exit(1);
    }
  }
}
validateEnv();

// Inicialização do Telegram e Exchange
const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
const exchangeFutures = new ccxt.binance({
  apiKey: process.env.BINANCE_API_KEY,
  secret: process.env.BINANCE_SECRET_KEY,
  enableRateLimit: true,
  timeout: 30000,
  options: { defaultType: 'future' }
});

// ================= UTILITÁRIOS ================= //
async function withRetry(fn, retries = 5, delayBase = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt === retries) {
        logger.warn(`Falha após ${retries} tentativas: ${e.message}`);
        throw e;
      }
      const delay = Math.pow(2, attempt - 1) * delayBase;
      logger.info(`Tentativa ${attempt} falhou, retry após ${delay}ms: ${e.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

function getCachedData(key) {
  const cacheEntry = state.dataCache.get(key);
  if (cacheEntry && Date.now() - cacheEntry.timestamp < config.CACHE_TTL) {
    logger.info(`Usando cache para ${key}: ${JSON.stringify(cacheEntry.data)}`);
    return cacheEntry.data;
  }
  state.dataCache.delete(key);
  return null;
}

function setCachedData(key, data) {
  if (data === null || (data.value !== undefined && data.value === null)) {
    logger.info(`Não armazenando valor nulo no cache para ${key}`);
    return;
  }
  if (state.dataCache.size >= config.MAX_CACHE_SIZE) {
    const oldestKey = state.dataCache.keys().next().value;
    state.dataCache.delete(oldestKey);
    logger.info(`Cache cheio, removido item mais antigo: ${oldestKey}`);
  }
  state.dataCache.set(key, { timestamp: Date.now(), data });
}

// Limpeza periódica do cache
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of state.dataCache) {
    if (now - entry.timestamp > config.CACHE_TTL) {
      state.dataCache.delete(key);
      logger.info(`Cache removido: ${key}`);
    }
  }
}, 60 * 60 * 1000);

// Rastrear picos de RSI
function updateRsiPeaks(symbol, rsi15m) {
  const cacheKey = `rsi_peaks_${symbol}`;
  const currentPeaks = state.rsiPeaks.get(cacheKey) || {
    oversold15m: false,
    overbought15m: false,
    timestamp: Date.now()
  };

  if (rsi15m !== null && rsi15m < config.RSI_OVERSOLD_THRESHOLD) {
    currentPeaks.oversold15m = true;
  }
  if (rsi15m !== null && rsi15m > config.RSI_OVERBOUGHT_THRESHOLD) {
    currentPeaks.overbought15m = true;
  }
  if (rsi15m !== null && rsi15m >= config.RSI_OVERSOLD_THRESHOLD && rsi15m <= config.RSI_OVERBOUGHT_THRESHOLD) {
    currentPeaks.oversold15m = false;
    currentPeaks.overbought15m = false;
  }

  state.rsiPeaks.set(cacheKey, { ...currentPeaks, timestamp: Date.now() });
  logger.info(`RSI Peaks atualizados para ${symbol}: ${JSON.stringify(currentPeaks)}`);
}

async function limitConcurrency(items, fn, limit = 5) {
  const results = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    const batchResults = await Promise.all(batch.map(item => fn(item)));
    results.push(...batchResults);
  }
  return results;
}

// ================= INDICADORES ================= //
function normalizeOHLCV(data, symbol) {
  if (!data || !Array.isArray(data) || data.length === 0) {
    logger.warn(`Dados OHLCV vazios ou inválidos para ${symbol}`);
    return [];
  }
  const normalized = data.map(c => ({
    time: c[0],
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[5])
  })).filter(c => !isNaN(c.close) && !isNaN(c.volume) && c.close > 0);
  if (normalized.length === 0) {
    logger.warn(`Nenhum dado OHLCV válido após normalização para ${symbol}`);
  } else {
    logger.info(` dados OHLCV normalizados para ${symbol}: ${normalized.length} velas`);
  }
  return normalized;
}

function calculateRSI(data, symbol) {
  if (!data || data.length < config.RSI_PERIOD + 1) {
    logger.warn(`Dados insuficientes para calcular RSI para ${symbol}: ${data?.length || 0} velas disponíveis`);
    return null;
  }
  const closes = data.map(d => d.close);
  if (closes.every(c => c === closes[0])) {
    logger.warn(`Preços constantes detectados para ${symbol}, RSI inválido`);
    return null;
  }
  const rsi = TechnicalIndicators.RSI.calculate({
    period: config.RSI_PERIOD,
    values: closes
  });
  const rsiValue = rsi.length ? parseFloat(rsi[rsi.length - 1].toFixed(2)) : null;
  logger.info(`RSI calculado para ${symbol}: ${rsiValue}, dados: ${data.length} velas`);
  return rsiValue;
}

function calculateATR(data, symbol) {
  if (!data || data.length < config.ATR_PERIOD + 1) {
    logger.warn(`Dados insuficientes para calcular ATR para ${symbol}: ${data?.length || 0} velas disponíveis`);
    return null;
  }
  const atr = TechnicalIndicators.ATR.calculate({
    period: config.ATR_PERIOD,
    high: data.map(d => d.high),
    low: data.map(d => d.low),
    close: data.map(d => d.close)
  });
  return atr.length ? parseFloat(atr[atr.length - 1].toFixed(8)) : null;
}

function calculateStochastic(data, symbol) {
  if (!data || data.length < 5 + 3) {
    logger.warn(`Dados insuficientes para calcular Estocástico para ${symbol}: ${data?.length || 0} velas disponíveis`);
    return { k: null, d: null, previousK: null };
  }
  const closes = data.map(d => d.close);
  if (closes.every(c => c === closes[0])) {
    logger.warn(`Preços constantes detectados para ${symbol}, Estocástico inválido`);
    return { k: null, d: null, previousK: null };
  }
  const stochastic = TechnicalIndicators.Stochastic.calculate({
    period: 5,
    signalPeriod: 3,
    high: data.map(d => d.high),
    low: data.map(d => d.low),
    close: closes
  });
  if (stochastic.length < 2) {
    logger.warn(`Resultados insuficientes para Estocástico para ${symbol}: ${stochastic.length} períodos calculados`);
    return { k: null, d: null, previousK: null };
  }
  return {
    k: parseFloat(stochastic[stochastic.length - 1].k.toFixed(2)),
    d: parseFloat(stochastic[stochastic.length - 1].d.toFixed(2)),
    previousK: parseFloat(stochastic[stochastic.length - 2].k.toFixed(2))
  };
}

function calculateSupportResistance(data, symbol) {
  if (!data || data.length < 50) {
    logger.warn(`Dados insuficientes para calcular Suporte/Resistência para ${symbol}: ${data?.length || 0} velas disponíveis`);
    return { support: null, resistance: null };
  }
  const lows = data.map(d => d.low);
  const highs = data.map(d => d.high);
  const support = Math.min(...lows);
  const resistance = Math.max(...highs);
  return {
    support: parseFloat(support.toFixed(8)),
    resistance: parseFloat(resistance.toFixed(8))
  };
}

async function fetchLSR(symbol) {
  const cacheKey = `lsr_${symbol}`;
  const cached = getCachedData(cacheKey);
  if (cached) {
    logger.info(`Usando cache para LSR de ${symbol}: ${cached.value}`);
    return cached;
  }
  try {
    // Ajustar formato do símbolo para compatibilidade com a API
    let apiSymbol = symbol.replace('/', '').toUpperCase();
    if (apiSymbol.endsWith(':USDT')) {
      apiSymbol = apiSymbol.replace(':USDT', '');
    }
    logger.info(`Símbolo enviado para API de LSR: ${apiSymbol}`);

    // Adicionar atraso para evitar limite de taxa
    await new Promise(resolve => setTimeout(resolve, 100));

    const res = await withRetry(() =>
      axios.get('https://fapi.binance.com/futures/data/globalLongShortAccountRatio', {
        params: { symbol: apiSymbol, period: '15m', limit: 1 }
      })
    );
    logger.info(`Resposta bruta de LSR para ${symbol}: ${JSON.stringify(res.data)}`);
    logger.info(`Status HTTP da requisição LSR para ${symbol}: ${res.status}`);

    if (!res.data || !Array.isArray(res.data) || res.data.length === 0) {
      logger.warn(`Dados insuficientes de LSR para ${symbol}: resposta vazia ou inválida`);
      return { value: null };
    }

    const longShortRatio = res.data[0]?.longShortRatio;
    if (longShortRatio === undefined || longShortRatio === null) {
      logger.warn(`longShortRatio não definido para ${symbol}: ${JSON.stringify(res.data[0])}`);
      return { value: null };
    }

    const value = parseFloat(longShortRatio);
    if (isNaN(value) || value < 0) {
      logger.warn(`longShortRatio inválido para ${symbol}: ${longShortRatio}`);
      return { value: null };
    }

    const result = { value: parseFloat(value.toFixed(2)) };
    setCachedData(cacheKey, result);
    logger.info(`LSR calculado para ${symbol}: ${result.value}`);
    return result;
  } catch (e) {
    logger.warn(`Erro ao buscar LSR para ${symbol}: ${e.message}, código: ${e.response?.status}`);
    return { value: null };
  }
}

async function fetchFundingRate(symbol) {
  const cacheKey = `funding_${symbol}`;
  const cached = getCachedData(cacheKey);
  if (cached) return cached;
  try {
    const fundingData = await withRetry(() => exchangeFutures.fetchFundingRate(symbol));
    const result = { current: parseFloat((fundingData.fundingRate * 100).toFixed(5)) };
    setCachedData(cacheKey, result);
    state.lastFundingRates.set(symbol, result.current);
    return result;
  } catch (e) {
    logger.warn(`Erro ao buscar Funding Rate para ${symbol}: ${e.message}`);
    return { current: null };
  }
}

async function fetchOpenInterest(symbol, timeframe) {
  const cacheKey = `oi_${symbol}_${timeframe}`;
  const cached = getCachedData(cacheKey);
  if (cached) return cached;
  try {
    const oiData = await withRetry(() => exchangeFutures.fetchOpenInterestHistory(symbol, timeframe, undefined, 6));
    if (!oiData || oiData.length < 3) {
      logger.warn(`Dados insuficientes de Open Interest para ${symbol} no timeframe ${timeframe}: ${oiData?.length || 0} registros`);
      return { isRising: false, value: null };
    }
    const validOiData = oiData
      .filter(d => {
        const oiValue = d.openInterest || d.openInterestAmount || (d.info && d.info.sumOpenInterest);
        return typeof oiValue === 'number' && !isNaN(oiValue) && oiValue >= 0;
      })
      .map(d => ({
        ...d,
        openInterest: d.openInterest || d.openInterestAmount || (d.info && d.info.sumOpenInterest)
      }))
      .sort((a, b) => b.timestamp - a.timestamp);
    if (validOiData.length < 3) {
      logger.warn(`Registros válidos insuficientes para ${symbol} no timeframe ${timeframe}: ${validOiData.length}`);
      return { isRising: false, value: null };
    }
    const recentOi = validOiData.slice(0, 3).map(d => d.openInterest);
    const previousOi = validOiData.slice(3, 6).map(d => d.openInterest);
    const smaRecent = recentOi.reduce((sum, val) => sum + val, 0) / recentOi.length;
    const smaPrevious = previousOi.length >= 3 ? previousOi.reduce((sum, val) => sum + val, 0) / previousOi.length : recentOi[recentOi.length - 1];
    const result = { 
      isRising: smaRecent > smaPrevious,
      value: parseFloat(smaRecent.toFixed(2))
    };
    setCachedData(cacheKey, result);
    logger.info(`Open Interest calculado para ${symbol} no timeframe ${timeframe}: smaRecent=${smaRecent}, smaPrevious=${smaPrevious}, isRising=${result.isRising}`);
    return result;
  } catch (e) {
    logger.warn(`Erro ao buscar Open Interest para ${symbol} no timeframe ${timeframe}: ${e.message}`);
    return { isRising: false, value: null };
  }
}

async function calculateAggressiveDelta(symbol) {
  const cacheKey = `delta_${symbol}`;
  const cached = getCachedData(cacheKey);
  if (cached) return cached;
  try {
    const trades = await withRetry(() => exchangeFutures.fetchTrades(symbol, undefined, config.LIMIT_TRADES_DELTA));
    let buyVolume = 0;
    let sellVolume = 0;
    for (const trade of trades) {
      const { side, amount, price } = trade;
      if (!side || !amount || !price || isNaN(amount) || isNaN(price)) continue;
      if (side === 'buy') buyVolume += amount;
      else if (side === 'sell') sellVolume += amount;
    }
    const delta = buyVolume - sellVolume;
    const totalVolume = buyVolume + sellVolume;
    const deltaPercent = totalVolume !== 0 ? parseFloat((delta / totalVolume * 100).toFixed(2)) : 0;
    const result = { deltaPercent, isBuyPressure: delta > 0 };
    setCachedData(cacheKey, result);
    logger.info(`Delta Agressivo para ${symbol}: Buy=${buyVolume}, Sell=${sellVolume}, Delta%=${deltaPercent}%`);
    return result;
  } catch (e) {
    logger.error(`Erro ao calcular Delta Agressivo para ${symbol}: ${e.message}`);
    return { deltaPercent: 0, isBuyPressure: false };
  }
}

async function detectVolumeSpike(symbol, timeframe = '15m') {
  try {
    const ohlcv = await withRetry(() => exchangeFutures.fetchOHLCV(symbol, timeframe, undefined, 3));
    const volumes = normalizeOHLCV(ohlcv, symbol).map(d => d.volume);
    if (volumes.length < 2) return false;
    const spike = volumes[volumes.length - 1] / volumes[volumes.length - 2] > config.VOLUME_SPIKE_THRESHOLD;
    logger.info(`Pico de volume para ${symbol}: ${spike ? 'Detectado' : 'Não detectado'}, volume atual: ${volumes[volumes.length - 1]}, volume anterior: ${volumes[volumes.length - 2]}`);
    return spike;
  } catch (e) {
    logger.warn(`Erro ao detectar pico de volume para ${symbol}: ${e.message}`);
    return false;
  }
}

async function detectFundingRateChange(symbol, currentFundingRate) {
  const lastFundingRate = state.lastFundingRates.get(symbol) || currentFundingRate;
  const change = Math.abs(currentFundingRate - lastFundingRate);
  const isSignificantChange = change >= config.FUNDING_RATE_CHANGE_THRESHOLD;
  logger.info(`Funding Rate para ${symbol}: Atual=${currentFundingRate}%, Anterior=${lastFundingRate}%, Mudança=${change}, Significativa=${isSignificantChange}`);
  return isSignificantChange;
}

// ================= FUNÇÕES DE ALERTAS ================= //
function getStochasticEmoji(value) {
  if (!value) return "";
  return value < 10 ? "🔵" : value < 25 ? "🟢" : value <= 55 ? "🟡" : value <= 70 ? "🟠" : value <= 80 ? "🔴" : "💥";
}

function getSetaDirecao(current, previous) {
  if (!current || !previous) return "➡️";
  return current > previous ? "⬆️" : current < previous ? "⬇️" : "➡️";
}

// Função para dividir mensagens longas
async function sendTelegramMessage(message) {
  const maxLength = config.MAX_MESSAGE_LENGTH;
  if (message.length <= maxLength) {
    await withRetry(() => bot.api.sendMessage(config.TELEGRAM_CHAT_ID, message, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    }));
    logger.info(`Mensagem enviada com sucesso, tamanho: ${message.length} caracteres`);
    return;
  }

  const lines = message.split('\n');
  let part = '';
  const parts = [];
  for (const line of lines) {
    if (part.length + line.length + 1 > maxLength) {
      parts.push(part);
      part = '';
    }
    part += line + '\n';
  }
  if (part) parts.push(part);

  for (let i = 0; i < parts.length; i++) {
    await withRetry(() => bot.api.sendMessage(config.TELEGRAM_CHAT_ID, parts[i], {
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    }));
    logger.info(`Parte ${i + 1}/${parts.length} enviada, tamanho: ${parts[i].length} caracteres`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

// ================= ALERTAS ================= //
async function sendMonitorAlert(coins) {
  const topLowRsi = coins
    .filter(c => c.rsi !== null && c.rsi < config.RSI_OVERSOLD_THRESHOLD)
    .sort((a, b) => a.rsi - b.rsi)
    .slice(0, config.MAX_COINS_PER_ALERT);
  const topHighRsi = coins
    .filter(c => c.rsi !== null && c.rsi > config.RSI_OVERBOUGHT_THRESHOLD)
    .sort((a, b) => b.rsi - a.rsi)
    .slice(0, config.MAX_COINS_PER_ALERT);

  const format = (v, precision = 2) => isNaN(v) || v === null ? 'N/A' : v.toFixed(precision);
  const formatPrice = (price) => price < 1 ? price.toFixed(8) : price < 10 ? price.toFixed(6) : price < 100 ? price.toFixed(4) : price.toFixed(2);

  logger.info(`Moedas com RSI baixo: ${topLowRsi.length}, Moedas com RSI alto: ${topHighRsi.length}`);

  if (topLowRsi.length > 0) {
    let starAlertText = `🟢*RSI-💥Monitor💥 *\n\n`;
    starAlertText += await Promise.all(topLowRsi.map(async (coin, i) => {
      const tradingViewLink = `https://www.tradingview.com/chart/?symbol=BINANCE:${coin.symbol.replace('/', '')}&interval=15`;
      const deltaText = coin.delta.isBuyPressure ? `💹${format(coin.delta.deltaPercent)}%` : `⭕${format(coin.delta.deltaPercent)}%`;
      let lsrSymbol = '';
      if (coin.lsr !== null && !isNaN(coin.lsr)) {
        if (coin.lsr <= 1.4) lsrSymbol = '✅ Baixo';
        else if (coin.lsr >= 2.8) lsrSymbol = '📛 Alto';
      }
      const lsrText = coin.lsr !== null && !isNaN(coin.lsr) ? format(coin.lsr) + ` ${lsrSymbol}` : 'Indisponível';
      let fundingRateEmoji = '';
      if (coin.funding.current !== null) {
        if (coin.funding.current <= -0.002) fundingRateEmoji = '🟢🟢🟢';
        else if (coin.funding.current <= -0.001) fundingRateEmoji = '🟢🟢';
        else if (coin.funding.current <= -0.0005) fundingRateEmoji = '🟢';
        else if (coin.funding.current >= 0.001) fundingRateEmoji = '🔴🔴🔴';
        else if (coin.funding.current >= 0.0003) fundingRateEmoji = '🔴🔴';
        else if (coin.funding.current >= 0.0002) fundingRateEmoji = '🔴';
        else fundingRateEmoji = '🟢';
      }
      const oi5mText = coin.oi5m.isRising ? '⬆️ Subindo' : '⬇️ Descendo';
      const oi15mText = coin.oi15m.isRising ? '⬆️ Subindo' : '⬇️ Descendo';
      const isVolumeSpike = await detectVolumeSpike(coin.symbol);
      const isFundingAnomaly = await detectFundingRateChange(coin.symbol, coin.funding.current);
      const anomalyText = isVolumeSpike || isFundingAnomaly ? `🚨 Anomalia: ${isVolumeSpike ? 'Pico de Volume' : ''}${isVolumeSpike && isFundingAnomaly ? ' | ' : ''}${isFundingAnomaly ? 'Mudança no Funding Rate' : ''}\n` : '';
      const stoch4hK = coin.stoch4h.k !== null ? format(coin.stoch4h.k) : 'N/A';
      const stoch4hD = coin.stoch4h.d !== null ? format(coin.stoch4h.d) : 'N/A';
      const stoch4hKEmoji = getStochasticEmoji(coin.stoch4h.k);
      const stoch4hDEmoji = getStochasticEmoji(coin.stoch4h.d);
      const stoch4hDir = getSetaDirecao(coin.stoch4h.k, coin.stoch4h.previousK);
      const stoch1dK = coin.stoch1d.k !== null ? format(coin.stoch1d.k) : 'N/A';
      const stoch1dD = coin.stoch1d.d !== null ? format(coin.stoch1d.d) : 'N/A';
      const stoch1dKEmoji = getStochasticEmoji(coin.stoch1d.k);
      const stoch1dDEmoji = getStochasticEmoji(coin.stoch1d.d);
      const stoch1dDir = getSetaDirecao(coin.stoch1d.k, coin.stoch1d.previousK);
      return `${i + 1}. 🔹 *${coin.symbol}* [- TradingView](${tradingViewLink})\n` +
             `   💲 Preço: ${formatPrice(coin.price)}\n` +
             `   LSR: ${lsrText}\n` +
             `   RSI (15m): ${format(coin.rsi)}\n` +
             `   RSI (1h): ${format(coin.rsi1h)}\n` +
             `   Stoch (4h): %K ${stoch4hK}${stoch4hKEmoji} ${stoch4hDir} | %D ${stoch4hD}${stoch4hDEmoji}\n` +
             `   Stoch (1d): %K ${stoch1dK}${stoch1dKEmoji} ${stoch1dDir} | %D ${stoch1dD}${stoch1dDEmoji}\n` +
             `   Vol.Delta: ${deltaText}\n` +
             `   Fund.Rate: ${fundingRateEmoji}${format(coin.funding.current, 5)}%\n` +
             `   OI 5m: ${oi5mText}\n` +
             `   OI 15m: ${oi15mText}\n` +
             `   Suporte: ${formatPrice(coin.supportResistance.support)}\n` +
             `   Resistência: ${formatPrice(coin.supportResistance.resistance)}\n` +
             anomalyText;
    })).then(results => results.join('\n'));
    starAlertText += `\n☑︎ 🤖 Gerencie seu risco - @J4Rviz`;

    logger.info(`Tamanho da mensagem de RSI baixo: ${starAlertText.length} caracteres`);
    await sendTelegramMessage(starAlertText);
    logger.info('Alerta de moedas com RSI em sobrevenda enviado com sucesso');
  }

  if (topHighRsi.length > 0) {
    let skullAlertText = `🔴*RSI-💥Monitor💥 *\n\n`;
    skullAlertText += await Promise.all(topHighRsi.map(async (coin, i) => {
      const tradingViewLink = `https://www.tradingview.com/chart/?symbol=BINANCE:${coin.symbol.replace('/', '')}&interval=15`;
      const deltaText = coin.delta.isBuyPressure ? `💹${format(coin.delta.deltaPercent)}%` : `⭕${format(coin.delta.deltaPercent)}%`;
      let lsrSymbol = '';
      if (coin.lsr !== null && !isNaN(coin.lsr)) {
        if (coin.lsr <= 1.4) lsrSymbol = '✅ Baixo';
        else if (coin.lsr >= 2.8) lsrSymbol = '📛 Alto';
      }
      const lsrText = coin.lsr !== null && !isNaN(coin.lsr) ? format(coin.lsr) + ` ${lsrSymbol}` : 'Indisponível';
      let fundingRateEmoji = '';
      if (coin.funding.current !== null) {
        if (coin.funding.current <= -0.002) fundingRateEmoji = '🟢🟢🟢';
        else if (coin.funding.current <= -0.001) fundingRateEmoji = '🟢🟢';
        else if (coin.funding.current <= -0.0005) fundingRateEmoji = '🟢';
        else if (coin.funding.current >= 0.001) fundingRateEmoji = '🔴🔴🔴';
        else if (coin.funding.current >= 0.0003) fundingRateEmoji = '🔴🔴';
        else if (coin.funding.current >= 0.0002) fundingRateEmoji = '🔴';
        else fundingRateEmoji = '🟢';
      }
      const oi5mText = coin.oi5m.isRising ? '⬆️ Subindo' : '⬇️ Descendo';
      const oi15mText = coin.oi15m.isRising ? '⬆️ Subindo' : '⬇️ Descendo';
      const isVolumeSpike = await detectVolumeSpike(coin.symbol);
      const isFundingAnomaly = await detectFundingRateChange(coin.symbol, coin.funding.current);
      const anomalyText = isVolumeSpike || isFundingAnomaly ? `🚨 Anomalia: ${isVolumeSpike ? 'Pico de Volume' : ''}${isVolumeSpike && isFundingAnomaly ? ' | ' : ''}${isFundingAnomaly ? 'Mudança no Funding Rate' : ''}\n` : '';
      const stoch4hK = coin.stoch4h.k !== null ? format(coin.stoch4h.k) : 'N/A';
      const stoch4hD = coin.stoch4h.d !== null ? format(coin.stoch4h.d) : 'N/A';
      const stoch4hKEmoji = getStochasticEmoji(coin.stoch4h.k);
      const stoch4hDEmoji = getStochasticEmoji(coin.stoch4h.d);
      const stoch4hDir = getSetaDirecao(coin.stoch4h.k, coin.stoch4h.previousK);
      const stoch1dK = coin.stoch1d.k !== null ? format(coin.stoch1d.k) : 'N/A';
      const stoch1dD = coin.stoch1d.d !== null ? format(coin.stoch1d.d) : 'N/A';
      const stoch1dKEmoji = getStochasticEmoji(coin.stoch1d.k);
      const stoch1dDEmoji = getStochasticEmoji(coin.stoch1d.d);
      const stoch1dDir = getSetaDirecao(coin.stoch1d.k, coin.stoch1d.previousK);
      return `${i + 1}. 🔻 *${coin.symbol}* [- TradingView](${tradingViewLink})\n` +
             `   💲 Preço: ${formatPrice(coin.price)}\n` +
             `   LSR: ${lsrText}\n` +
             `   RSI (15m): ${format(coin.rsi)}\n` +
             `   RSI (1h): ${format(coin.rsi1h)}\n` +
             `   Stoch (4h): %K ${stoch4hK}${stoch4hKEmoji} ${stoch4hDir} | %D ${stoch4hD}${stoch4hDEmoji}\n` +
             `   Stoch (1d): %K ${stoch1dK}${stoch1dKEmoji} ${stoch1dDir} | %D ${stoch1dD}${stoch1dDEmoji}\n` +
             `   Vol.Delta: ${deltaText}\n` +
             `   Fund.Rate: ${fundingRateEmoji}${format(coin.funding.current, 5)}%\n` +
             `   OI 5m: ${oi5mText}\n` +
             `   OI 15m: ${oi15mText}\n` +
             `   Suporte: ${formatPrice(coin.supportResistance.support)}\n` +
             `   Resistência: ${formatPrice(coin.supportResistance.resistance)}\n` +
             anomalyText;
    })).then(results => results.join('\n'));
    skullAlertText += `\n☑︎ 🤖 Gerencie seu risco - @J4Rviz`;

    logger.info(`Tamanho da mensagem de RSI alto: ${skullAlertText.length} caracteres`);
    await sendTelegramMessage(skullAlertText);
    logger.info('Alerta de moedas com RSI em sobrecompra enviado com sucesso');
  }

  if (topLowRsi.length === 0 && topHighRsi.length === 0) {
    await sendTelegramMessage('🤖 Titanium Monitor ativo! Nenhuma moeda com RSI < 35 ou > 65 detectada.');
    logger.info('Nenhuma moeda com RSI < 35 ou > 65, alerta de teste enviado.');
  } else {
    logger.info('Alertas de monitoramento processados com sucesso');
  }
}

// ================= LÓGICA PRINCIPAL ================= //
async function checkCoins() {
  try {
    const markets = await withRetry(() => exchangeFutures.loadMarkets());
    if (!markets || Object.keys(markets).length === 0) {
      logger.error('Nenhum mercado carregado por loadMarkets()');
      return;
    }
    
    // Logar os primeiros 10 pares para depuração
    const allPairs = Object.keys(markets);
    logger.info(`Total de pares carregados: ${allPairs.length}`);
    logger.info(`Primeiros 10 pares: ${allPairs.slice(0, 10).join(', ')}`);

    const usdtPairs = Object.keys(markets)
      .filter(symbol => {
        const isUSDT = symbol.endsWith('USDT') || symbol.endsWith(':USDT');
        const isActive = markets[symbol].active;
        const isFuture = markets[symbol].future || (markets[symbol].info && markets[symbol].info.contractType === 'PERPETUAL');
        logger.debug(`Verificando par ${symbol}: isUSDT=${isUSDT}, isActive=${isActive}, isFuture=${isFuture}`);
        return isUSDT && isActive && isFuture;
      })
      .slice(0, 100);

    logger.info(`Pares de futuros USDT encontrados: ${usdtPairs.length}`);
    if (usdtPairs.length === 0) {
      logger.warn('Nenhum par de futuros USDT encontrado, verificando configuração da API');
      return;
    }

    const coinsData = await limitConcurrency(usdtPairs, async (symbol) => {
      try {
        const ticker = await withRetry(() => exchangeFutures.fetchTicker(symbol));
        const price = ticker?.last || null;
        const volume = ticker?.baseVolume * price || 0;
        if (!price) {
          logger.warn(`Preço inválido para ${symbol}, pulando...`);
          return null;
        }

        const ohlcv15mRaw = getCachedData(`ohlcv_${symbol}_15m`) ||
          await withRetry(() => exchangeFutures.fetchOHLCV(symbol, '15m', undefined, Math.max(config.RSI_PERIOD, config.ATR_PERIOD) + 1));
        setCachedData(`ohlcv_${symbol}_15m`, ohlcv15mRaw);
        const ohlcv15m = normalizeOHLCV(ohlcv15mRaw, symbol);
        if (!ohlcv15m.length) {
          logger.warn(`Dados OHLCV insuficientes para ${symbol} (15m), pulando...`);
          return null;
        }

        const ohlcv1hRaw = getCachedData(`ohlcv_${symbol}_1h`) ||
          await withRetry(() => exchangeFutures.fetchOHLCV(symbol, '1h', undefined, config.RSI_PERIOD + 1));
        setCachedData(`ohlcv_${symbol}_1h`, ohlcv1hRaw);
        const ohlcv1h = normalizeOHLCV(ohlcv1hRaw, symbol);
        if (!ohlcv1h.length) {
          logger.warn(`Dados OHLCV insuficientes para ${symbol} (1h), pulando...`);
          return null;
        }

        const ohlcv4hRaw = getCachedData(`ohlcv_${symbol}_4h`) ||
          await withRetry(() => exchangeFutures.fetchOHLCV(symbol, '4h', undefined, 8));
        setCachedData(`ohlcv_${symbol}_4h`, ohlcv4hRaw);
        const ohlcv4h = normalizeOHLCV(ohlcv4hRaw, symbol);
        if (!ohlcv4h.length) {
          logger.warn(`Dados OHLCV insuficientes para ${symbol} (4h), pulando...`);
          return null;
        }

        const ohlcv1dRaw = getCachedData(`ohlcv_${symbol}_1d`) ||
          await withRetry(() => exchangeFutures.fetchOHLCV(symbol, '1d', undefined, 8));
        setCachedData(`ohlcv_${symbol}_1d`, ohlcv1dRaw);
        const ohlcv1d = normalizeOHLCV(ohlcv1dRaw, symbol);
        if (!ohlcv1d.length) {
          logger.warn(`Dados OHLCV insuficientes para ${symbol} (1d), pulando...`);
          return null;
        }

        const ohlcv50Raw = getCachedData(`ohlcv_${symbol}_50`) ||
          await withRetry(() => exchangeFutures.fetchOHLCV(symbol, '15m', undefined, 50));
        setCachedData(`ohlcv_${symbol}_50`, ohlcv50Raw);
        const ohlcv50 = normalizeOHLCV(ohlcv50Raw, symbol);
        if (!ohlcv50.length) {
          logger.warn(`Dados OHLCV insuficientes para ${symbol} (50 períodos), pulando...`);
          return null;
        }

        const rsi = calculateRSI(ohlcv15m, symbol);
        const rsi1h = calculateRSI(ohlcv1h, symbol);
        const atr = calculateATR(ohlcv15m, symbol);
        const lsr = (await fetchLSR(symbol)).value;
        const funding = await fetchFundingRate(symbol);
        const delta = await calculateAggressiveDelta(symbol);
        const oi5m = await fetchOpenInterest(symbol, '5m');
        const oi15m = await fetchOpenInterest(symbol, '15m');
        const stoch4h = calculateStochastic(ohlcv4h, symbol);
        const stoch1d = calculateStochastic(ohlcv1d, symbol);
        const supportResistance = calculateSupportResistance(ohlcv50, symbol);

        updateRsiPeaks(symbol, rsi);
        const volumeSpike = await detectVolumeSpike(symbol);
        const fundingAnomaly = await detectFundingRateChange(symbol, funding.current);

        logger.info(`Moeda processada: ${symbol}, RSI: ${rsi}, RSI1h: ${rsi1h}, Stoch4h: K=${stoch4h.k}, D=${stoch4h.d}, Stoch1d: K=${stoch1d.k}, D=${stoch1d.d}, LSR: ${lsr}`);

        return { symbol, price, rsi, rsi1h, atr, lsr, funding, delta, oi5m, oi15m, volume, volumeSpike, fundingAnomaly, stoch4h, stoch1d, supportResistance };
      } catch (e) {
        logger.warn(`Erro ao processar ${symbol}: ${e.message}`);
        return null;
      }
    }, 5);

    const validCoins = coinsData.filter(coin => coin !== null);
    logger.info(`Moedas válidas processadas: ${validCoins.length}`);
    validCoins.forEach(coin => logger.info(`Moeda: ${coin.symbol}, RSI: ${coin.rsi}, RSI1h: ${coin.rsi1h}, Stoch4h: K=${coin.stoch4h.k}, D=${coin.stoch4h.d}, Stoch1d: K=${coin.stoch1d.k}, D=${coin.stoch1d.d}, LSR: ${coin.lsr}`));
    if (validCoins.length > 0) {
      await sendMonitorAlert(validCoins);
    } else {
      logger.warn('Nenhuma moeda válida processada, nenhum alerta enviado.');
    }
  } catch (e) {
    logger.error(`Erro ao processar moedas: ${e.message}`);
  }
}

async function main() {
  logger.info('Iniciando monitor de moedas');
  try {
    await withRetry(() => bot.api.sendMessage(config.TELEGRAM_CHAT_ID, '🤖 Titanium RSI MONITOR !'));
    await checkCoins();
    setInterval(checkCoins, config.INTERVALO_ALERTA_MS);
  } catch (e) {
    logger.error(`Erro ao iniciar monitor: ${e.message}`);
  }
}

main().catch(e => logger.error(`Erro fatal: ${e.message}`));