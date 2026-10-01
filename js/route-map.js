/* ============================================================================
 * ROUTE MAP  (js/route-map.js)
 *
 * One map component, used by three screens: the Find Ride search, a ride's
 * details page, and the offer form's route preview.
 *
 * WHAT IT DRAWS
 *   the offer's full road        blue, the spine of everything
 *   the part before boarding     faded grey
 *   the rider's own leg          bright teal, thick  <- the whole point
 *   the part after leaving       faded grey
 *   the rider's other journey    dashed violet
 *   A / B / C / D pins           start, board, drop, end
 *   every town it passes         a dot and a name
 *   every 50 km                  a distance pill
 *   a scale bar in km            because a route map without one is a picture
 *
 * WHY EVERY LABEL IS AN HTML MARKER, NOT A Mapbox SYMBOL LAYER
 *   A symbol layer needs a glyph endpoint and a sprite endpoint. Both are extra
 *   network requests that a locked-down network, an expired token scope or a
 *   blocked CDN can fail - and when a glyph is missing, Mapbox renders an empty
 *   box where the town name should be, with no error the page can see. HTML
 *   markers are styled by our own CSS, so the route's own information survives
 *   even if the basemap's decoration does not. The basemap itself still needs
 *   the network; the route on top of it never does.
 *
 * TWO RENDERERS, ONE API
 *
 *   1. Mapbox GL JS, when a publishable `pk.` token is configured. A real
 *      interactive basemap you can pan and zoom, with click-to-pin.
 *
 *   2. A built-in SVG route diagram: the true road geometry, to scale, with no
 *      basemap underneath. Used when there is no key, the CDN is blocked, WebGL
 *      is unavailable, or the style never loads.
 *
 * The second is not an afterthought - it is why the feature cannot be switched
 * off by a missing key. It has no streets or terrain under it, and the legend
 * says so rather than pretending otherwise. Both renderers answer the exact
 * same calls, so a screen never needs to know which one it got.
 *
 * The Mapbox token is never hard-coded here. It comes from
 * GET /api/rides/map-config, which returns only the PUBLISHABLE `pk.` token.
 * ========================================================================== */
(function (global) {
  'use strict';

  const R = global.REVEX || {};
  const escapeHtml = typeof R.escapeHtml === 'function' ? R.escapeHtml : (value => String(value == null ? '' : value));
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const DEFAULT_STYLE_URL = 'mapbox://styles/mapbox/streets-v12';
  const DEFAULT_GL_VERSION = '3.9.4';
  /** One stable id. A new id per render would leak a source and five layers. */
  const SOURCE_ID = 'revex-route';
  /** Spacing of the distance pills, in km. */
  const CHECKPOINT_KM = 50;
  /**
   * How long to wait for the basemap before giving up on it.
   *
   * This has to exist, because "no error event" is not the same as "the map is
   * working" - a request that simply never completes produces neither. It also
   * has to be generous: a cold CDN plus a 90 KB style plus glyph and sprite
   * fetches is a lot of round trips on a slow connection, and throwing the map
   * away too early is exactly the bug this replaced.
   */
  const LOAD_TIMEOUT_MS = 12000;

  /* --------------------------------------------------------------- geometry */

  function toNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  /** Accepts [lng,lat], {lng,lat} or {lon,lat} and returns [lng, lat] or null. */
  function toPair(value) {
    if (!value) return null;
    if (Array.isArray(value) && value.length >= 2) {
      const lng = toNumber(value[0], NaN);
      const lat = toNumber(value[1], NaN);
      return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
    }
    if (typeof value === 'object') {
      const lng = toNumber(value.lng !== undefined ? value.lng : value.lon, NaN);
      const lat = toNumber(value.lat, NaN);
      return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
    }
    return null;
  }

  /** Cleans any incoming geometry into an array of [lng, lat] pairs. */
  function toLine(value) {
    if (!value) return [];
    let source = value;
    if (value.type === 'Feature') source = value.geometry;
    if (source && source.type === 'LineString') source = source.coordinates;
    if (source && source.type === 'MultiLineString' && Array.isArray(source.coordinates)) {
      // Keep the longest part: that is the part that traces the journey.
      let longest = [];
      for (const part of source.coordinates) {
        const line = toLine(part);
        if (line.length > longest.length) longest = line;
      }
      return longest;
    }
    if (!Array.isArray(source)) return [];
    const points = [];
    for (const entry of source) {
      const pair = toPair(entry);
      if (pair) points.push(pair);
    }
    return points;
  }

  function boundsOf(lines) {
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const line of lines) {
      for (const pair of line) {
        if (pair[0] < west) west = pair[0];
        if (pair[0] > east) east = pair[0];
        if (pair[1] < south) south = pair[1];
        if (pair[1] > north) north = pair[1];
      }
    }
    if (west === Infinity) return null;
    return { west, south, east, north };
  }

  /** A path string, dropping repeated points so the SVG does not balloon. */
  function pathFor(line, project) {
    if (!line.length) return '';
    let d = '';
    let previous = null;
    line.forEach((pair, index) => {
      const point = project(pair);
      if (!previous || point[0] !== previous[0] || point[1] !== previous[1]) {
        d += `${index === 0 ? 'M' : 'L'}${point[0].toFixed(1)} ${point[1].toFixed(1)}`;
      }
      previous = point;
    });
    return d;
  }

  function providerLabel(provider, estimated) {
    if (provider === 'mapbox') return 'Road route by Mapbox';
    if (provider === 'osrm') return 'Road route by the public OSRM service';
    if (estimated) return 'Estimated route - no road data available';
    return 'Route';
  }

  function plural(count, one, many) {
    return `${count} ${count === 1 ? one : (many || `${one}s`)}`;
  }

  /* ---------------------------------------------------------------- palette */

  /**
   * The route's own colours, in one place, so the two renderers cannot drift
   * apart. These are the LIGHT values of `--route`, `--brand` and friends in
   * css/theme.css; Mapbox paint properties cannot resolve a CSS variable, so the
   * values are repeated here rather than themed. The basemap is styled for light
   * mode, and the dark values exist for the diagram.
   */
  const COLOURS = {
    route: '#1d4ed8',
    rider: '#0d9488',
    before: '#94a3b8',
    after: '#94a3b8',
    journey: '#7c3aed',
    casing: '#0f172a'
  };

  /**
   * The line segments, in paint order, bottom first.
   *
   * `casing: true` means a wider dark line is drawn underneath, which is what
   * makes a route readable over a photographically busy basemap - the trick every
   * navigation app uses, and the reason a bare 3px line looks amateur.
   */
  const SEGMENTS = [
    { key: 'journey', colour: COLOURS.journey, width: 4, opacity: 0.85, dash: [1.2, 1.6], casing: false },
    { key: 'before', colour: COLOURS.before, width: 4, opacity: 0.8, casing: false },
    { key: 'after', colour: COLOURS.after, width: 4, opacity: 0.8, casing: false },
    { key: 'route', colour: COLOURS.route, width: 5, opacity: 0.92, casing: true },
    { key: 'rider', colour: COLOURS.rider, width: 7, opacity: 1, casing: true }
  ];

  /* ---------------------------------------------------------------- loader */

  const scriptCache = {};

  /**
   * Loads Mapbox GL JS from the CDN exactly once per version.
   *
   * A rejected promise is CACHED as a rejection on purpose. Without that, every
   * map on a page with no token (or a blocked CDN) would retry the network and
   * delay first paint by the full timeout, on every render.
   */
  function loadMapboxGl(config) {
    const version = String(config.glVersion || DEFAULT_GL_VERSION).replace(/^v/, '');
    const scriptUrl = config.glScriptUrl || `https://api.mapbox.com/mapbox-gl-js/v${version}/mapbox-gl.js`;
    const styleUrl = config.glStyleUrl || `https://api.mapbox.com/mapbox-gl-js/v${version}/mapbox-gl.css`;
    if (scriptCache[scriptUrl]) return scriptCache[scriptUrl];

    scriptCache[scriptUrl] = new Promise((resolve, reject) => {
      if (!global.document) { reject(new Error('no document')); return; }
      if (!document.getElementById('revexMapboxGlCss') && styleUrl) {
        const link = document.createElement('link');
        link.id = 'revexMapboxGlCss';
        link.rel = 'stylesheet';
        link.href = styleUrl;
        document.head.appendChild(link);
      }
      const script = document.createElement('script');
      script.src = scriptUrl;
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.onload = () => (global.mapboxgl ? resolve(global.mapboxgl) : reject(new Error('Mapbox GL JS loaded but did not register')));
      script.onerror = () => reject(new Error('Mapbox GL JS could not be loaded'));
      document.head.appendChild(script);
    });
    return scriptCache[scriptUrl];
  }

  /* -------------------------------------------------------------- the map */

  /**
   * @param {HTMLElement} container  where to draw
   * @param {object} options
   *        options.height        CSS height of the map, default '320px'
   *        options.interactive   false renders a static diagram
   *        options.onPick        called with {lng, lat} when the rider pins
   *        options.ariaLabel     accessible name for the region
   */
  function create(container, options) {
    if (!container) return null;
    const settings = options || {};
    const state = {
      route: [],
      journey: [],
      legs: { driverBefore: [], rider: [], driverAfter: [] },
      start: null,
      end: null,
      pickup: null,
      drop: null,
      towns: [],
      townsBetween: null,
      checkpoints: [],
      provider: '',
      estimated: false,
      pinMode: false,
      onPick: typeof settings.onPick === 'function' ? settings.onPick : null,
      renderer: 'diagram',
      gl: null,
      map: null,
      mapLoaded: false,
      loadTimer: null,
      markers: [],
      // The key we last framed the camera to. Refitting on every re-render
      // would yank the map out from under the rider every time they type.
      fitKey: '',
      styleUrl: '',
      token: '',
      roadDataSource: '',
      notice: '',
      unproject: null
    };

    const root = document.createElement('div');
    root.className = 'rvx-map';
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', settings.ariaLabel || 'Route map');
    if (settings.pickHint) root.setAttribute('data-pick-hint', 'true');

    const surface = document.createElement('div');
    surface.className = 'rvx-map__surface';
    surface.style.height = typeof settings.height === 'number' ? `${settings.height}px` : (settings.height || '320px');

    /**
     * TWO host elements, one per renderer, side by side inside `surface`.
     *
     * Mapbox GL JS needs its container to be EMPTY when the Map is built, and
     * warns - and mis-measures its click targets - if it is not. The keyless
     * diagram writes an <svg> or an <p> into the same area. Giving them one
     * node between them meant the diagram's placeholder was sitting inside a
     * live basemap, and that the only way to clear the diagram was also to
     * detach the canvas. With two hosts, switching renderer is a `hidden`
     * toggle: a map that has already loaded is never thrown away and rebuilt.
     */
    const glHost = document.createElement('div');
    glHost.className = 'rvx-map__gl';
    glHost.hidden = true;
    const diagramHost = document.createElement('div');
    diagramHost.className = 'rvx-map__diagram';
    surface.appendChild(glHost);
    surface.appendChild(diagramHost);

    const status = document.createElement('p');
    status.className = 'rvx-map__status';

    root.appendChild(surface);
    root.appendChild(status);
    container.innerHTML = '';
    container.appendChild(root);

    /* -------------------------------------------------------- marker pieces */

    /**
     * One DOM element per pin, town or distance pill. Built with DOM rather than
     * innerHTML so a town name coming from the gazetteer can never be parsed as
     * markup.
     */
    function pinElement(kind, letter, label) {
      const element = document.createElement('div');
      element.className = `rvx-map__pin rvx-map__pin--${kind}`;
      const dot = document.createElement('span');
      dot.className = 'rvx-map__pin-dot';
      dot.textContent = letter;
      element.appendChild(dot);
      if (label) {
        const caption = document.createElement('span');
        caption.className = 'rvx-map__pin-label';
        caption.textContent = label;
        element.appendChild(caption);
      }
      return element;
    }

    function townElement(name, fromBoardKm) {
      const element = document.createElement('div');
      element.className = 'rvx-map__town';
      const dot = document.createElement('span');
      dot.className = 'rvx-map__town-dot';
      element.appendChild(dot);
      const caption = document.createElement('span');
      caption.className = 'rvx-map__town-name';
      caption.textContent = name;
      element.appendChild(caption);
      if (Number.isFinite(fromBoardKm) && fromBoardKm > 0) {
        const distance = document.createElement('span');
        distance.className = 'rvx-map__town-km';
        distance.textContent = `${Math.round(fromBoardKm)} km`;
        element.appendChild(distance);
      }
      return element;
    }

    function checkpointElement(km) {
      const element = document.createElement('div');
      element.className = 'rvx-map__checkpoint';
      element.textContent = `${km} km`;
      return element;
    }

    /* --------------------------------------------------------- diagram renderer */

    /**
     * The no-key renderer: a true-to-scale SVG of the real road geometry, with no
     * basemap underneath.
     *
     * An equirectangular projection scaled at the view's centre latitude, which
     * is accurate to well under a percent over a single journey, and is what
     * lets a click be converted back into a real longitude and latitude.
     */
    function renderDiagram() {
      const lines = [];
      if (state.route.length) lines.push(state.route);
      if (state.journey.length) lines.push(state.journey);
      for (const key of ['driverBefore', 'rider', 'driverAfter']) {
        if (state.legs[key] && state.legs[key].length) lines.push(state.legs[key]);
      }
      const markerPoints = [
        state.route.length ? state.route[0] : state.start,
        state.route.length ? state.route[state.route.length - 1] : state.end,
        state.pickup,
        state.drop
      ];
      for (const marker of markerPoints) if (marker) lines.push([marker]);
      for (const town of state.towns) if (town.coordinate) lines.push([town.coordinate]);
      for (const mark of state.checkpoints) if (mark.coordinate) lines.push([mark.coordinate]);
      const bounds = boundsOf(lines);

      // Only the diagram's own host is cleared. The basemap's host is a
      // different element, so a live map survives a switch back to the diagram
      // and comes straight back when the key returns.
      diagramHost.innerHTML = '';
      diagramHost.hidden = false;
      glHost.hidden = true;
      if (!bounds) {
        const empty = document.createElement('p');
        empty.className = 'rvx-map__empty';
        empty.textContent = 'The road route for this ride is not available yet.';
        diagramHost.appendChild(empty);
        return;
      }

      const width = Math.max(surface.clientWidth || 320, 220);
      const height = Math.max(surface.clientHeight || 320, 180);
      const padding = 40;
      const centreLat = (bounds.south + bounds.north) / 2;
      const cosLat = Math.max(Math.cos((centreLat * Math.PI) / 180), 0.05);
      // Span measured in "degrees of longitude at the centre latitude", so the
      // two axes share a scale and the road keeps its true shape.
      const spanX = Math.max((bounds.east - bounds.west) * cosLat, 1e-6);
      const spanY = Math.max(bounds.north - bounds.south, 1e-6);
      const scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY);
      const offsetX = (width - spanX * scale) / 2;
      const offsetY = (height - spanY * scale) / 2;
      const project = pair => [
        offsetX + (pair[0] - bounds.west) * cosLat * scale,
        height - offsetY - (pair[1] - bounds.south) * scale
      ];
      // The inverse is what makes click-to-pin work without a real basemap.
      state.unproject = point => [
        (point[0] - offsetX) / (cosLat * scale) + bounds.west,
        (height - offsetY - point[1]) / scale + bounds.south
      ];

      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.setAttribute('class', 'rvx-map__svg');
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', settings.ariaLabel || 'Route map');
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

      const add = (name, attributes) => {
        const node = document.createElementNS(SVG_NS, name);
        for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
        svg.appendChild(node);
        return node;
      };
      const stroke = (line, className, widthPx) => {
        const d = pathFor(line, project);
        if (!d) return;
        add('path', { d, class: className, 'stroke-width': widthPx, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
      };

      // A faint graticule, so an empty diagram still reads as a map and not as a
      // stray line on a white card.
      add('rect', { x: 0, y: 0, width, height, class: 'rvx-map__graticule' });

      // Casings first, all of them, then the coloured lines on top - the same
      // stacking order the basemap renderer uses, so the two agree.
      for (const segment of SEGMENTS) {
        if (!segment.casing) continue;
        const line = state.legs[segment.key] || state.route;
        if (segment.key === 'route' && state.legs.rider.length) continue;
        stroke(line && line.length ? line : state.route, 'rvx-map__line rvx-map__line--casing', segment.width + 3.5);
      }
      for (const segment of SEGMENTS) {
        let line = state.legs[segment.key];
        if (!line || !line.length) {
          if (segment.key !== 'route') continue;
          if (state.legs.rider.length) continue;
          line = state.route;
        }
        if (!line.length) continue;
        const className = `rvx-map__line rvx-map__line--${segment.key}`;
        if (segment.dash) {
          const d = pathFor(line, project);
          if (d) {
            add('path', {
              d, class: className, 'stroke-width': segment.width, fill: 'none',
              'stroke-linecap': 'round', 'stroke-linejoin': 'round',
              'stroke-dasharray': segment.dash.map(value => value * segment.width).join(' ')
            });
          }
          continue;
        }
        stroke(line, className, segment.width);
      }

      // Distance pills, then towns, then the A/B/C/D pins on top.
      for (const mark of state.checkpoints) {
        const pair = toPair(mark.coordinate);
        if (!pair) continue;
        const [x, y] = project(pair);
        add('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: 2.5, class: 'rvx-map__checkpoint-dot' });
        const text = add('text', { x: (x + 6).toFixed(1), y: (y - 6).toFixed(1), class: 'rvx-map__checkpoint-text' });
        text.textContent = `${mark.km} km`;
      }
      for (const town of state.towns) {
        const pair = toPair(town.coordinate);
        if (!pair) continue;
        const [x, y] = project(pair);
        add('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: 3, class: 'rvx-map__town-dot' });
        add('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: 6, class: 'rvx-map__town-halo' });
        const text = add('text', { x: (x + 9).toFixed(1), y: (y - 7).toFixed(1), class: 'rvx-map__town-name' });
        text.textContent = town.name;
      }

      const pin = (pair, kind, letter, label) => {
        if (!pair) return;
        const [x, y] = project(pair);
        add('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: 10, class: `rvx-map__pin-halo rvx-map__pin-halo--${kind}` });
        add('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: 7, class: `rvx-map__pin-dot rvx-map__pin-dot--${kind}` });
        const text = add('text', { x: x.toFixed(1), y: (y + 3.4).toFixed(1), class: 'rvx-map__pin-letter' });
        text.textContent = letter;
        const caption = add('text', { x: (x + 12).toFixed(1), y: (y + 4).toFixed(1), class: 'rvx-map__pin-label' });
        caption.textContent = label;
      };
      pin(markerPoints[0], 'start', 'A', state.startName || 'Start');
      pin(markerPoints[1], 'end', 'D', state.endName || 'End');
      pin(state.pickup || (state.journey.length ? state.journey[0] : null), 'pickup', 'B', state.pinMode ? 'Your pin' : (state.pickupName || 'Board here'));
      pin(state.drop || (state.journey.length ? state.journey[state.journey.length - 1] : null), 'drop', 'C', state.dropName || 'Get off here');

      /* A scale bar. A route map with no way to judge size is a picture. */
      const kmPerDegree = 111.32 * cosLat;
      const targetPx = Math.min(120, Math.max(60, width / 4));
      const barKm = Math.max(1, Math.round((targetPx / scale / kmPerDegree) * 10) / 10);
      const barPx = barKm * kmPerDegree * scale;
      if (barPx > 24 && Number.isFinite(barPx)) {
        const barY = height - 12;
        add('path', {
          d: `M${padding} ${barY} h${barPx.toFixed(1)}`, class: 'rvx-map__scalebar'
        });
        const scaleText = add('text', { x: padding, y: barY - 4, class: 'rvx-map__scalebar-text' });
        scaleText.textContent = `${barKm} km`;
      }

      if (state.pinMode) {
        svg.classList.add('rvx-map__svg--picking');
        svg.addEventListener('click', event => {
          if (!state.onPick || !state.unproject) return;
          const rect = svg.getBoundingClientRect();
          const x = ((event.clientX - rect.left) / rect.width) * width;
          const y = ((event.clientY - rect.top) / rect.height) * height;
          const pair = state.unproject([x, y]);
          state.onPick({ lng: Number(pair[0].toFixed(5)), lat: Number(pair[1].toFixed(5)) });
        });
      }

      diagramHost.appendChild(svg);
    }

    /* -------------------------------------------------------- mapbox renderer */

    /**
     * Builds the A/B/C/D pins, the town dots and the distance pills as Mapbox
     * markers. Called fresh on every render, after the previous set is removed.
     */
    function buildMarkers(mapboxgl) {
      clearMarkers();
      const place = (element, coordinate) => {
        const pair = toPair(coordinate);
        if (!pair) return;
        state.markers.push(new mapboxgl.Marker({ element, anchor: 'center' }).setLngLat(pair).addTo(state.map));
      };
      const routeStart = state.route.length ? state.route[0] : state.start;
      const routeEnd = state.route.length ? state.route[state.route.length - 1] : state.end;
      place(pinElement('start', 'A', state.startName || 'Start'), routeStart);
      place(pinElement('end', 'D', state.endName || 'End'), routeEnd);
      place(pinElement('pickup', 'B', state.pinMode ? 'Your pin' : (state.pickupName || 'Board here')),
        state.pickup || (state.journey.length ? state.journey[0] : null));
      place(pinElement('drop', 'C', state.dropName || 'Get off here'),
        state.drop || (state.journey.length ? state.journey[state.journey.length - 1] : null));
      for (const town of state.towns) place(townElement(town.name, town.fromBoardKm), town.coordinate);
      for (const mark of state.checkpoints) place(checkpointElement(mark.km), mark.coordinate);
    }

    function ensureMap(mapboxgl) {
      if (state.map) return true;
      // The token has to be on the global before the Map is CONSTRUCTED, not
      // before the first layer is added: GL JS validates it during
      // construction and throws "An API access token is required" without it.
      mapboxgl.accessToken = state.token;
      // The basemap's own host must be empty at this moment, and the diagram
      // must be out of sight, or GL JS measures the wrong box.
      diagramHost.hidden = true;
      diagramHost.innerHTML = '';
      glHost.innerHTML = '';
      glHost.hidden = false;
      try {
        state.map = new mapboxgl.Map({
          container: glHost,
          style: state.styleUrl || DEFAULT_STYLE_URL,
          attributionControl: true,
          dragRotate: false,
          // A route map is a north-up, non-tiltable thing; locking the drag
          // interaction to pan+zoom keeps a one-finger swipe from rotating the
          // map under the rider's finger.
          touchPitch: false,
          ...(state.pinMode ? { dragPan: false } : {})
        });
      } catch (error) {
        // The common cause is no WebGL at all - a headless browser, a VM, a
        // machine with hardware acceleration switched off. GL JS throws here
        // rather than emitting an error event, so it has to be caught here.
        state.map = null;
        state.notice = 'This device cannot draw the interactive map, so the route diagram is shown instead.';
        state.renderer = 'diagram';
        if (error && /token/i.test(String(error.message || ''))) {
          state.notice = 'The map service rejected the public token, so the route diagram is shown instead.';
        }
        return false;
      }

      state.map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
      // Kilometres, because every other number on this page is in kilometres.
      if (mapboxgl.ScaleControl) {
        state.map.addControl(new mapboxgl.ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-left');
      }
      if (mapboxgl.FullscreenControl) {
        state.map.addControl(new mapboxgl.FullscreenControl(), 'top-right');
      }

      /**
       * THE IMPORTANT PART.
       *
       * `error` fires for a missing glyph, one 404'd tile at one zoom, a sprite
       * icon the style references but does not define. All of those are routine
       * and none of them stop the map drawing. So this handler does NOT tear the
       * map down - it counts, and the map is only abandoned if `load` never
       * arrives at all within LOAD_TIMEOUT_MS. Treating any error as fatal is
       * what previously replaced a working basemap with a plain diagram the
       * first time a tile went missing.
       */
      let errorCount = 0;
      state.map.on('error', () => {
        errorCount += 1;
        state.mapErrors = errorCount;
        if (state.mapLoaded) return;
        // Still loading: a few errors are expected, so only give up once the
        // map has been hopeless for the whole timeout.
      });

      state.map.once('load', () => {
        state.mapLoaded = true;
        state.notice = '';
        if (state.loadTimer) { clearTimeout(state.loadTimer); state.loadTimer = null; }
        render();
      });
      state.loadTimer = setTimeout(() => {
        state.loadTimer = null;
        if (state.mapLoaded || !state.map) return;
        try { state.map.remove(); } catch { /* already gone */ }
        state.map = null;
        state.mapLoaded = false;
        state.renderer = 'diagram';
        state.notice = 'The interactive map did not load in time, so the route diagram is shown instead.';
        render();
      }, LOAD_TIMEOUT_MS);

      state.map.on('click', event => {
        if (!state.pinMode || !state.onPick) return;
        state.onPick({ lng: Number(event.lngLat.lng.toFixed(5)), lat: Number(event.lngLat.lat.toFixed(5)) });
      });

      /**
       * A map can be built inside something that is not on screen yet - the
       * Find Ride panel is `hidden` until a search runs, and the fullscreen
       * control resizes the map into the whole window. GL JS measures its
       * container once at construction and caches that size, so without this it
       * keeps rendering at the dimensions it was born with and is offset from
       * every click. Watching the container and telling the map is the remedy
       * the Mapbox documentation gives, and it covers the collapsed panel, the
       * fullscreen control and a responsive breakpoint in one go.
       */
      if (typeof global.ResizeObserver === 'function') {
        state.resizeObserver = new global.ResizeObserver(() => {
          if (!state.map) return;
          try { state.map.resize(); } catch { /* mid-teardown */ }
        });
        state.resizeObserver.observe(glHost);
      }
      return true;
    }

    function renderMapbox() {
      const mapboxgl = state.gl;
      if (!mapboxgl) return false;
      if (!ensureMap(mapboxgl)) return false;
      const map = state.map;
      if (!map) return false;
      // The basemap is what it is drawn on, so it has to be the visible one.
      glHost.hidden = false;
      diagramHost.hidden = true;

      // `addSource`/`addLayer` throw "Style is not done loading" if they are
      // called before the basemap is ready, and this function is called on
      // every setter - including the one that turns the map on, which is
      // necessarily before the style arrives. So the route waits for `load`,
      // which re-renders, rather than racing the style and throwing.
      if (!state.mapLoaded || (typeof map.isStyleLoaded === 'function' && !map.isStyleLoaded())) {
        buildMarkers(mapboxgl);
        return true;
      }

      const features = [];
      const line = (coordinates, properties) => {
        const coords = toLine(coordinates);
        if (coords.length < 2) return;
        features.push({ type: 'Feature', properties: properties || {}, geometry: { type: 'LineString', coordinates: coords } });
      };
      line(state.route, { kind: 'route' });
      line(state.legs.driverBefore, { kind: 'before' });
      line(state.legs.rider, { kind: 'rider' });
      line(state.legs.driverAfter, { kind: 'after' });
      line(state.journey, { kind: 'journey' });

      // One source, created once, then updated. Re-adding it per render is what
      // used to pile up a source and five layers on every keystroke.
      const collection = { type: 'FeatureCollection', features };
      if (map.getSource(SOURCE_ID)) {
        const source = map.getSource(SOURCE_ID);
        if (source && typeof source.setData === 'function') source.setData(collection);
      } else {
        map.addSource(SOURCE_ID, { type: 'geojson', data: collection });
      }

      // Casings before lines, so every coloured line sits above every casing.
      for (const segment of SEGMENTS) {
        if (!segment.casing) continue;
        const layerId = `${SOURCE_ID}-${segment.key}-casing`;
        if (map.getLayer(layerId)) continue;
        map.addLayer({
          id: layerId,
          type: 'line',
          source: SOURCE_ID,
          filter: ['==', ['get', 'kind'], segment.key],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': COLOURS.casing, 'line-width': segment.width + 3, 'line-opacity': 0.55 * segment.opacity }
        });
      }
      for (const segment of SEGMENTS) {
        const layerId = `${SOURCE_ID}-${segment.key}`;
        if (map.getLayer(layerId)) continue;
        map.addLayer({
          id: layerId,
          type: 'line',
          source: SOURCE_ID,
          filter: ['==', ['get', 'kind'], segment.key],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': segment.colour,
            'line-width': segment.width,
            'line-opacity': segment.opacity,
            ...(segment.dash ? { 'line-dasharray': segment.dash.map(value => value * segment.width) } : {})
          }
        });
      }

      buildMarkers(mapboxgl);

      // Frame the camera once per journey, not once per render.
      const all = features.map(feature => feature.geometry.coordinates)
        .concat(state.towns.map(town => town.coordinate))
        .concat(state.checkpoints.map(mark => mark.coordinate))
        .concat([state.pickup, state.drop, state.start, state.end].filter(Boolean));
      const bounds = boundsOf(all);
      if (bounds) {
        const key = [bounds.west, bounds.south, bounds.east, bounds.north].map(v => v.toFixed(3)).join(',');
        if (key !== state.fitKey) {
          state.fitKey = key;
          try {
            map.fitBounds(
              [[bounds.west, bounds.south], [bounds.east, bounds.north]],
              { padding: 48, duration: 0, maxZoom: 13 }
            );
          } catch { /* bounds can be momentarily unavailable mid-update */ }
        }
      }

      /* Distance pills are useful zoomed in and are clutter zoomed out, so they
         are hidden by a class rather than removed from the DOM - the rider can
         still zoom in and they come straight back. */
      if (state.checkpoints.length) {
        const applyDensity = () => {
          if (!state.map || !state.mapLoaded) return;
          const zoom = typeof state.map.getZoom === 'function' ? state.map.getZoom() : 13;
          root.classList.toggle('rvx-map--dense', zoom < 7.5);
        };
        applyDensity();
        if (typeof map.on === 'function') map.on('zoomend', applyDensity);
      }
      return true;
    }

    /* ------------------------------------------------------------ rendering */

    function clearMarkers() {
      for (const marker of state.markers) {
        try { marker.remove(); } catch { /* already removed */ }
      }
      state.markers = [];
    }

    function describe() {
      const label = providerLabel(state.provider, state.estimated);
      const extras = [];
      if (state.legs.rider.length) extras.push('your leg is highlighted');
      if (state.legs.rider.length && state.townsBetween !== null) {
        extras.push(state.townsBetween === 0
          ? 'no towns in between'
          : `passes ${plural(state.townsBetween, 'town')}`);
      }
      if (state.legs.rider.length && state.checkpoints.length) {
        extras.push(`marked every ${CHECKPOINT_KM} km`);
      }
      if (state.pinMode && state.onPick) extras.push('click the map to drop your pin');
      if (state.notice) extras.push(state.notice);
      status.innerHTML = escapeHtml(`${label}${extras.length ? ` - ${extras.join(', ')}` : ''}`);
    }

    function render() {
      if (state.renderer === 'mapbox' && renderMapbox()) {
        describe();
        return;
      }
      renderDiagram();
      describe();
    }

    /* ------------------------------------------------------------- the API */

    const controller = {
      /**
       * Applies GET /api/rides/map-config. Safe to call with anything, including
       * nothing: with no usable public token the diagram renderer is used and the
       * caller still gets a working, drawable map.
       */
      async setConfig(config) {
        const incoming = config || {};
        state.token = String(incoming.token || '');
        state.styleUrl = String(incoming.styleUrl || DEFAULT_STYLE_URL);
        state.roadDataSource = String(incoming.roadDataSource || '');
        const usable = Boolean(incoming.enabled) && state.token && state.token.slice(0, 3) === 'pk.';
        if (!usable) {
          state.renderer = 'diagram';
          state.notice = String(incoming.reason || incoming.notice || '');
          render();
          return controller;
        }
        try {
          state.gl = await loadMapboxGl(incoming);
          state.renderer = 'mapbox';
          state.notice = '';
        } catch {
          state.gl = null;
          state.renderer = 'diagram';
          state.notice = 'The interactive map could not be loaded, so the route diagram is shown instead.';
          render();
          return controller;
        }
        render();
        return controller;
      },

      /** The offer's road. `geometry` is [[lng,lat], ...]. */
      setRoute(route) {
        const value = route || {};
        state.route = toLine(value.geometry);
        state.provider = String(value.provider || state.provider || '');
        state.estimated = Boolean(value.estimated);
        state.start = toPair(value.origin) || (state.route[0] || null);
        state.end = toPair(value.destination) || (state.route[state.route.length - 1] || null);
        if (value.originName !== undefined) state.startName = String(value.originName || '');
        if (value.destinationName !== undefined) state.endName = String(value.destinationName || '');
        render();
        return controller;
      },

      /**
       * The rider's own journey, drawn dashed behind everything else.
       *
       * The provider is accepted here too, not just in setRoute: on Find Ride the
       * journey polyline is drawn BEFORE any offer road, so without it the legend
       * would say only "Route" on the one screen where the rider is deciding
       * whether to trust what they are looking at. A rider cannot tell a real
       * road from a straight line by looking at it, so the legend has to say.
       */
      setJourney(journey) {
        const value = journey || {};
        state.journey = toLine(value.geometry);
        if (value.provider !== undefined) state.provider = String(value.provider || '');
        if (value.estimated !== undefined) state.estimated = Boolean(value.estimated);
        render();
        return controller;
      },

      /**
       * The three slices of the offer's road around the rider, from the match the
       * API returns. Drawing all three is what makes the feature legible: the
       * rider sees exactly where they get on and where they get off.
       */
      setLegs(legs) {
        const value = legs || {};
        state.legs = {
          driverBefore: toLine(value.driverBefore),
          rider: toLine(value.rider),
          driverAfter: toLine(value.driverAfter)
        };
        render();
        return controller;
      },

      /** The rider's boarding and drop points, for the B and C pins. */
      setMatch(match) {
        const value = match || {};
        state.pickup = toPair(value.board && (value.board.coordinate || value.board));
        state.drop = toPair(value.drop && (value.drop.coordinate || value.drop));
        if (value.board && value.board.name) state.pickupName = String(value.board.name);
        if (value.drop && value.drop.name) state.dropName = String(value.drop.name);
        render();
        return controller;
      },

      /**
       * The towns passed and the distance marks, straight from the server.
       *
       * The count is taken from the server rather than from `towns.length` so the
       * badge, this list and the map markers cannot disagree - a rider who is
       * told "4 towns" and then counts 3 dots has lost trust in the whole page.
       */
      setCheckpoints(checkpoints) {
        const value = checkpoints || {};
        state.towns = (Array.isArray(value.towns) ? value.towns : [])
          .map(town => ({ name: String(town?.name || ''), fromBoardKm: toNumber(town?.fromBoardKm, NaN), coordinate: toPair(town?.coordinate) }))
          .filter(town => town.name && town.coordinate);
        state.checkpoints = (Array.isArray(value.distances) ? value.distances : [])
          .map(mark => ({ km: toNumber(mark?.km, 0), fromBoardKm: toNumber(mark?.fromBoardKm, NaN), coordinate: toPair(mark?.coordinate) }))
          .filter(mark => mark.coordinate && mark.km > 0);
        state.townsBetween = value.townsBetween === undefined || value.townsBetween === null
          ? null
          : Math.max(0, Math.trunc(toNumber(value.townsBetween, state.towns.length)));
        render();
        return controller;
      },

      /**
       * Turns the map into a pin picker. `onPick` receives {lng, lat}, which the
       * caller sends to the API as the rider's pickup - the server then snaps it
       * to the nearest point on the real road, so a pin dropped in a field still
       * boards at the road, not in the field.
       */
      setPinMode(on, onPick) {
        state.pinMode = Boolean(on);
        if (typeof onPick === 'function') state.onPick = onPick;
        if (state.map && typeof state.map.dragPan === 'object') {
          if (state.map.dragPan.enable) state.map.dragPan.enable();
          if (state.pinMode) state.map.dragPan.disable();
        }
        root.classList.toggle('rvx-map--pin', state.pinMode);
        render();
        return controller;
      },

      onPick(handler) {
        state.onPick = typeof handler === 'function' ? handler : null;
        return controller;
      },

      clear() {
        state.route = [];
        state.journey = [];
        state.legs = { driverBefore: [], rider: [], driverAfter: [] };
        state.start = null;
        state.end = null;
        state.pickup = null;
        state.drop = null;
        state.towns = [];
        state.checkpoints = [];
        state.townsBetween = null;
        state.fitKey = '';
        clearMarkers();
        render();
        return controller;
      },

      /** Re-draws at the current size, e.g. after a layout change. */
      refresh() {
        if (state.map && typeof state.map.resize === 'function') state.map.resize();
        render();
        return controller;
      },

      /** Which renderer is live, for the surrounding UI to explain. */
      status() {
        const camera = state.map && state.mapLoaded
          ? {
            zoom: Number(state.map.getZoom().toFixed(2)),
            centre: state.map.getCenter().toArray().map(value => Number(value.toFixed(3))),
            routeLayer: Boolean(state.map.getLayer(`${SOURCE_ID}-route`)),
            styleLoaded: state.map.isStyleLoaded()
          }
          : null;
        return {
          renderer: state.renderer,
          provider: state.provider,
          estimated: state.estimated,
          pinMode: state.pinMode,
          roadDataSource: state.roadDataSource || '',
          notice: state.notice || '',
          townsBetween: state.townsBetween,
          checkpoints: state.checkpoints.length,
          mapLoaded: Boolean(state.mapLoaded),
          camera
        };
      },

      destroy() {
        clearMarkers();
        if (state.loadTimer) { clearTimeout(state.loadTimer); state.loadTimer = null; }
        // The observer holds a reference to the map and to this element, so it
        // has to be released before the map goes or a closed panel keeps the
        // whole thing alive.
        if (state.resizeObserver) {
          try { state.resizeObserver.disconnect(); } catch { /* already gone */ }
          state.resizeObserver = null;
        }
        if (state.map) {
          try { state.map.remove(); } catch { /* already gone */ }
          state.map = null;
        }
        state.mapLoaded = false;
        root.remove();
      }
    };

    render();
    return controller;
  }

  global.RevexRouteMap = {
    create,
    /** True when Mapbox GL JS is configured, i.e. a real basemap will be used. */
    isAvailable: config => Boolean(config && config.enabled && config.token && String(config.token).slice(0, 3) === 'pk.'),
    providerLabel
  };
})(window);
