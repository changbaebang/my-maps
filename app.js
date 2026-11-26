'use strict';
// 방송 맛집 숏컷. 빌드 도구 없이 바로 읽는 바닐라 JS.
(() => {
  const DISTRICT_ORDER = [
    '종로구', '중구', '용산구', '성동구', '광진구', '동대문구', '중랑구', '성북구',
    '강북구', '도봉구', '노원구', '은평구', '서대문구', '마포구', '양천구', '강서구',
    '구로구', '금천구', '영등포구', '동작구', '관악구', '서초구', '강남구', '송파구', '강동구',
  ];
  const DAY_KO = { mon: '월', tue: '화', wed: '수', thu: '목', fri: '금', sat: '토', sun: '일' };
  const CHOSUNG = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
  const SEOUL = [37.5665, 126.978];
  const KINDS = [['', '전체'], ['meal', '식사'], ['dessert', '디저트·카페']];

  const state = {
    items: [], meta: null, q: '', kind: '', district: '', parkingOnly: false, hideClosedToday: false,
    sort: 'naver', view: 'list', selected: null, visible: [], pos: null,
  };
  const $ = (id) => document.getElementById(id);
  const wide = window.matchMedia('(min-width: 900px)');
  const today = todayCode();
  let map = null;
  let markerLayer = null;
  let meMarker = null;
  const markers = new Map();

  // ------------------------------------------------------------ 작은 도구

  function todayCode() {
    const day = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', weekday: 'short' }).format(new Date());
    return day.slice(0, 3).toLowerCase();
  }

  function compact(text) {
    return String(text || '').toLowerCase().replace(/\s+/g, '');
  }

  function chosung(text) {
    let out = '';
    for (const ch of String(text || '')) {
      const code = ch.charCodeAt(0) - 0xac00;
      if (code >= 0 && code < 11172) out += CHOSUNG[Math.floor(code / 588)];
      else if (/[ㄱ-ㅎ]/.test(ch)) out += ch;
    }
    return out;
  }

  function fmtRating(value) {
    return Number.isInteger(value) ? value.toFixed(1) : String(value);
  }

  // 두 좌표 사이의 직선거리(m)
  function distanceMeters(a, b) {
    const rad = (d) => (d * Math.PI) / 180;
    const x = Math.sin(rad(b.lat - a.lat) / 2) ** 2
      + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
    return 12742000 * Math.asin(Math.sqrt(x));
  }

  function fmtDistance(m) {
    if (m < 1000) return `${Math.round(m / 10) * 10}m`;
    return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)}km`;
  }

  function naverUrl(r) {
    if (r.naver_place_id) return `https://map.naver.com/p/entry/place/${encodeURIComponent(r.naver_place_id)}`;
    return `https://map.naver.com/p/search/${encodeURIComponent(`${r.name} ${r.district}`)}`;
  }

  function isClosedToday(r) {
    return r.closed_days.includes(today);
  }

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat(Infinity)) {
      if (child == null || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  // ------------------------------------------------------------ 데이터

  async function load() {
    let data;
    try {
      const res = await fetch(self.APP_DATA.url, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
      if (self.APP_DATA.encrypted) data = await self.unlockData(data);
    } catch (err) {
      $('status').textContent = '데이터를 불러오지 못했습니다. 연결을 확인하고 다시 열어 주세요.';
      return;
    }
    state.meta = data.meta;
    state.items = Object.values(data.districts).flat().map(prepare);
    $('meta-line').textContent = `${data.meta.count}곳 · ${String(data.meta.generated_at).slice(0, 10)} 기준`;
    $('sample-banner').hidden = !data.meta.sample;
    update();
    if (wide.matches) ensureMap();
  }

  function prepare(r) {
    const programs = (r.tv_shows || []).map((s) => s.program);
    r._hay = compact([r.name, r.category, r.address, r.district, ...programs].join(' '));
    r._cho = [chosung(r.name), ...programs.map(chosung)].join('|');
    return r;
  }

  function matchesQuery(r) {
    const q = compact(state.q);
    if (!q) return true;
    if (/^[ㄱ-ㅎ]+$/.test(q)) return r._cho.includes(q);
    return r._hay.includes(q);
  }

  function passesToggles(r) {
    if (state.parkingOnly && !r.parking.available) return false;
    if (state.hideClosedToday && isClosedToday(r)) return false;
    return true;
  }

  function passesKind(r) {
    return !state.kind || r.kind === state.kind;
  }

  function passesDistrict(r) {
    return !state.district || r.district === state.district;
  }

  const byName = (a, b) => a.name.localeCompare(b.name, 'ko');
  const SORTS = {
    naver: (a, b) => b.naver_rating - a.naver_rating || b.kakao_rating - a.kakao_rating || byName(a, b),
    kakao: (a, b) => b.kakao_rating - a.kakao_rating || b.naver_rating - a.naver_rating || byName(a, b),
    name: byName,
    near: (a, b) => (a._dist ?? Infinity) - (b._dist ?? Infinity) || byName(a, b),
  };

  function visibleItems() {
    return state.items
      .filter((r) => matchesQuery(r) && passesToggles(r) && passesKind(r) && passesDistrict(r))
      .sort(SORTS[state.sort]);
  }

  // ------------------------------------------------------------ 그리기

  function update() {
    renderKinds();
    renderChips();
    render();
  }

  // 각 고르기의 건수는 다른 조건을 모두 적용하고 자기 조건만 뺀 수다
  function renderKinds() {
    const base = state.items.filter((r) => matchesQuery(r) && passesToggles(r) && passesDistrict(r));
    $('kinds').replaceChildren(...KINDS.map(([value, label]) => {
      const n = value ? base.filter((r) => r.kind === value).length : base.length;
      return h('button', {
        type: 'button',
        class: n === 0 ? 'chip is-empty' : 'chip',
        'aria-pressed': String(state.kind === value),
        dataset: { kind: value, count: String(n) },
      }, label, h('span', { class: 'n' }, n));
    }));
  }

  function renderChips() {
    const base = state.items.filter((r) => matchesQuery(r) && passesToggles(r) && passesKind(r));
    const counts = new Map();
    for (const r of base) counts.set(r.district, (counts.get(r.district) || 0) + 1);
    const present = DISTRICT_ORDER.filter((gu) => state.items.some((r) => r.district === gu));
    $('chips').replaceChildren(
      chip('', '모든 구', base.length),
      ...present.map((gu) => chip(gu, gu, counts.get(gu) || 0)),
    );
  }

  function chip(value, label, n) {
    return h('button', {
      type: 'button',
      class: n === 0 ? 'chip is-empty' : 'chip',
      'aria-pressed': String(state.district === value),
      dataset: { district: value, count: String(n) },
    }, label, h('span', { class: 'n' }, n));
  }

  function render() {
    const items = visibleItems();
    state.visible = items;
    $('count').textContent = items.length;
    $('status').textContent = items.length ? `${items.length}곳` : '조건에 맞는 식당이 없습니다.';
    $('list').replaceChildren(...items.map(card));
    renderMarkers();
  }

  function card(r) {
    const shows = r.tv_shows.map((s, i) => [
      i ? ' · ' : '',
      s.program,
      s.aired ? h('span', { class: 'date' }, ` ${s.aired.replaceAll('-', '.')}`) : null,
    ]);
    const closed = r.closed_days.length ? r.closed_days.map((d) => DAY_KO[d]).join('·') : '연중무휴';
    return h('li', {
      class: state.selected === r.id ? 'item is-selected' : 'item',
      dataset: { id: r.id, district: r.district, kind: r.kind },
    }, h('article', {},
      h('div', { class: 'item-head' },
        h('div', { class: 'item-title' },
          h('p', { class: 'kicker' },
            r._dist != null ? [h('span', { class: 'distance' }, fmtDistance(r._dist)), ' · '] : null,
            `${r.district} · ${r.category.replaceAll('>', ' › ')}`),
          h('h2', { class: 'name' }, r.name),
          h('p', { class: 'addr' }, r.address)),
        h('dl', { class: 'scores' },
          h('div', {}, h('dt', {}, '네이버'), h('dd', { class: 'score-naver' }, fmtRating(r.naver_rating))),
          h('div', {}, h('dt', {}, '카카오'), h('dd', { class: 'score-kakao' }, fmtRating(r.kakao_rating))))),
      h('dl', { class: 'facts' },
        h('div', {}, h('dt', {}, '방송'), h('dd', { class: 'tv' }, shows)),
        h('div', {}, h('dt', {}, '주차'), h('dd', { class: 'parking', dataset: { available: String(r.parking.available) } },
          r.parking.available ? '가능' : '불가',
          r.parking.note ? h('span', { class: 'note' }, ` · ${r.parking.note}`) : null)),
        h('div', {}, h('dt', {}, '휴무'), h('dd', { class: 'closed' },
          closed,
          isClosedToday(r) ? h('span', { class: 'badge' }, '오늘 휴무') : null,
          r.closed_note ? h('span', { class: 'note' }, ` · ${r.closed_note}`) : null))),
      h('div', { class: 'actions' },
        h('a', { class: 'naver-link', href: naverUrl(r), target: '_blank', rel: 'noopener noreferrer' }, '네이버 지도에서 열기 ↗'),
        r.lat != null && r.lng != null
          ? h('button', { type: 'button', class: 'show-on-map', dataset: { id: r.id } }, '지도에서 보기')
          : null)));
  }

  // ------------------------------------------------------------ 지도

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // 식사는 꽉 찬 원, 디저트·카페는 속이 빈 원
  function markerStyle(selected, kind) {
    const dessert = kind === 'dessert';
    return {
      radius: selected ? 10 : 7,
      weight: dessert ? 3 : 2,
      color: dessert ? cssVar('--ink') : cssVar('--paper'),
      fillColor: dessert ? cssVar('--paper') : cssVar('--ink'),
      fillOpacity: dessert ? 1 : (selected ? 1 : 0.85),
    };
  }

  function ensureMap() {
    if (map) return;
    map = L.map('map', { zoomControl: true }).setView(SEOUL, 11);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);
    renderMe();
    renderMarkers();
  }

  function popupContent(r) {
    const button = h('button', { type: 'button', class: 'pop-list' }, '목록에서 보기');
    button.addEventListener('click', () => showInList(r.id));
    return h('div', { class: 'pop' },
      h('strong', {}, r.name),
      h('div', { class: 'pop-scores' }, `네이버 ${fmtRating(r.naver_rating)} · 카카오 ${fmtRating(r.kakao_rating)}`),
      r._dist != null ? h('div', {}, `직선 ${fmtDistance(r._dist)}`) : null,
      button);
  }

  function renderMarkers() {
    if (!map) return;
    markerLayer.clearLayers();
    markers.clear();
    const points = [];
    for (const r of state.visible) {
      if (r.lat == null || r.lng == null) continue;
      const marker = L.circleMarker([r.lat, r.lng], markerStyle(r.id === state.selected, r.kind));
      marker.bindPopup(() => popupContent(r));
      marker.on('click', () => select(r.id, 'map'));
      marker.addTo(markerLayer);
      markers.set(r.id, marker);
      points.push([r.lat, r.lng]);
    }
    // 거리순일 때는 내 위치와 가까운 곳 10개가 보이게, 아니면 전체가 보이게 맞춘다
    const fit = state.pos && state.sort === 'near'
      ? [[state.pos.lat, state.pos.lng], ...points.slice(0, 10)]
      : points;
    if (fit.length) map.fitBounds(fit, { padding: [32, 32], maxZoom: 15 });
  }

  // ------------------------------------------------------------ 내 위치

  function renderMe() {
    if (!map || !state.pos) return;
    const latlng = [state.pos.lat, state.pos.lng];
    if (meMarker) {
      meMarker.setLatLng(latlng);
      return;
    }
    meMarker = L.marker(latlng, {
      icon: L.divIcon({ className: 'me-marker', html: '<span>내 위치</span>', iconSize: [64, 24] }),
      interactive: false, keyboard: false, zIndexOffset: 1000,
    }).addTo(map);
  }

  function locationMessage(text) {
    $('loc-msg').textContent = text;
    $('loc-msg').hidden = false;
  }

  function locate() {
    if (!navigator.geolocation || !window.isSecureContext) {
      locationMessage('이 주소에서는 위치를 쓸 수 없습니다. HTTPS나 localhost에서 열어 주세요.');
      return;
    }
    $('locate').disabled = true;
    locationMessage('위치를 확인하는 중입니다…');
    navigator.geolocation.getCurrentPosition((position) => {
      $('locate').disabled = false;
      // 위치는 이 화면에서만 쓰고 저장하거나 보내지 않는다
      state.pos = { lat: position.coords.latitude, lng: position.coords.longitude };
      for (const r of state.items) {
        r._dist = r.lat != null && r.lng != null ? distanceMeters(state.pos, r) : null;
      }
      state.sort = 'near';
      $('sort').querySelector('option[value="near"]').disabled = false;
      $('sort').value = 'near';
      const accuracy = Math.round(position.coords.accuracy || 0);
      locationMessage(`내 위치 기준 직선거리입니다${accuracy > 100 ? ` (위치 오차 약 ${fmtDistance(accuracy)})` : ''}.`);
      renderMe();
      render();
      $('list-panel').scrollTop = 0;
    }, (error) => {
      $('locate').disabled = false;
      locationMessage(error.code === 1
        ? '위치 권한이 꺼져 있습니다. 브라우저의 사이트 설정에서 위치를 허용해 주세요.'
        : '위치를 확인하지 못했습니다. 잠시 뒤 다시 눌러 주세요.');
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  }

  function select(id, from) {
    state.selected = id;
    for (const el of document.querySelectorAll('.item.is-selected')) el.classList.remove('is-selected');
    const el = document.querySelector(`.item[data-id="${CSS.escape(id)}"]`);
    if (el) el.classList.add('is-selected');
    const kindOf = Object.fromEntries(state.visible.map((r) => [r.id, r.kind]));
    for (const [markerId, marker] of markers) {
      marker.setStyle(markerStyle(markerId === id, kindOf[markerId]));
      if (markerId === id) marker.bringToFront();
    }
    if (from === 'map' && el && wide.matches) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function showOnMap(id) {
    if (!wide.matches) setView('map');
    ensureMap();
    const marker = markers.get(id);
    if (!marker) return;
    select(id, 'list');
    map.setView(marker.getLatLng(), Math.max(map.getZoom(), 15));
    marker.openPopup();
  }

  function showInList(id) {
    setView('list');
    select(id, 'map');
    const el = document.querySelector(`.item[data-id="${CSS.escape(id)}"]`);
    if (el) el.scrollIntoView({ block: 'center' });
  }

  function setView(view) {
    state.view = view;
    $('layout').dataset.view = view;
    $('tab-list').setAttribute('aria-selected', String(view === 'list'));
    $('tab-map').setAttribute('aria-selected', String(view === 'map'));
    if (view === 'map') {
      ensureMap();
      map.invalidateSize();
    }
  }

  // ------------------------------------------------------------ 이벤트

  $('q').addEventListener('input', (e) => { state.q = e.target.value; update(); });
  $('f-parking').addEventListener('change', (e) => { state.parkingOnly = e.target.checked; update(); });
  $('f-open').addEventListener('change', (e) => { state.hideClosedToday = e.target.checked; update(); });
  $('sort').addEventListener('change', (e) => { state.sort = e.target.value; render(); });
  $('kinds').addEventListener('click', (e) => {
    const button = e.target.closest('.chip');
    if (!button) return;
    state.kind = button.dataset.kind;
    update();
  });
  $('chips').addEventListener('click', (e) => {
    const button = e.target.closest('.chip');
    if (!button) return;
    state.district = button.dataset.district;
    update();
  });
  $('locate').addEventListener('click', locate);
  $('tab-list').addEventListener('click', () => setView('list'));
  $('tab-map').addEventListener('click', () => setView('map'));
  $('list').addEventListener('click', (e) => {
    const button = e.target.closest('.show-on-map');
    if (button) showOnMap(button.dataset.id);
  });
  wide.addEventListener('change', () => {
    if (wide.matches) {
      ensureMap();
      map.invalidateSize();
    }
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {
        $('status').textContent += ' (오프라인 저장을 켜지 못했습니다)';
      });
    });
  }

  load();
})();
