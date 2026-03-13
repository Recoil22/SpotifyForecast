import { parentPort } from 'worker_threads';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const VERSION = '0.11.1';
const APP_ID  = 'recoil-spotify-weather-final';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

function post(type, payload, request) { parentPort.postMessage({ version: VERSION, type, payload, request }); }
function sendStarted() { parentPort.postMessage({ version: VERSION, type: 'started' }); }
function sendToClient(data) { post('data', { type: 'send', payload: { app: APP_ID, ...data } }); }
function log(msg) { post('data', { type: 'log', payload: msg }); }

// Source of truth — rewritten by saveDefaults() when user hits Save
let settings = { city_name: 'New York', lat: 40.46, lon: -73.57, temp_unit: 'f' };
let weatherInterval = null;
let lastWeather = null;

function saveDefaults() {
  try {
    const filePath = join(__dirname, 'index.js');
    let src = readFileSync(filePath, 'utf8');
    src = src.replace(
      /let settings = \{ city_name: '.*?', lat: [\d.-]+, lon: [\d.-]+, temp_unit: '.*?' \};/,
      `let settings = { city_name: '${settings.city_name}', lat: ${settings.lat}, lon: ${settings.lon}, temp_unit: '${settings.temp_unit}' };`
    );
    writeFileSync(filePath, src, 'utf8');
    log(`Defaults saved: ${settings.city_name} (${settings.lat}, ${settings.lon})`);
  } catch (e) { log(`Failed to save defaults: ${e.message}`); }
}

async function fetchWeather() {
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${settings.lat}&longitude=${settings.lon}` +
      `&current_weather=true` +
      `&hourly=temperature_2m,weather_code` +
      `&temperature_unit=${settings.temp_unit === 'c' ? 'celsius' : 'fahrenheit'}` +
      `&timezone=auto`;

    const res  = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const totalHours = data.hourly.temperature_2m.length;
    const nowTs      = new Date(); nowTs.setMinutes(0, 0, 0);
    const isoHour    = nowTs.toISOString().slice(0, 13) + ':00';
    const baseIndex  = data.hourly.time.findIndex(t => t === isoHour);
    const startIdx   = baseIndex >= 0 ? baseIndex : nowTs.getHours();

    const forecast = [];
    for (let i = 1; i <= 4; i++) {
      const idx   = Math.min(startIdx + i, totalHours - 1);
      const fHour = (new Date().getHours() + i) % 24;
      forecast.push({
        hour:         fHour,
        weather_code: data.hourly.weather_code[idx] ?? data.current_weather.weathercode,
        temperature:  data.hourly.temperature_2m[idx]  ?? data.current_weather.temperature,
      });
    }

    lastWeather = {
      city_name:    settings.city_name,
      temperature:  data.current_weather.temperature,
      weather_code: data.current_weather.weathercode,
      is_day:       data.current_weather.is_day === 1,
      temp_unit:    settings.temp_unit,
      forecast,
    };
    sendToClient({ type: 'weather_data', payload: lastWeather });
    log('Weather fetched OK');
  } catch (e) { log(`Weather fetch failed: ${e.message}`); }
}

function applySettings(s) {
  if (!s) return;
  if (s.city_name !== undefined) settings.city_name = s.city_name.value ?? s.city_name;
  if (s.lat       !== undefined) settings.lat       = Number(s.lat.value ?? s.lat);
  if (s.lon       !== undefined) settings.lon       = Number(s.lon.value ?? s.lon);
  if (s.temp_unit !== undefined) settings.temp_unit = s.temp_unit.value ?? s.temp_unit;
}

async function start() {
  log(`Weather server starting — ${settings.city_name} (${settings.lat}, ${settings.lon})`);

  // Register our settings fields with DeskThing using current JS-file defaults as initial values.
  // DeskThing will immediately reply with a 'settings' data message containing any previously
  // saved values — that reply is handled below and triggers fetchWeather().
  post('data', {
    type: 'set', request: 'settings',
    payload: {
      city_name: { label: 'City Name', id: 'city_name', value: settings.city_name, type: 'string' },
      lat:       { label: 'Latitude',  id: 'lat',       value: settings.lat,       type: 'number', min: -90,  max: 90  },
      lon:       { label: 'Longitude', id: 'lon',       value: settings.lon,       type: 'number', min: -180, max: 180 },
      temp_unit: { label: 'Temperature Unit', id: 'temp_unit', value: settings.temp_unit, type: 'select', options: [{ label: 'Fahrenheit (°F)', value: 'f' }, { label: 'Celsius (°C)', value: 'c' }] },
    }
  });

  // Also fetch immediately with whatever is in the JS file right now,
  // in case DeskThing doesn't echo settings back (e.g. first install).
  fetchWeather();
  weatherInterval = setInterval(fetchWeather, 5 * 60 * 1000);
}

function stop() {
  if (weatherInterval) clearInterval(weatherInterval);
  weatherInterval = null;
  log('Weather server stopped');
  parentPort.postMessage({ version: VERSION, type: 'stopped' });
}

parentPort.on('message', async (msg) => {
  switch (msg.type) {
    case 'start':
      sendStarted();
      start();
      break;

    case 'stop':
      stop();
      break;

    case 'get':
      if (msg.request === 'weather_data') {
        if (lastWeather) {
          sendToClient({ type: 'weather_data', payload: lastWeather });
        } else {
          fetchWeather();
        }
      }
      break;

    case 'data': {
      const payload = msg.payload;
      if (!payload) break;

      if (payload.type === 'settings' && payload.payload) {
        const prev = JSON.stringify(settings);
        applySettings(payload.payload);
        const changed = JSON.stringify(settings) !== prev;
        log(`Settings received — city: ${settings.city_name}, lat: ${settings.lat}, lon: ${settings.lon}, changed: ${changed}`);
        // Always fetch on settings message — this covers both:
        // 1. DeskThing echoing back saved settings on startup
        // 2. User hitting Save
        // saveDefaults() only if user actually changed values (not on startup echo)
        if (changed) saveDefaults();
        fetchWeather();
      }

      if (payload.type === 'get' && payload.request === 'weather_data') {
        if (lastWeather) {
          sendToClient({ type: 'weather_data', payload: lastWeather });
        } else {
          fetchWeather();
        }
      }
      break;
    }
  }
});

export { };
