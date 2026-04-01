/* ============================================
   MangoCoco Meteo - app.js
   Logique meteo + protocole de decision
   ============================================ */

// ---- Configuration ----
const CONFIG = {
  // Date de la prochaine soiree (format YYYY-MM-DD). Mettre null pour auto (prochain jeudi).
  EVENT_DATE: null,

  // Coordonnees : Quais Tino Rossi, Paris 5e
  LAT: 48.849,
  LON: 2.354,

  // Creneaux de la soiree (heures)
  EVENT_START_HOUR: 20,
  EVENT_END_HOUR: 24, // minuit = 24 (ou 0 du jour suivant)

  // Seuils du protocole
  THRESHOLD_DAILY_PERCENT: 70,   // veille 20h : annuler si precip journee > 70%
  THRESHOLD_SLOT_PERCENT: 20,    // jour J 17h : annuler si precip creneaux > 20%

  // Refresh toutes les 30 min
  REFRESH_INTERVAL_MS: 30 * 60 * 1000,
};


// ---- Gestion de la date ----

function getNextThursday(fromDate) {
  const d = new Date(fromDate);
  const day = d.getDay(); // 0=dim, 4=jeu
  const daysUntilThursday = (4 - day + 7) % 7 || 7;
  d.setDate(d.getDate() + daysUntilThursday);
  return d;
}

function getDateFromURL() {
  const params = new URLSearchParams(window.location.search);
  const dateStr = params.get("date");
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const d = new Date(dateStr + "T00:00:00");
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

function setDateInURL(date) {
  const url = new URL(window.location);
  url.searchParams.set("date", toDateString(date));
  history.replaceState(null, "", url);
}

function getEventDate() {
  // Priority 1: URL parameter ?date=YYYY-MM-DD
  const urlDate = getDateFromURL();
  if (urlDate) return urlDate;

  // Priority 2: Static config
  const now = new Date();
  if (CONFIG.EVENT_DATE) {
    const configured = new Date(CONFIG.EVENT_DATE + "T00:00:00");
    const endOfEvent = new Date(configured);
    endOfEvent.setHours(24, 0, 0, 0);
    if (now > endOfEvent) {
      return getNextThursday(now);
    }
    return configured;
  }

  // Priority 3: Next Thursday
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (today.getDay() === 4) {
    return today;
  }
  return getNextThursday(now);
}

function formatDateFr(date) {
  const days = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];
  const months = ["janvier", "février", "mars", "avril", "mai", "juin",
    "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  return `${days[date.getDay()]} ${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

function toDateString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}


// ---- API Open-Meteo ----

async function fetchWeather(eventDate) {
  const dateStr = toDateString(eventDate);
  const url = `https://api.open-meteo.com/v1/forecast`
    + `?latitude=${CONFIG.LAT}&longitude=${CONFIG.LON}`
    + `&hourly=precipitation_probability,precipitation,temperature_2m`
    + `&daily=precipitation_probability_max,precipitation_sum`
    + `&timezone=Europe/Paris`
    + `&start_date=${dateStr}&end_date=${dateStr}`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`API error: ${resp.status}`);
  return resp.json();
}

function extractHourlySlots(data, startHour, endHour) {
  const hourly = data.hourly;
  const slots = [];
  for (let i = 0; i < hourly.time.length; i++) {
    const hour = new Date(hourly.time[i]).getHours();
    if (hour >= startHour && hour < endHour) {
      slots.push({
        time: hourly.time[i],
        hour,
        precipProb: hourly.precipitation_probability[i],
        precip: hourly.precipitation[i],
        temp: hourly.temperature_2m[i],
      });
    }
  }
  return slots;
}

function getDailyAvgPrecipProb(data) {
  const probs = data.hourly.precipitation_probability;
  if (!probs || probs.length === 0) return 0;
  return probs.reduce((sum, v) => sum + v, 0) / probs.length;
}

function getMaxPrecipProbOnSlots(slots) {
  if (slots.length === 0) return 0;
  return Math.max(...slots.map(s => s.precipProb));
}

function getAvgTempOnSlots(slots) {
  if (slots.length === 0) return null;
  return slots.reduce((sum, s) => sum + s.temp, 0) / slots.length;
}

const DRINK_THRESHOLD_TEMP = 15;

function getTempEmoji(temp) {
  if (temp >= 30) return "🔥";
  if (temp >= 25) return "🌡️";
  if (temp >= 20) return "☀️";
  if (temp >= 15) return "🌤️";
  if (temp >= 10) return "🌥️";
  if (temp >= 5) return "🧣";
  return "🥶";
}

const DRINK_CONFIG = {
  sangria:    { css: "sangria",   mood: "Chaud",  moodEmoji: "🥵", drinkEmoji: "🍹", name: "SANGRIA",   outfitEmoji: "🩳" },
  "vin-chaud": { css: "vin-chaud", mood: "Froid", moodEmoji: "🥶", drinkEmoji: "🍷", name: "VIN CHAUD", outfitEmoji: "🧥" },
};

function getDrinkRecommendation(slots) {
  const avgTemp = getAvgTempOnSlots(slots);
  if (avgTemp === null) return null;
  const drink = avgTemp >= DRINK_THRESHOLD_TEMP ? "sangria" : "vin-chaud";
  return { drink, avgTemp: Math.round(avgTemp * 10) / 10, ...DRINK_CONFIG[drink] };
}


// ---- Protocole de decision ----

const STATUS = {
  CONFIRMED: "confirmed",
  CANCELLED: "cancelled",
  WAITING: "waiting",
  LOADING: "loading",
  ERROR: "error",
};

function evaluateProtocol(eventDate, slots, data) {
  const now = new Date();
  const maxSlotProb = getMaxPrecipProbOnSlots(slots);
  const dailyAvgProb = getDailyAvgPrecipProb(data);

  // Pas de risque de pluie : c'est la fete !
  const hasRainRisk = maxSlotProb > CONFIG.THRESHOLD_SLOT_PERCENT
    || dailyAvgProb > CONFIG.THRESHOLD_DAILY_PERCENT;

  if (!hasRainRisk) {
    return {
      status: STATUS.CONFIRMED,
      icon: "🎉",
      text: "SOIRÉE MAINTENUE",
      detail: `Beau temps annoncé ! Max ${maxSlotProb}% de pluie sur le créneau.`,
      activeFlowNode: "flow-confirmed-direct",
    };
  }

  // Il y a un risque de pluie : on suit le calendrier
  const dayBefore = new Date(eventDate);
  dayBefore.setDate(dayBefore.getDate() - 1);
  dayBefore.setHours(20, 0, 0, 0);

  const dayOfCheck = new Date(eventDate);
  dayOfCheck.setHours(17, 0, 0, 0);

  // Avant la veille 20h
  if (now < dayBefore) {
    return {
      status: STATUS.WAITING,
      icon: "⏳",
      text: "EN ATTENTE",
      detail: `Risque de pluie détecté (${maxSlotProb}% sur le créneau). Décision la veille à 20h.`,
      activeFlowNode: "flow-wait1",
    };
  }

  // Après veille 20h : vérifier seuil 70% journée
  if (dailyAvgProb > CONFIG.THRESHOLD_DAILY_PERCENT) {
    return {
      status: STATUS.CANCELLED,
      icon: "☔",
      text: "SOIRÉE ANNULÉE",
      detail: `Probabilité de pluie sur la journée : ${Math.round(dailyAvgProb)}% (seuil : ${CONFIG.THRESHOLD_DAILY_PERCENT}%).`,
      activeFlowNode: "flow-cancel1",
    };
  }

  // Avant jour J 17h
  if (now < dayOfCheck) {
    return {
      status: STATUS.WAITING,
      icon: "⏳",
      text: "EN ATTENTE",
      detail: `Pluie possible (${maxSlotProb}% sur le créneau) mais journée OK (${Math.round(dailyAvgProb)}%). Confirmation jour J à 17h.`,
      activeFlowNode: "flow-wait2",
    };
  }

  // Jour J 17h+ : vérifier seuil 20% sur créneaux
  if (maxSlotProb > CONFIG.THRESHOLD_SLOT_PERCENT) {
    return {
      status: STATUS.CANCELLED,
      icon: "☔",
      text: "SOIRÉE ANNULÉE",
      detail: `Probabilité de pluie sur le créneau 20h-00h : ${maxSlotProb}% (seuil : ${CONFIG.THRESHOLD_SLOT_PERCENT}%).`,
      activeFlowNode: "flow-cancel2",
    };
  }

  // Tout est bon !
  return {
    status: STATUS.CONFIRMED,
    icon: "🎉",
    text: "SOIRÉE MAINTENUE",
    detail: `Pluie faible sur le créneau (${maxSlotProb}%). C'est parti !`,
    activeFlowNode: "flow-confirmed-final",
  };
}


// ---- Mise a jour du DOM ----

function updateStatusBanner(result) {
  const banner = document.getElementById("status-banner");
  const icon = document.getElementById("status-icon");
  const text = document.getElementById("status-text");
  const detail = document.getElementById("status-detail");
  const drinkEl = document.getElementById("status-drink");

  banner.className = "status-banner status-banner--" + result.status;
  icon.textContent = result.icon;
  text.textContent = result.text;
  detail.textContent = result.detail;

  if (drinkEl) {
    if (result.drink && result.status !== STATUS.ERROR && result.status !== STATUS.LOADING) {
      drinkEl.style.display = "block";
      const d = result.drink;
      drinkEl.className = "status-banner__drink status-banner__drink--" + d.css;
      drinkEl.innerHTML = `Il va faire <strong>${d.mood}</strong> ! (${d.avgTemp}°C) ${d.moodEmoji} → ${d.drinkEmoji} <strong>${d.name}</strong> ${d.outfitEmoji}`;
    } else {
      drinkEl.style.display = "none";
    }
  }
}

function updateWeatherGrid(slots) {
  const grid = document.getElementById("weather-grid");
  grid.innerHTML = "";

  if (slots.length === 0) {
    grid.innerHTML = '<p style="text-align:center;color:var(--text-light);">Pas de données disponibles pour ce créneau.</p>';
    return;
  }

  slots.forEach(slot => {
    const prob = slot.precipProb;
    let barClass = "weather-hour__bar--low";
    if (prob > 50) barClass = "weather-hour__bar--high";
    else if (prob > 20) barClass = "weather-hour__bar--medium";

    const el = document.createElement("div");
    el.className = "weather-hour";
    el.innerHTML = `
      <span class="weather-hour__time">${String(slot.hour).padStart(2, "0")}h</span>
      <div class="weather-hour__bar-container">
        <div class="weather-hour__bar ${barClass}" style="width: ${Math.max(prob, 2)}%"></div>
      </div>
      <span class="weather-hour__value">${prob}%</span>
      <span class="weather-hour__temp">${getTempEmoji(slot.temp)} ${Math.round(slot.temp)}°C</span>
    `;
    grid.appendChild(el);
  });
}

const FLOW_NODE_MAP = {
  "flow-confirmed-direct": "ConfirmedDirect",
  "flow-wait1": "Wait1",
  "flow-cancel1": "Cancel1",
  "flow-wait2": "Wait2",
  "flow-cancel2": "Cancel2",
  "flow-confirmed-final": "ConfirmedFinal",
};

const FLOW_PATHS = {
  "ConfirmedDirect": ["Start", "RainCheck", "ConfirmedDirect"],
  "Wait1": ["Start", "RainCheck", "Timeline", "Wait1"],
  "Cancel1": ["Start", "RainCheck", "Timeline", "Check70", "Cancel1"],
  "Wait2": ["Start", "RainCheck", "Timeline", "Check70", "BeforeJ", "Wait2"],
  "Cancel2": ["Start", "RainCheck", "Timeline", "Check70", "BeforeJ", "Check20", "Cancel2"],
  "ConfirmedFinal": ["Start", "RainCheck", "Timeline", "Check70", "BeforeJ", "Check20", "ConfirmedFinal"],
};

function dimAllFlowchartNodes() {
  document.querySelectorAll("#flowchart .flow-node, #drink-flowchart .flow-node").forEach(node => {
    node.classList.remove("flow-node--active", "flow-node--on-path");
    node.classList.add("flow-node--dimmed");
  });
}

function applyFlowHighlight(containerSelector, activeId, path) {
  document.querySelectorAll(containerSelector + " .flow-node").forEach(node => {
    const id = node.dataset.node;
    node.classList.remove("flow-node--active", "flow-node--dimmed", "flow-node--on-path");
    if (id === activeId) {
      node.classList.add("flow-node--active");
    } else if (path.includes(id)) {
      node.classList.add("flow-node--on-path");
    } else {
      node.classList.add("flow-node--dimmed");
    }
  });
}

function highlightFlowNode(activeNodeId) {
  const nodeId = FLOW_NODE_MAP[activeNodeId];
  if (!nodeId) {
    dimAllFlowchartNodes();
    return;
  }
  applyFlowHighlight("#flowchart", nodeId, FLOW_PATHS[nodeId] || []);
}

function highlightDrinkFlowchart(drinkResult) {
  if (!drinkResult) return;
  const activeDrink = drinkResult.drink === "sangria" ? "Sangria" : "VinChaud";
  applyFlowHighlight("#drink-flowchart", activeDrink, ["DrinkStart", "TempCheck", activeDrink]);
}

function updateLastRefresh() {
  const el = document.getElementById("last-refresh");
  const now = new Date();
  el.textContent = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}


// ---- Date picker UI ----

function setupDateUI(eventDate) {
  const display = document.getElementById("event-date-display");
  const changeBtn = document.getElementById("event-date-change");
  const picker = document.getElementById("event-date-picker");

  display.textContent = formatDateFr(eventDate);

  // Show change button if date was auto-computed (past or no config)
  const isAutoDate = !CONFIG.EVENT_DATE || (() => {
    const configured = new Date(CONFIG.EVENT_DATE + "T00:00:00");
    const endOfEvent = new Date(configured);
    endOfEvent.setHours(24, 0, 0, 0);
    return new Date() > endOfEvent;
  })();

  if (isAutoDate) {
    changeBtn.style.display = "inline-block";
  }

  changeBtn.addEventListener("click", () => {
    picker.style.display = picker.style.display === "none" ? "inline-block" : "none";
    picker.value = toDateString(eventDate);
  });

  picker.addEventListener("change", () => {
    if (picker.value) {
      const newDate = new Date(picker.value + "T00:00:00");
      picker.style.display = "none";
      display.textContent = formatDateFr(newDate);
      setDateInURL(newDate);
      loadWeatherAndDecide(newDate);
    }
  });
}


// ---- Main ----

let currentEventDate = null;

async function loadWeatherAndDecide(eventDate) {
  currentEventDate = eventDate;

  updateStatusBanner({
    status: STATUS.LOADING,
    icon: "⏳",
    text: "Chargement...",
    detail: "Récupération des données météo en cours.",
  });

  dimAllFlowchartNodes();

  try {
    const data = await fetchWeather(eventDate);
    const slots = extractHourlySlots(data, CONFIG.EVENT_START_HOUR, CONFIG.EVENT_END_HOUR);

    if (slots.length === 0) {
      updateStatusBanner({
        status: STATUS.ERROR,
        icon: "🤷",
        text: "PAS DE DONNÉES",
        detail: "Aucune prévision disponible pour cette date. Essayez une date plus proche.",
      });
      updateWeatherGrid(slots);
      updateLastRefresh();
      return;
    }

    const result = evaluateProtocol(eventDate, slots, data);
    result.drink = getDrinkRecommendation(slots);

    updateStatusBanner(result);
    updateWeatherGrid(slots);
    highlightFlowNode(result.activeFlowNode);
    highlightDrinkFlowchart(result.drink);
    updateLastRefresh();
  } catch (err) {
    console.error("Erreur météo:", err);
    updateStatusBanner({
      status: STATUS.ERROR,
      icon: "⚠️",
      text: "DONNÉES INDISPONIBLES",
      detail: "Impossible de récupérer la météo. Réessayez plus tard.",
    });
  }
}

async function init() {
  const eventDate = getEventDate();
  setDateInURL(eventDate);
  setupDateUI(eventDate);
  loadWeatherAndDecide(eventDate);

  // Auto-refresh with whichever date is currently selected
  setInterval(() => {
    if (currentEventDate) {
      loadWeatherAndDecide(currentEventDate);
    }
  }, CONFIG.REFRESH_INTERVAL_MS);
}

document.addEventListener("DOMContentLoaded", init);
