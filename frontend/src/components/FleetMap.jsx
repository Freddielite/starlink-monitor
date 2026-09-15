import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { BILLING_LABELS, BILLING_COLORS, HARDWARE_COLORS, dueLabel } from "../lib/kitDisplay.js";

// Leaflet + OpenStreetMap tiles. No API key, no billing account, no
// usage cap to breach at this traffic level - which is the entire
// reason for the choice over Google Maps. The visible cost is that the
// tiles look plainer, and that's the trade being made deliberately
// rather than discovered later.
//
// Leaflet's default marker icon is a bundled PNG whose path breaks
// under a bundler unless it's patched at import time - the classic
// "markers are invisible in production" bug. Everything here uses
// circleMarker and divIcon instead, which are drawn by Leaflet itself
// and have no asset to resolve, so that whole class of problem simply
// doesn't apply.

const TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
// Lagos, as the fallback view when there is nothing to fit the map to.
// Only ever seen on an empty fleet, so it just needs to be somewhere
// rather than the middle of the Atlantic that [0, 0] would give.
const FALLBACK_CENTER = [6.5244, 3.3792];
const FALLBACK_ZOOM = 6;

function pinColor(kit, colorBy) {
  if (colorBy === "hardware") return HARDWARE_COLORS[kit.hardware_state] || "var(--ink-faint)";
  return BILLING_COLORS[kit.billing_state] || "var(--ink-faint)";
}

// CSS custom properties can't be handed to Leaflet's canvas/SVG renderer
// as fill colours - it needs a real value, not a var() reference - so the
// palette is resolved off the document once here rather than being
// hardcoded a second time and drifting from App.css.
function resolveColor(value) {
  const match = /^var\((--[\w-]+)\)$/.exec(value);
  if (!match) return value;
  return getComputedStyle(document.documentElement).getPropertyValue(match[1]).trim() || "#7d938c";
}

export function FleetMap({ kits, colorBy = "billing", onSelect, height = 420 }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  // onSelect is read through a ref inside the popup handler so that a
  // parent re-render with a new callback identity doesn't require
  // tearing down and rebuilding every marker.
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;

  useEffect(() => {
    if (mapRef.current) return;
    const map = L.map(containerRef.current, {
      center: FALLBACK_CENTER,
      zoom: FALLBACK_ZOOM,
      // The app disables text selection and the iOS callout globally for
      // a native feel (see App.css), and a map that also scroll-zooms
      // whenever the page scrolls past it fights the user rather than
      // helping. Zoom stays on the controls and on pinch.
      scrollWheelZoom: false,
    });
    L.tileLayer(TILE_URL, { attribution: TILE_ATTRIBUTION, maxZoom: 19 }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();

    const located = kits.filter((k) => k.latitude != null && k.longitude != null);
    for (const kit of located) {
      const marker = L.circleMarker([Number(kit.latitude), Number(kit.longitude)], {
        radius: 9,
        weight: 2,
        color: resolveColor(pinColor(kit, colorBy)),
        fillColor: resolveColor(pinColor(kit, colorBy)),
        fillOpacity: 0.55,
      });
      marker.bindPopup(popupHtml(kit));
      marker.on("popupopen", (e) => {
        const button = e.popup.getElement()?.querySelector("[data-open-kit]");
        if (button) button.onclick = () => selectRef.current?.(kit);
      });
      layer.addLayer(marker);
    }

    if (located.length > 0) {
      const bounds = L.latLngBounds(located.map((k) => [Number(k.latitude), Number(k.longitude)]));
      // padding stops a single-kit fleet from zooming to street level,
      // and maxZoom keeps a tight cluster readable rather than filling
      // the frame with one building.
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 13 });
    } else {
      map.setView(FALLBACK_CENTER, FALLBACK_ZOOM);
    }
    // Leaflet measures its container on creation; if the map was first
    // rendered inside a hidden tab it will have measured zero and drawn
    // a sliver. Re-measuring whenever the data changes covers the common
    // case of switching to the map tab for the first time.
    setTimeout(() => map.invalidateSize(), 0);
  }, [kits, colorBy]);

  const unlocated = kits.filter((k) => k.latitude == null || k.longitude == null).length;

  return (
    <div>
      <div ref={containerRef} className="sl-map" style={{ height }} />
      {unlocated > 0 && (
        // Stated rather than silently omitted: a map that quietly drops
        // kits with no coordinates is a map that lies about fleet size,
        // and "why isn't Ikeja on here" is a much worse question to have
        // to answer later than a line of text now.
        <div className="sl-map__note">
          {unlocated} kit{unlocated === 1 ? "" : "s"} not shown - no coordinates set yet.
        </div>
      )}
    </div>
  );
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]));
}

function popupHtml(kit) {
  const where = [kit.city, kit.region].filter(Boolean).join(", ");
  return `<div class="sl-map-popup">
    <div class="sl-map-popup__name">${escapeHtml(kit.name)}</div>
    ${kit.client_name ? `<div class="sl-map-popup__client">${escapeHtml(kit.client_name)}</div>` : ""}
    <div class="sl-map-popup__row">${escapeHtml(BILLING_LABELS[kit.billing_state] || kit.billing_state)} · ${escapeHtml(dueLabel(kit))}</div>
    <div class="sl-map-popup__row">Hardware: ${escapeHtml(kit.hardware_state)}</div>
    ${where ? `<div class="sl-map-popup__row">${escapeHtml(where)}</div>` : ""}
    <button type="button" data-open-kit class="sl-map-popup__btn">Open kit</button>
  </div>`;
}

// Single draggable pin, used in the kit form to confirm (or correct) a
// geocoded location before it's saved. This is the part that makes
// Nominatim's weaker precision survivable: a result that's confidently
// pointing at the wrong end of the city is obvious the moment it's a pin
// on a map, and dragging it is a faster fix than typing coordinates.
export function LocationPicker({ latitude, longitude, onChange, height = 220 }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  useEffect(() => {
    if (mapRef.current) return;
    const start = latitude != null && longitude != null ? [Number(latitude), Number(longitude)] : FALLBACK_CENTER;
    const map = L.map(containerRef.current, { center: start, zoom: latitude != null ? 13 : 5, scrollWheelZoom: false });
    L.tileLayer(TILE_URL, { attribution: TILE_ATTRIBUTION, maxZoom: 19 }).addTo(map);
    // Tapping the map moves the pin as well as dragging it - on a phone,
    // dragging a small circle is fiddly and a tap is not.
    map.on("click", (e) => changeRef.current?.(round(e.latlng.lat), round(e.latlng.lng)));
    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 0);
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (latitude == null || longitude == null) {
      if (markerRef.current) {
        markerRef.current.remove();
        markerRef.current = null;
      }
      return;
    }
    const position = [Number(latitude), Number(longitude)];
    if (!markerRef.current) {
      markerRef.current = L.circleMarker(position, {
        radius: 10,
        weight: 2,
        color: resolveColor("var(--signal)"),
        fillColor: resolveColor("var(--signal)"),
        fillOpacity: 0.5,
      }).addTo(map);
    } else {
      markerRef.current.setLatLng(position);
    }
    map.setView(position, Math.max(map.getZoom(), 12));
  }, [latitude, longitude]);

  return <div ref={containerRef} className="sl-map" style={{ height }} />;
}

// Six decimal places is about 11cm - far past anything this needs, and
// it matches the NUMERIC(9,6) the column is declared as, so what's shown
// in the form is exactly what gets stored rather than being silently
// rounded on save.
function round(value) {
  return Number(Number(value).toFixed(6));
}

export default FleetMap;
