<script lang="ts">
  import { onMount } from 'svelte';
  import L from 'leaflet';

  // Endepunkter
  const STATIONS_ENDPOINT = '/api/stations'; // proxy til apim.unox.no
  const GEOCODE_ENDPOINT = '/api/geocode';   // proxy til Nominatim

  type AnyStation = Record<string, any>;

  let mapEl: HTMLDivElement | null = null;
  let map!: L.Map;

  // Lag
  let markersGroup: L.LayerGroup | null = null;
  let initRing: L.Circle | null = null;
  let searchMarker: L.Marker | L.CircleMarker | null = null;

  // Data/state
  let stations: AnyStation[] = [];
  let loading = false;
  let errorMsg = '';
  let visibleCount = 0;

  // Søk
  let q = '';
  let results: any[] = [];
  let searching = false;
  let showList = false;
  let activeIndex = -1;
  let searchTimer: any;

  // ✅ Kun type‑filtre (skjul når på)
  let typeFilter = {
    hideWash: false,
    hideSelfservice: false,
    hideTruck: false,
    hideChargingLocation: false
  };

  /* ---------- Normalisering & hjelp ---------- */

  function toNumber(n: unknown): number | null {
    if (typeof n === 'number') return Number.isFinite(n) ? n : null;
    if (typeof n === 'string') {
      const s = n.replace(',', '.');
      const v = Number(s);
      return Number.isFinite(v) ? v : null;
    }
    return null;
  }
  function eqType(a: unknown, b: string) {
    if (a == null) return false;
    return String(a).trim().toLowerCase() === b.toLowerCase();
  }

  function normalizeStation(s: AnyStation) {
    const name =
      s?.station?.name ?? s?.name ?? s?.title ?? s?.stationName ?? 'Ukjent stasjon';

    const g = s?.station?.geolocation ?? s?.geolocation ?? s?.geo ?? s ?? {};
    const lat =
      toNumber(g.latitude ?? g.lat ?? g.Latitude ?? g.Lat ?? s?.lat ?? s?.Latitude);
    const lng =
      toNumber(g.longitude ?? g.lng ?? g.Longitude ?? g.Lng ?? s?.lng ?? s?.Longitude);

    const lastUpdated =
      s?.lastUpdated ?? s?.updatedAt ?? s?.modified ?? s?.lastModified ?? new Date().toISOString();

    const stationType = s?.station?.stationType ?? s?.stationType ?? null;

    return { name, lat, lng, lastUpdated, stationType };
  }

  // Farger
  const YELLOW = { stroke: '#f57f17', fill: '#fbc02d' }; // amber
  const RED    = { stroke: '#b71c1c', fill: '#f44336' }; // red

  function colorForType(stationType: string | null | undefined) {
    if (!stationType) return RED;
    const t = String(stationType).toLowerCase();
    if (t === 'charginglocation' || t === 'truck' || t === 'selfservice' || t === 'wash') {
      return YELLOW; // gule som avtalt
    }
    return RED;
  }

  // Kun type-hide logikk
  function passesTypeHide(n: ReturnType<typeof normalizeStation>) {
    if (typeFilter.hideWash && eqType(n.stationType, 'wash')) return false;
    if (typeFilter.hideSelfservice && eqType(n.stationType, 'selfservice')) return false;
    if (typeFilter.hideTruck && eqType(n.stationType, 'truck')) return false;
    if (typeFilter.hideChargingLocation && eqType(n.stationType, 'charginglocation')) return false;
    return true;
  }

  /* ---------- Lasting & plotting ---------- */

  async function loadStations() {
    loading = true; errorMsg = '';
    try {
      const r = await fetch(STATIONS_ENDPOINT, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
      const raw = await r.json();
      const list = Array.isArray(raw) ? raw : (raw?.items ?? []);
      if (!Array.isArray(list)) throw new Error('Uventet API-format fra upstream.');
      stations = list;
      console.info('[StationMap] hentet stasjoner:', stations.length);
    } catch (e: any) {
      console.error('[StationMap] Feil ved henting:', e);
      errorMsg = e?.message ?? 'Ukjent feil ved henting av stasjoner.';
      stations = [];
    } finally {
      loading = false;
    }
  }

  function firstValidLatLng(items: AnyStation[]) {
    for (const s of items) {
      const n = normalizeStation(s);
      if (n.lat !== null && n.lng !== null) return n;
    }
    return null;
  }

  function centerOnFirstStationOnce() {
    const first = firstValidLatLng(stations);
    if (!first) return;

    map.setView([first.lat!, first.lng!], 12, { animate: false });

    if (initRing) { map.removeLayer(initRing); initRing = null; }
    initRing = L.circle([first.lat!, first.lng!], {
      radius: 400,
      color: '#e53935',
      weight: 2,
      fillColor: '#ff8a80',
      fillOpacity: 0.25
    }).addTo(map);
  }

  function redrawMarkers() {
    if (!map) return;

    if (markersGroup) {
      map.removeLayer(markersGroup);
      markersGroup = null;
    }
    markersGroup = L.layerGroup().addTo(map);

    let added = 0;

    for (const s of stations) {
      const n = normalizeStation(s);
      if (n.lat === null || n.lng === null) continue;
      if (!passesTypeHide(n)) continue;

      const col = colorForType(n.stationType);
      const marker = L.circleMarker([n.lat, n.lng], {
        radius: 8,
        color: col.stroke,
        weight: 2,
        fillColor: col.fill,
        fillOpacity: 0.95
      }).bindPopup(
        `<strong>${n.name}</strong>` +
        (n.stationType ? `<br>Type: ${n.stationType}` : '') +
        `<br>Sist oppdatert: ${new Date(n.lastUpdated).toLocaleString('no-NO')}`
      );

      markersGroup.addLayer(marker);
      added++;
    }

    visibleCount = added;
    console.info('[StationMap] viste markører (etter type-skjul):', added);
  }

  /* ---------- Søk ---------- */

  async function runSearch(term: string) {
    if (!term || term.trim().length < 2) {
      results = []; showList = false; activeIndex = -1; return;
    }
    searching = true;
    try {
      const u = new URL(GEOCODE_ENDPOINT, window.location.origin);
      u.searchParams.set('q', term);
      u.searchParams.set('limit', '8');

      const r = await fetch(u.toString(), { cache: 'no-store' });
      if (!r.ok) throw new Error(`Search HTTP ${r.status}`);
      const data = await r.json();
      results = (Array.isArray(data) ? data : []).map((d: any) => ({
        display: d.display_name as string,
        lat: Number(d.lat),
        lon: Number(d.lon),
        bbox: d.boundingbox?.map(Number) as number[] | undefined
      }));
      showList = true;
      activeIndex = results.length ? 0 : -1;
    } catch (e) {
      console.warn('[StationMap] Geocode feilet', e);
      results = []; showList = false; activeIndex = -1;
    } finally {
      searching = false;
    }
  }

  function onInput(e: Event) {
    q = (e.target as HTMLInputElement).value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(q), 300);
  }
  function onKeydown(e: KeyboardEvent) {
    if (!showList || results.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIndex = (activeIndex + 1) % results.length; }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIndex = (activeIndex - 1 + results.length) % results.length; }
    else if (e.key === 'Enter') { e.preventDefault(); if (activeIndex >= 0) selectResult(results[activeIndex]); }
    else if (e.key === 'Escape') { showList = false; }
  }
  function selectResult(r: { display: string; lat: number; lon: number; bbox?: number[] }) {
    q = r.display; showList = false;

    if (searchMarker) { map.removeLayer(searchMarker); searchMarker = null; }

    searchMarker = L.circleMarker([r.lat, r.lon], {
      radius: 9,
      color: '#1a237e',
      weight: 3,
      fillColor: '#82b1ff',
      fillOpacity: 0.9
    }).addTo(map).bindPopup(`<strong>${r.display}</strong>`);

    if (r.bbox && r.bbox.length === 4) {
      const [south, north, west, east] = r.bbox;
      const bounds = L.latLngBounds([[south, west], [north, east]]);
      map.fitBounds(bounds.pad(0.1));
    } else {
      map.setView([r.lat, r.lon], 13, { animate: true });
    }
    setTimeout(() => searchMarker?.openPopup(), 100);
  }

  /* ---------- Lifecycle ---------- */

  onMount(async () => {
    map = L.map(mapEl!, { center: [60.5, 8.5], zoom: 6 });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap-bidragsytere'
    }).addTo(map);

    await loadStations();
    centerOnFirstStationOnce();
    redrawMarkers();

    setTimeout(() => map.invalidateSize(), 0);
    window.addEventListener('resize', () => map.invalidateSize());
  });

  function toggleType(key: keyof typeof typeFilter) {
    typeFilter[key] = !typeFilter[key];
    redrawMarkers();
  }

  function resetTypeFilters() {
    typeFilter = { hideWash: false, hideSelfservice: false, hideTruck: false, hideChargingLocation: false };
    redrawMarkers();
  }
</script>

<style>
  .map-wrap {
    position: relative;
    height: 80vh;
    border-radius: 8px;
    border: 1px solid #e7e7e7;
    overflow: hidden;
    background: #fff;
  }
  .leaflet-container { height: 100%; width: 100%; }

  /* Søkeboks (høyre) */
  .search {
    position: absolute;
    right: 12px;
    top: 12px;
    width: min(380px, 80vw);
    z-index: 600;
  }
  .search input {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid #dcdcdc;
    border-radius: 8px;
    font-size: 14px;
    outline: none;
    box-shadow: 0 2px 12px rgba(0,0,0,.08);
    background: #fff;
  }
  .search-results {
    position: absolute;
    top: 44px;
    right: 0;
    width: 100%;
    max-height: 50vh;
    overflow: auto;
    background: #fff;
    border: 1px solid #e7e7e7;
    border-radius: 8px;
    box-shadow: 0 12px 32px rgba(0,0,0,.12);
  }
  .search-item {
    padding: 10px 12px;
    cursor: pointer;
    font-size: 13px;
  }
  .search-item:hover,
  .search-item.active {
    background: #f5f7fb;
  }
  .search-status {
    padding: 8px 12px;
    font-size: 12px;
    color: #555;
  }

  /* Toolbar (venstre) – KUN type-skjul */
  .toolbar {
    position: absolute;
    left: 3%;
    top: 12px;
    z-index: 600;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    max-width: 50vw;
  }
  .toolbar .section-title {
    width: 100%;
    font-size: 12px;
    font-weight: 700;
    color: #444;
    margin-top: 4px;
  }
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    border: 1px solid #dcdcdc;
    border-radius: 999px;
    background: #fff;
    font-size: 13px;
    cursor: pointer;
    user-select: none;
    box-shadow: 0 2px 12px rgba(0,0,0,.06);
  }
  .toggle.on {
    border-color: #1976d2;
    background: #e3f2fd;
    color: #0d47a1;
    font-weight: 600;
  }
  .reset-btn {
    padding: 8px 12px;
    border: 1px solid #bbb;
    border-radius: 8px;
    background: #fafafa;
    font-size: 12px;
    cursor: pointer;
  }
  .counter {
    position: absolute;
    left: 12px;
    bottom: 12px;
    padding: 6px 10px;
    background: rgba(255,255,255,0.95);
    border: 1px solid #e7e7e7;
    border-radius: 8px;
    font-size: 12px;
    color: #333;
    z-index: 600;
  }
</style>

<div class="map-wrap">
  <div bind:this={mapEl} class="leaflet-container"></div>

  <!-- Kun type-skjul (VENSTRE) -->
  <div class="toolbar" aria-label="Skjul stasjonstyper">
    <div class="section-title">Skjul typer</div>
    <div class="toggle {typeFilter.hideWash ? 'on' : ''}" role="button" aria-pressed={typeFilter.hideWash} on:click={() => toggleType('hideWash')}>
      🚫 Wash
    </div>
    <div class="toggle {typeFilter.hideSelfservice ? 'on' : ''}" role="button" aria-pressed={typeFilter.hideSelfservice} on:click={() => toggleType('hideSelfservice')}>
      🚫 Selfservice
    </div>
    <div class="toggle {typeFilter.hideTruck ? 'on' : ''}" role="button" aria-pressed={typeFilter.hideTruck} on:click={() => toggleType('hideTruck')}>
      🚫 Truck
    </div>
    <div class="toggle {typeFilter.hideChargingLocation ? 'on' : ''}" role="button" aria-pressed={typeFilter.hideChargingLocation} on:click={() => toggleType('hideChargingLocation')}>
      🚫 ChargingLocation
    </div>

    <button class="reset-btn" on:click={resetTypeFilters} title="Nullstill type-filtre">Nullstill</button>
  </div>

  <!-- Søkeboks (HØYRE) -->
  <div class="search" on:keydown={onKeydown}>
    <input
      type="search"
      placeholder="Søk sted eller adresse (f.eks. Oslo S, Karl Johans gate)"
      bind:value={q}
      on:input={onInput}
      aria-label="Søk etter sted"
      autocomplete="off"
      spellcheck="false"
    />
    {#if showList}
      <div class="search-results" role="listbox">
        {#if searching}
          <div class="search-status">Søker …</div>
        {:else if results.length === 0}
          <div class="search-status">Ingen treff</div>
        {:else}
          {#each results as r, i}
            <div
              class="search-item {i === activeIndex ? 'active' : ''}"
              role="option"
              aria-selected={i === activeIndex}
              on:click={() => selectResult(r)}
            >
              {r.display}
            </div>
          {/each}
        {/if}
      </div>
    {/if}
  </div>

  <!-- Status -->
  <div class="counter">
    {#if loading}
      Laster stasjoner …
    {:else if errorMsg}
      {errorMsg}
    {:else}
      Viser {visibleCount} stasjoner
    {/if}
  </div>
</div>