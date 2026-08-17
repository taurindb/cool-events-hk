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

const CATEGORY_GLYPHS = {
  music: "♪",
  arts: "◈",
  film: "▶",
  food: "◉",
  market: "❋",
  sport: "▲",
  nightlife: "◐",
  talk: "❝",
  festival: "✦",
  community: "❖",
  other: "✳",
};

// Event times in events.json are local Hong Kong wall-clock, written without a
// timezone. Anchoring them to +08:00 keeps the site and its calendar exports
// correct for a reader in any timezone, not just one sitting in Hong Kong.
const HK_TZ = "Asia/Hong_Kong";
const HK_OFFSET = "+08:00";
const hkDayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: HK_TZ, year: "numeric", month: "2-digit", day: "2-digit",
});
const dayFmt = new Intl.DateTimeFormat("en-HK", {
  timeZone: HK_TZ, weekday: "short", day: "numeric", month: "short",
});
const timeFmt = new Intl.DateTimeFormat("en-HK", {
  timeZone: HK_TZ, hour: "numeric", minute: "2-digit",
});

const prefersDark = matchMedia("(prefers-color-scheme: dark)");

const state = {
  events: [],
  when: "upcoming",
  category: "all",
  freeOnly: false,
  query: "",
  // Inclusive epoch-day numbers, counted in Hong Kong. Both null means the
  // calendar is not filtering and the date chips are in charge.
  rangeStart: null,
  rangeEnd: null,
  calendarMonth: null, // { y, m } — m is 0-indexed
};

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
  calTitle: document.getElementById("cal-title"),
  calGrid: document.querySelector(".cal-grid"),
  calClear: document.querySelector(".cal-clear"),
  calHint: document.getElementById("cal-hint"),
};

// Only same-origin relative paths and http(s) links are ever rendered.
function safeUrl(url) {
  if (typeof url !== "string" || url === "") return null;
  try {
    const parsed = new URL(url, location.href);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function parseHK(value) {
  if (typeof value !== "string" || !value) return null;
  const stamped = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : value + HK_OFFSET;
  const d = new Date(stamped);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Whole days since the epoch, counted in Hong Kong, so date comparisons never
// straddle a midnight in the reader's own timezone.
//
// Read through formatToParts rather than splitting a formatted string: the
// exact output of a locale is not contractual, and a browser that formatted
// en-CA as anything but YYYY-MM-DD would turn every date into NaN and silently
// empty the entire listing.
function hkDay(date) {
  const parts = hkDayFmt.formatToParts(date);
  let y = NaN, m = NaN, d = NaN;
  for (const part of parts) {
    if (part.type === "year") y = Number(part.value);
    else if (part.type === "month") m = Number(part.value);
    else if (part.type === "day") d = Number(part.value);
  }
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return NaN;
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

// Epoch-day numbers are just integers, so they convert back through UTC.
function dayToYMD(n) {
  const d = new Date(n * 86400000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() };
}
function ymdToDay(y, m, d) {
  return Math.round(Date.UTC(y, m, d) / 86400000);
}
// Epoch day 0 was a Thursday; 0 = Sunday.
function dayOfWeek(n) { return (n + 4) % 7; }

function eventDate(ev) { return parseHK(ev.start); }
function eventEnd(ev) { return parseHK(ev.end) || parseHK(ev.start); }

// The inclusive span of days an event occupies, or null if undated.
function eventSpan(ev) {
  const start = eventDate(ev);
  if (!start) return null;
  const from = hkDay(start);
  const to = hkDay(eventEnd(ev));
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return { from, to: Math.max(from, to) };
}

function matchesWhen(ev, now) {
  // A calendar selection takes over from the date chips entirely.
  if (state.rangeStart !== null) {
    const span = eventSpan(ev);
    if (!span) return true; // fail open on undated events
    const end = state.rangeEnd ?? state.rangeStart;
    return span.from <= end && span.to >= state.rangeStart;
  }

  if (state.when === "all") return true;
  const start = eventDate(ev);
  if (!start) return false;

  const today = hkDay(now);
  const from = hkDay(start) - today;
  const to = hkDay(eventEnd(ev)) - today;

  // Fail open. If a date can't be resolved, showing an event that may be out of
  // range beats hiding the whole listing behind a silent NaN.
  if (!Number.isFinite(from) || !Number.isFinite(to)) return true;

  if (to < 0) return false; // finished before today
  if (state.when === "upcoming") return true;

  // A run of several days counts as matching if any of it falls in the window.
  const overlaps = (a, b) => from <= b && to >= a;
  if (state.when === "today") return overlaps(0, 0);
  if (state.when === "week") return overlaps(0, 7);
  if (state.when === "weekend") {
    const dow = (today + 4) % 7; // epoch day 0 was a Thursday; 0 = Sunday
    const toFriday = (5 - dow + 7) % 7;
    return overlaps(toFriday, toFriday + 2);
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

function isMultiDay(ev) {
  const start = eventDate(ev), end = parseHK(ev.end);
  return Boolean(start && end && hkDay(end) > hkDay(start));
}

function formatWhen(ev) {
  const start = eventDate(ev);
  if (!start) return ev.dateText || "Date to be confirmed";
  if (isMultiDay(ev)) return `${dayFmt.format(start)} – ${dayFmt.format(parseHK(ev.end))}`;
  let out = dayFmt.format(start);
  if (ev.hasTime !== false) out += ` · ${timeFmt.format(start)}`;
  return out;
}

/* ---------- Calendar export ---------- */

const pad = (n) => String(n).padStart(2, "0");

function utcStamp(date) {
  return date.getUTCFullYear() + pad(date.getUTCMonth() + 1) + pad(date.getUTCDate())
    + "T" + pad(date.getUTCHours()) + pad(date.getUTCMinutes()) + pad(date.getUTCSeconds()) + "Z";
}

function hkDateStamp(date) {
  return hkDayFmt.format(date).replace(/-/g, "");
}

// A run across several days becomes an all-day span rather than one long block
// sitting in the reader's calendar from Friday night to Sunday evening.
// All-day end dates are exclusive in both iCalendar and Google Calendar.
function calendarWindow(ev) {
  const start = eventDate(ev);
  if (!start) return null;
  const end = parseHK(ev.end);
  if (end && hkDay(end) > hkDay(start)) {
    return { allDay: true, start, end: new Date(end.getTime() + 86400000) };
  }
  return { allDay: false, start, end: end || new Date(start.getTime() + 2 * 3600000) };
}

function calendarDetails(ev) {
  const description = [ev.summary, ev.links?.official, ev.links?.tickets]
    .filter(Boolean).join("\n\n");
  const location = [ev.venue?.name, ev.venue?.address].filter(Boolean).join(", ");
  return { description, location };
}

function googleCalendarUrl(ev) {
  const win = calendarWindow(ev);
  if (!win) return null;
  const dates = win.allDay
    ? `${hkDateStamp(win.start)}/${hkDateStamp(win.end)}`
    : `${utcStamp(win.start)}/${utcStamp(win.end)}`;
  const { description, location } = calendarDetails(ev);
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: ev.title || "Event",
    dates,
    ctz: HK_TZ,
  });
  if (description) params.set("details", description);
  if (location) params.set("location", location);
  return `https://calendar.google.com/calendar/render?${params}`;
}

const icsEscape = (s) => String(s)
  .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

// RFC 5545 caps content lines at 75 octets; continuations start with a space.
// Counted in UTF-8 bytes, not characters — accented names and dashes cost more
// than one byte each — and split on code points so no character is cut in half.
const utf8 = new TextEncoder();
function icsFold(line) {
  const parts = [];
  let current = "";
  let bytes = 0;
  for (const ch of line) {
    const size = utf8.encode(ch).length;
    if (bytes + size > 75) {
      parts.push(current);
      current = " " + ch;
      bytes = 1 + size;
    } else {
      current += ch;
      bytes += size;
    }
  }
  parts.push(current);
  return parts.join("\r\n");
}

function buildIcs(ev) {
  const win = calendarWindow(ev);
  if (!win) return null;
  const { description, location } = calendarDetails(ev);
  const url = safeUrl(ev.links?.official || ev.links?.tickets);

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//What's On HK//Events//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${ev.id || "event"}@whats-on-hk`,
    `DTSTAMP:${utcStamp(new Date())}`,
    ...(win.allDay
      ? [`DTSTART;VALUE=DATE:${hkDateStamp(win.start)}`, `DTEND;VALUE=DATE:${hkDateStamp(win.end)}`]
      : [`DTSTART:${utcStamp(win.start)}`, `DTEND:${utcStamp(win.end)}`]),
    `SUMMARY:${icsEscape(ev.title || "Event")}`,
  ];
  if (description) lines.push(`DESCRIPTION:${icsEscape(description)}`);
  if (location) lines.push(`LOCATION:${icsEscape(location)}`);
  if (url) lines.push(`URL:${url}`);
  lines.push("END:VEVENT", "END:VCALENDAR");

  return lines.map(icsFold).join("\r\n") + "\r\n";
}

function downloadIcs(ev) {
  const ics = buildIcs(ev);
  if (!ics) return;
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${ev.id || "event"}.ics`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ---------- Rendering ---------- */

// Events without a flyer photo get a generated header instead of a blank box.
// The hue is derived from the id, so a given event always looks the same.
// Hue comes from the category rather than a hash of the id, so colour means
// something — every gig reads violet, every talk warm — and two events off the
// same flyer can't land on accidentally identical shades. The id only supplies
// a small jitter so same-category cards aren't carbon copies.
const CATEGORY_HUES = {
  music: 275, arts: 330, film: 220, food: 25, market: 150, sport: 195,
  nightlife: 255, talk: 12, festival: 300, community: 95, other: 210,
};

function gradientFor(ev) {
  const id = ev.id || ev.title || "event";
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h = (h ^ (h >>> 15)) >>> 0;

  const base = CATEGORY_HUES[ev.category] ?? CATEGORY_HUES.other;
  const hue = (base + (h % 25) - 12 + 360) % 360;
  const partner = (hue + 34) % 360;
  return `linear-gradient(135deg, hsl(${hue} 58% 46%), hsl(${partner} 62% 32%))`;
}

function buildCard(ev) {
  const card = els.tpl.content.cloneNode(true);
  const media = card.querySelector(".card-media");
  const img = card.querySelector(".card-media img");
  const art = card.querySelector(".card-art");
  const glyph = card.querySelector(".card-glyph");
  const badge = card.querySelector(".badge-price");
  const titleLink = card.querySelector(".card-title a");
  const primaryLink = safeUrl(ev.links?.tickets || ev.links?.official);

  if (ev.image) {
    img.src = safeUrl(ev.image) || ev.image;
    img.alt = ev.imageAlt || `Promotional image for ${ev.title}`;
    art.remove();
    glyph.remove();
  } else {
    img.remove();
    // Gradient and glyph go down first so there is always something to look at
    // if WebGL is unavailable; the artwork paints over them when it succeeds.
    media.style.backgroundImage = gradientFor(ev);
    glyph.textContent = CATEGORY_GLYPHS[ev.category] || CATEGORY_GLYPHS.other;

    const painted = window.EventArtwork?.attach(
      art, `${ev.id || ""}${ev.title || ""}`, ev.category || "other"
    );
    if (painted) glyph.remove();
    else art.remove();
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

  badge.textContent = ev.price?.isFree ? "Free" : (ev.price?.text || "Price TBC");
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

  const cal = card.querySelector(".card-cal");
  const gcal = googleCalendarUrl(ev);
  if (gcal) {
    cal.querySelector(".cal-google").href = gcal;
    cal.querySelector(".cal-ics").dataset.ics = ev.id || "";
  } else {
    cal.remove();
  }

  return card;
}

function render() {
  const list = visibleEvents();
  // Drop the old canvases from the animation registry before the cards holding
  // them are thrown away, or the loop keeps painting into detached nodes.
  window.EventArtwork?.reset();
  els.grid.replaceChildren(...list.map(buildCard));
  els.empty.hidden = list.length > 0;
  els.empty.textContent = state.events.length
    ? "Nothing matches those filters yet. Try widening the date range."
    : "No events listed yet — check back soon.";
  els.count.textContent = list.length
    ? `${list.length} event${list.length === 1 ? "" : "s"}`
    : "";
}

/* ---------- Calendar ---------- */

const monthFmt = new Intl.DateTimeFormat("en-HK", { month: "long", year: "numeric", timeZone: "UTC" });

// Every day that any event touches, so multi-day runs mark their whole span.
function daysWithEvents() {
  const days = new Set();
  for (const ev of state.events) {
    const span = eventSpan(ev);
    if (!span) continue;
    for (let d = span.from; d <= span.to; d++) days.add(d);
  }
  return days;
}

function buildCalendar() {
  if (!els.calGrid) return;

  const today = hkDay(new Date());
  if (!state.calendarMonth) {
    const { y, m } = dayToYMD(today);
    state.calendarMonth = { y, m };
  }

  const { y, m } = state.calendarMonth;
  els.calTitle.textContent = monthFmt.format(new Date(Date.UTC(y, m, 1)));

  const marked = daysWithEvents();
  const first = ymdToDay(y, m, 1);
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const leading = (dayOfWeek(first) + 6) % 7; // Monday-first grid

  const cells = [];
  for (let i = 0; i < leading; i++) {
    const filler = document.createElement("span");
    filler.className = "cal-cell is-empty";
    cells.push(filler);
  }

  const selEnd = state.rangeEnd ?? state.rangeStart;

  for (let date = 1; date <= daysInMonth; date++) {
    const dayNum = ymdToDay(y, m, date);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cal-cell";
    btn.dataset.day = String(dayNum);
    btn.textContent = String(date);

    const has = marked.has(dayNum);
    if (has) btn.classList.add("has-events");
    if (dayNum === today) btn.classList.add("is-today");

    if (state.rangeStart !== null && dayNum >= state.rangeStart && dayNum <= selEnd) {
      btn.classList.add("in-range");
      if (dayNum === state.rangeStart) btn.classList.add("is-start");
      if (dayNum === selEnd) btn.classList.add("is-end");
      btn.setAttribute("aria-pressed", "true");
    } else {
      btn.setAttribute("aria-pressed", "false");
    }

    const { y: ty, m: tm, d: td } = dayToYMD(dayNum);
    const label = new Intl.DateTimeFormat("en-HK", {
      weekday: "long", day: "numeric", month: "long", timeZone: "UTC",
    }).format(new Date(Date.UTC(ty, tm, td)));
    btn.setAttribute("aria-label", has ? `${label} — has events` : label);

    cells.push(btn);
  }

  els.calGrid.replaceChildren(...cells);
  els.calClear.hidden = state.rangeStart === null;
  updateCalendarHint();
}

function updateCalendarHint() {
  if (!els.calHint) return;
  if (state.rangeStart === null) {
    els.calHint.textContent = "Pick a day, or a start and end day, to filter the list.";
    return;
  }
  const fmt = (n) => {
    const { y, m, d } = dayToYMD(n);
    return new Intl.DateTimeFormat("en-HK", {
      day: "numeric", month: "short", timeZone: "UTC",
    }).format(new Date(Date.UTC(y, m, d)));
  };
  els.calHint.textContent = state.rangeEnd === null || state.rangeEnd === state.rangeStart
    ? `Showing ${fmt(state.rangeStart)}. Pick another day for a range.`
    : `Showing ${fmt(state.rangeStart)} – ${fmt(state.rangeEnd)}.`;
}

function clearRange() {
  state.rangeStart = null;
  state.rangeEnd = null;
}

function pickDay(dayNum) {
  if (state.rangeStart === null || state.rangeEnd !== null) {
    // Nothing selected, or a complete range — start a new one.
    state.rangeStart = dayNum;
    state.rangeEnd = null;
  } else if (dayNum === state.rangeStart) {
    clearRange(); // tapping the same day again deselects
  } else {
    // Read the anchor before writing, or the max below sees the new min.
    const anchor = state.rangeStart;
    state.rangeStart = Math.min(anchor, dayNum);
    state.rangeEnd = Math.max(anchor, dayNum);
  }

  // The chips and the calendar are two views of the same filter, so light the
  // chips down while a date selection is active.
  syncWhenChips();
  buildCalendar();
  render();
}

function syncWhenChips() {
  const active = state.rangeStart === null;
  for (const chip of els.whenFilters.querySelectorAll(".chip")) {
    chip.classList.toggle("is-active", active && chip.dataset.when === state.when);
    chip.classList.toggle("is-dimmed", !active);
  }
}

function wireCalendar() {
  if (!els.calGrid) return;

  els.calGrid.addEventListener("click", (e) => {
    const cell = e.target.closest(".cal-cell[data-day]");
    if (!cell) return;
    pickDay(Number(cell.dataset.day));
  });

  for (const nav of document.querySelectorAll(".cal-nav")) {
    nav.addEventListener("click", () => {
      const step = Number(nav.dataset.step);
      const { y, m } = state.calendarMonth;
      const shifted = new Date(Date.UTC(y, m + step, 1));
      state.calendarMonth = { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() };
      buildCalendar();
    });
  }

  els.calClear.addEventListener("click", () => {
    clearRange();
    syncWhenChips();
    buildCalendar();
    render();
  });
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
      other.classList.remove("is-dimmed");
    }
    // Choosing a date chip means giving up any calendar selection; leaving both
    // active would show two contradictory date filters at once.
    if (key === "when" && state.rangeStart !== null) {
      clearRange();
      buildCalendar();
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
  // The artwork bakes the light or dark palette in when it paints, so the cards
  // have to be rebuilt when the reader's system flips between them.
  prefersDark.addEventListener("change", render);

  els.grid.addEventListener("click", (e) => {
    const btn = e.target.closest(".cal-ics");
    if (!btn) return;
    const ev = state.events.find((x) => x.id === btn.dataset.ics);
    if (ev) downloadIcs(ev);
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
        : new Intl.DateTimeFormat("en-HK", { day: "numeric", month: "long", year: "numeric", timeZone: HK_TZ }).format(d);
    }
  } catch (err) {
    els.empty.hidden = false;
    els.empty.textContent = "Could not load the event list right now. Please refresh in a moment.";
    console.error("Failed to load events.json:", err);
    return;
  }

  buildCategoryFilters();
  wireCalendar();
  buildCalendar();
  render();
}

init();
