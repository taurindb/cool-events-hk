const CATEGORY_LABELS = {
  music: "Music",
  arts: "Arts & exhibitions",
  film: "Film",
  food: "Food & drink",
  market: "Markets",
  sport: "Sport & outdoors",
  nightlife: "Nightlife",
  talk: "Talks & workshops",
  festival: "Festivals",
  community: "Community",
  other: "Other",
};

const state = { events: [], when: "upcoming", category: "all", freeOnly: false, query: "" };

const els = {
  grid: document.getElementById("events"),
  empty: document.getElementById("empty"),
  count: document.getElementById("count"),
  updated: document.getElementById("updated"),
  search: document.getElementById("search"),
  freeOnly: document.getElementById("free-only"),
  whenFilters: document.getElementById("when-filters"),
  catFilters: document.getElementById("cat-filters"),
  tpl: document.getElementById("card-tpl"),
};

// Only same-origin relative paths and https links are ever rendered.
function safeUrl(url) {
  if (typeof url !== "string" || url === "") return null;
  try {
    const parsed = new URL(url, location.href);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function startOfDay(d) {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function eventDate(ev) {
  const d = new Date(ev.start);
  return Number.isNaN(d.getTime()) ? null : d;
}

// An event stays listed until the end of the day it finishes on.
function isOver(ev, now) {
  const end = new Date(ev.end || ev.start);
  if (Number.isNaN(end.getTime())) return false;
  return startOfDay(end) < startOfDay(now);
}

function matchesWhen(ev, now) {
  if (state.when === "all") return true;
  const start = eventDate(ev);
  if (!start) return state.when === "all";
  if (isOver(ev, now)) return false;
  if (state.when === "upcoming") return true;

  const today = startOfDay(now);
  const day = startOfDay(start);
  const daysOut = Math.round((day - today) / 86400000);

  if (state.when === "today") return daysOut === 0;
  if (state.when === "week") return daysOut >= 0 && daysOut <= 7;
  if (state.when === "weekend") {
    // Friday through Sunday of the current week.
    const dow = now.getDay();
    const daysToFriday = (5 - dow + 7) % 7;
    return daysOut >= 0 && daysOut >= daysToFriday && daysOut <= daysToFriday + 2;
  }
  return true;
}

function matchesQuery(ev) {
  if (!state.query) return true;
  const haystack = [
    ev.title,
    ev.summary,
    ev.venue?.name,
    ev.venue?.district,
    ev.venue?.address,
    CATEGORY_LABELS[ev.category] || ev.category,
  ].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(state.query);
}

function isFreeish(ev) {
  return Boolean(ev.price?.isFree || ev.price?.studentDiscount);
}

function visibleEvents() {
  const now = new Date();
  return state.events
    .filter((ev) => matchesWhen(ev, now))
    .filter((ev) => state.category === "all" || ev.category === state.category)
    .filter((ev) => !state.freeOnly || isFreeish(ev))
    .filter(matchesQuery)
    .sort((a, b) => {
      const da = eventDate(a), db = eventDate(b);
      if (!da) return 1;
      if (!db) return -1;
      return da - db;
    });
}

function formatWhen(ev) {
  const start = eventDate(ev);
  if (!start) return ev.dateText || "Date to be confirmed";

  const dayFmt = new Intl.DateTimeFormat("en-HK", { weekday: "short", day: "numeric", month: "short" });
  const timeFmt = new Intl.DateTimeFormat("en-HK", { hour: "numeric", minute: "2-digit" });
  let out = dayFmt.format(start);

  if (ev.end) {
    const end = new Date(ev.end);
    if (!Number.isNaN(end.getTime()) && startOfDay(end) > startOfDay(start)) {
      out += ` – ${dayFmt.format(end)}`;
      return out;
    }
  }
  if (ev.hasTime !== false) out += ` · ${timeFmt.format(start)}`;
  return out;
}

function buildCard(ev) {
  const card = els.tpl.content.cloneNode(true);
  const media = card.querySelector(".card-media");
  const img = card.querySelector(".card-media img");
  const badge = card.querySelector(".badge-price");
  const titleLink = card.querySelector(".card-title a");
  const primaryLink = safeUrl(ev.links?.tickets || ev.links?.official);

  const imgSrc = safeUrl(ev.image) || ev.image;
  if (ev.image) {
    img.src = imgSrc;
    img.alt = ev.imageAlt || `Promotional image for ${ev.title}`;
  } else {
    img.remove();
  }

  const title = ev.title || "Untitled event";
  if (primaryLink) {
    media.href = primaryLink;
    titleLink.href = primaryLink;
    titleLink.textContent = title;
  } else {
    media.removeAttribute("href");
    titleLink.replaceWith(document.createTextNode(title));
  }

  const priceText = ev.price?.isFree ? "Free" : (ev.price?.text || "Price TBC");
  badge.textContent = priceText;
  badge.classList.toggle("is-free", Boolean(ev.price?.isFree));

  card.querySelector(".card-when time").textContent = formatWhen(ev);
  const summary = card.querySelector(".card-summary");
  if (ev.summary) summary.textContent = ev.summary;
  else summary.remove();

  const venue = card.querySelector(".card-venue");
  const venueBits = [ev.venue?.name, ev.venue?.district].filter(Boolean);
  if (venueBits.length) venue.textContent = `📍 ${venueBits.join(", ")}`;
  else venue.remove();

  const tags = card.querySelector(".card-tags");
  const tagList = [];
  if (ev.category) tagList.push({ text: CATEGORY_LABELS[ev.category] || ev.category, cls: "" });
  if (ev.price?.studentDiscount) tagList.push({ text: `🎓 ${ev.price.studentDiscount}`, cls: "tag-student" });
  if (ev.needsCheck) tagList.push({ text: "Details unconfirmed", cls: "tag-unverified" });
  for (const tag of tagList) {
    const li = document.createElement("li");
    li.textContent = tag.text;
    if (tag.cls) li.className = tag.cls;
    tags.append(li);
  }
  if (!tagList.length) tags.remove();

  const links = card.querySelector(".card-links");
  const linkDefs = [
    { url: ev.links?.tickets, label: "Get tickets →" },
    { url: ev.links?.official, label: "Event info →" },
    { url: ev.venue?.mapUrl, label: "Map →" },
  ];
  for (const def of linkDefs) {
    const href = safeUrl(def.url);
    if (!href) continue;
    const a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = def.label;
    links.append(a);
  }
  if (!links.children.length) links.remove();

  return card;
}

function render() {
  const list = visibleEvents();
  els.grid.replaceChildren(...list.map(buildCard));
  els.empty.hidden = list.length > 0;
  els.empty.textContent = state.events.length
    ? "Nothing matches those filters yet. Try widening the date range."
    : "No events listed yet — check back soon.";
  els.count.textContent = list.length
    ? `${list.length} event${list.length === 1 ? "" : "s"}`
    : "";
}

function buildCategoryFilters() {
  const present = [...new Set(state.events.map((ev) => ev.category).filter(Boolean))];
  present.sort((a, b) => (CATEGORY_LABELS[a] || a).localeCompare(CATEGORY_LABELS[b] || b));

  const makeChip = (value, label, active) => {
    const btn = document.createElement("button");
    btn.className = active ? "chip is-active" : "chip";
    btn.dataset.category = value;
    btn.textContent = label;
    return btn;
  };

  els.catFilters.replaceChildren(
    makeChip("all", "All types", true),
    ...present.map((c) => makeChip(c, CATEGORY_LABELS[c] || c, false))
  );
}

function wireChipRow(container, key, prop) {
  container.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    state[key] = chip.dataset[prop];
    for (const other of container.querySelectorAll(".chip")) {
      other.classList.toggle("is-active", other === chip);
    }
    render();
  });
}

async function init() {
  wireChipRow(els.whenFilters, "when", "when");
  wireChipRow(els.catFilters, "category", "category");

  els.search.addEventListener("input", () => {
    state.query = els.search.value.trim().toLowerCase();
    render();
  });
  els.freeOnly.addEventListener("change", () => {
    state.freeOnly = els.freeOnly.checked;
    render();
  });

  try {
    const res = await fetch("data/events.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.events = Array.isArray(data.events) ? data.events : [];
    if (data.updated) {
      els.updated.dateTime = data.updated;
      const d = new Date(data.updated);
      els.updated.textContent = Number.isNaN(d.getTime())
        ? data.updated
        : new Intl.DateTimeFormat("en-HK", { day: "numeric", month: "long", year: "numeric" }).format(d);
    }
  } catch (err) {
    els.empty.hidden = false;
    els.empty.textContent = "Could not load the event list right now. Please refresh in a moment.";
    console.error("Failed to load events.json:", err);
    return;
  }

  buildCategoryFilters();
  render();
}

init();
