(function (global) {
  const assetPromises = new Map();
  const routeControls = new WeakMap();

  function getConfig() {
    return global.__APP_CONFIG__ || {};
  }

  function loadAsset(url, kind) {
    if (assetPromises.has(url)) {
      return assetPromises.get(url);
    }
    const promise = new Promise((resolve, reject) => {
      let element;
      if (kind === 'css') {
        element = document.createElement('link');
        element.rel = 'stylesheet';
        element.href = url;
      } else {
        element = document.createElement('script');
        element.src = url;
        element.async = true;
      }
      element.onload = () => resolve();
      element.onerror = () => reject(new Error(`Failed to load ${url}`));
      document.head.appendChild(element);
    });
    assetPromises.set(url, promise);
    return promise;
  }

  async function ensureLeaflet() {
    await loadAsset('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', 'css');
    await loadAsset('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', 'js');
  }

  async function ensureRoutingMachine() {
    await ensureLeaflet();
    await loadAsset('https://unpkg.com/leaflet-routing-machine@3.2.12/dist/leaflet-routing-machine.css', 'css');
    await loadAsset('https://unpkg.com/leaflet-routing-machine@3.2.12/dist/leaflet-routing-machine.js', 'js');
    if (!document.getElementById('leaflet-routing-hide')) {
      const style = document.createElement('style');
      style.id = 'leaflet-routing-hide';
      style.textContent = '.leaflet-routing-container{display:none!important;}';
      document.head.appendChild(style);
    }
  }

  async function ensureMapLibre() {
    await ensureLeaflet();
    await loadAsset('https://unpkg.com/maplibre-gl@3.5.2/dist/maplibre-gl.css', 'css');
    await loadAsset('https://unpkg.com/maplibre-gl@3.5.2/dist/maplibre-gl.js', 'js');
    await loadAsset('https://unpkg.com/maplibre-gl-leaflet@0.0.17/leaflet-maplibre-gl.js', 'js');
  }

  async function initMap(containerId, center = [0, 0], zoom = 12, options = {}) {
    const config = getConfig();
    await ensureLeaflet();
    const map = L.map(containerId, { zoomControl: true, ...options }).setView(center, zoom);

    const provider = (config.MAP_PROVIDER || 'leaflet').toLowerCase();
    if (provider === 'leaflet') {
      if (config.MAPTILER_KEY) {
        await ensureMapLibre();
        L.maplibreGL({
          style: `https://api.maptiler.com/maps/streets/style.json?key=${config.MAPTILER_KEY}`,
          attribution: '&copy; MapTiler & OpenStreetMap contributors'
        }).addTo(map);
      } else {
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; OpenStreetMap contributors'
        }).addTo(map);
      }
    } else {
      // Fallback to basic OSM tiles if provider unsupported
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors'
      }).addTo(map);
    }

    return map;
  }

  function addMarker(map, { lat, lng, draggable = false, label = '' } = {}) {
    if (!map) throw new Error('Map instance is required');
    const marker = L.marker([lat, lng], { draggable });
    marker.addTo(map);
    if (label) {
      marker.bindTooltip(label, { permanent: false, direction: 'top' });
    }
    return marker;
  }

  function getRoutingControl(map) {
    const existing = routeControls.get(map);
    if (existing) {
      map.removeControl(existing);
    }
    return null;
  }

  async function geocode(query) {
    const config = getConfig();
    const trimmed = (query || '').trim();
    if (!trimmed) {
      throw new Error('الرجاء إدخال موقع صالح.');
    }
    const parts = trimmed.split(',');
    if (parts.length === 2) {
      const lat = Number(parts[0]);
      const lng = Number(parts[1]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        return { lat, lng, label: `${lat.toFixed(5)}, ${lng.toFixed(5)}` };
      }
    }
    const base = (config.NOMINATIM_URL || 'https://nominatim.openstreetmap.org').replace(/\/$/, '');
    const url = `${base}/search?format=json&limit=1&accept-language=ar&q=${encodeURIComponent(trimmed)}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'MANDUBO MVP (learning project)',
        'Accept-Language': 'ar'
      }
    });
    if (!response.ok) {
      throw new Error('تعذر الاتصال بخدمة تحديد المواقع.');
    }
    const data = await response.json();
    if (!Array.isArray(data) || !data.length) {
      throw new Error('لم يتم العثور على الموقع المدخل.');
    }
    return {
      lat: Number(data[0].lat),
      lng: Number(data[0].lon),
      label: data[0].display_name
    };
  }

  async function routeAndEta(map, origin, destination, options = {}) {
    if (!map) throw new Error('Map instance is required for routing');
    await ensureRoutingMachine();
    getRoutingControl(map);
    return new Promise((resolve, reject) => {
      const config = getConfig();
      const control = L.Routing.control({
        waypoints: [L.latLng(origin.lat, origin.lng), L.latLng(destination.lat, destination.lng)],
        router: L.Routing.osrmv1({ serviceUrl: config.OSM_ROUTING_URL || 'https://router.project-osrm.org/route/v1' }),
        show: false,
        addWaypoints: false,
        routeWhileDragging: false,
        fitSelectedRoutes: false,
        lineOptions: {
          addWaypoints: false,
          styles: [{ color: '#2563eb', weight: 5, opacity: 0.9 }]
        },
        createMarker: () => null
      })
        .on('routesfound', (event) => {
          const route = event.routes?.[0];
          if (!route) {
            reject(new Error('No route available'));
            return;
          }
          const km = Number((route.summary.totalDistance / 1000).toFixed(2));
          const minutes = Math.round(route.summary.totalTime / 60);
          routeControls.set(map, control);
          resolve({ km, minutes, control });
        })
        .on('routingerror', (error) => {
          map.removeControl(control);
          reject(error.error || error);
        })
        .addTo(map);
    });
  }

  function smoothDriverMarker(marker, previous, next, durationMs = 600) {
    if (!marker || !next) return;
    const startLatLng = previous || marker.getLatLng();
    const endLatLng = L.latLng(next.lat, next.lng);
    const startTime = performance.now();

    function animate(now) {
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / durationMs);
      const currentLat = startLatLng.lat + (endLatLng.lat - startLatLng.lat) * progress;
      const currentLng = startLatLng.lng + (endLatLng.lng - startLatLng.lng) * progress;
      marker.setLatLng([currentLat, currentLng]);
      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    }

    requestAnimationFrame(animate);
  }

  function fitBounds(map, markers = []) {
    if (!map) return;
    const validMarkers = markers.filter(Boolean);
    if (!validMarkers.length) return;
    const group = L.featureGroup(validMarkers);
    map.fitBounds(group.getBounds().pad(0.2));
  }

  global.MapKit = {
    initMap,
    addMarker,
    geocode,
    routeAndEta,
    smoothDriverMarker,
    fitBounds
  };
})(window);
