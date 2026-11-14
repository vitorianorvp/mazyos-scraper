// MazyOS Scraper: interface sobre a API do google-maps-scraper.
(function () {
    'use strict';

    // Quantidade escolhida -> profundidade de rolagem no Maps e tempo limite padrão.
    var QTY = {
        20: { depth: 2, label: '~1 min', max: 600 },
        60: { depth: 5, label: '~3 min', max: 1200 },
        120: { depth: 10, label: '~6 min', max: 1800 },
        200: { depth: 18, label: '15+ min', max: 3600 }
    };

    var STATUS = { pending: 'Na fila', working: 'Buscando', ok: 'Concluída', failed: 'Falhou' };

    var $ = function (id) { return document.getElementById(id); };

    var state = {
        qty: 60,
        radiusKm: 5,
        email: false,
        geo: null,          // { lat, lon, label }
        jobs: [],
        counts: {},         // jobId -> nº de empresas
        selected: null,     // job selecionado
        places: [],
        filter: 'all',
        view: 'map',
        preset: null,       // id do preset de parceiro ativo
        hidden: [],         // lista "não contatar": { key, phone, title, date }
        hiddenOpen: false
    };

    // Parceiros B2B para a Celi (Maceió-AL), em ordem de prioridade.
    var PRESETS = [
        { id: 'construtoras', nome: 'Construtoras e incorporadoras de MCMV', termos: ['construtora', 'incorporadora', 'construtora minha casa minha vida'], why: 'Têm estoque de imóveis MCMV para vender.' },
        { id: 'correspondentes', nome: 'Correspondentes bancários da Caixa', termos: ['correspondente bancário caixa', 'correspondente caixa habitação'], why: 'Parceiro-chave: aprovação de crédito.' },
        { id: 'empresas', nome: 'Empresas com muitos funcionários de renda média-baixa', termos: ['indústria', 'supermercado', 'call center', 'hospital'], why: 'O RH pode indicar funcionários (leads em volume).' },
        { id: 'contadores', nome: 'Contadores de MEI e pequenos negócios', termos: ['contabilidade', 'contador MEI'], why: 'Ajudam a comprovar renda informal.' },
        { id: 'administradoras', nome: 'Administradoras de condomínio e imobiliárias de aluguel', termos: ['administradora de condomínio', 'imobiliária aluguel'], why: 'Inquilino que pode virar comprador.' },
        { id: 'igrejas', nome: 'Igrejas e associações de bairro', termos: ['igreja', 'associação de moradores'], why: 'Indicação de confiança na comunidade.' },
        { id: 'arquitetos', nome: 'Arquitetos', termos: ['arquiteto'], why: 'Indicam clientes que estão construindo ou reformando.', low: true },
        { id: 'advogados', nome: 'Advogados de inventário', termos: ['advogado inventário'], why: 'Clientes com imóvel de herança para vender ou regularizar.', low: true }
    ];

    // Bairros de Maceió. loc/km: só para "Maceió inteira" e região metropolitana (raio sugerido).
    var BAIRROS = [
        { nome: 'Benedito Bentes', mcmv: true },
        { nome: 'Cidade Universitária', mcmv: true },
        { nome: 'Rio Novo', mcmv: true },
        { nome: 'Santos Dumont', mcmv: true },
        { nome: 'Antares', mcmv: true },
        { nome: 'Santa Lúcia', mcmv: true },
        { nome: 'Maceió inteira', loc: 'Maceió - AL', km: 12 },
        { nome: 'Região metropolitana de Maceió', loc: 'Região metropolitana de Maceió - AL', km: 30 }
    ];

    // ---------- Mapa ----------

    var map = L.map('map', { zoomControl: false, attributionControl: true })
        .setView([-9.6658, -35.7353], 12); // centro de Maceió-AL
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    map.attributionControl.setPrefix('Leaflet');
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        subdomains: 'abc',
        attribution: '&copy; OpenStreetMap'
    }).addTo(map);

    var circle = null;
    var markers = L.layerGroup().addTo(map);
    var markerByKey = {};

    function panelOffset() {
        return window.innerWidth > 900 ? [440, 40] : [40, 40];
    }

    function drawCircle(lat, lon, km, fit) {
        if (circle) map.removeLayer(circle);
        circle = L.circle([lat, lon], {
            radius: km * 1000,
            color: '#0a0a0a',
            weight: 2,
            dashArray: '6 6',
            fillColor: '#0a0a0a',
            fillOpacity: 0.06
        }).addTo(map);
        if (fit) {
            map.flyToBounds(circle.getBounds(), {
                paddingTopLeft: panelOffset(),
                paddingBottomRight: [40, 40],
                duration: 0.8
            });
        }
    }

    function distKm(aLat, aLon, bLat, bLon) {
        var r = Math.PI / 180;
        var dLat = (bLat - aLat) * r;
        var dLon = (bLon - aLon) * r;
        var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    }

    function zoomFor(km) {
        if (km <= 1.5) return 16;
        if (km <= 3) return 15;
        if (km <= 7) return 14;
        if (km <= 15) return 13;
        return 12;
    }

    // ---------- Formatação ----------

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function digits(phone) { return String(phone || '').replace(/\D/g, ''); }

    // Celular brasileiro: DDD + 9 dígitos começando com 9.
    function whatsapp(phone) {
        var d = digits(phone);
        if (d.indexOf('55') === 0 && d.length === 13) d = d.slice(2);
        if (d.length === 11 && d.charAt(2) === '9') return '55' + d;
        return null;
    }

    function siteKind(url) {
        if (!url) return 'none';
        if (/instagram\.com|facebook\.com|linktr\.ee|wa\.me|whatsapp\.com|tiktok\.com/i.test(url)) return 'social';
        return 'site';
    }

    function domain(url) {
        return String(url).replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[?#].*$/, '').replace(/\/$/, '');
    }

    function rating(n) { return n ? n.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : ''; }
    function int(n) { return Number(n || 0).toLocaleString('pt-BR'); }

    function norm(s) { return String(s || '').trim().toLowerCase(); }

    // Segmento da busca: compara o termo de cada keyword ("termo em local") com os presets.
    function presetForJob(job) {
        var kws = (job && job.Data && job.Data.keywords) || [];
        for (var i = 0; i < PRESETS.length; i++) {
            for (var k = 0; k < kws.length; k++) {
                var term = norm(String(kws[k]).split(' em ')[0]);
                if (PRESETS[i].termos.some(function (t) { return norm(t) === term; })) return PRESETS[i];
            }
        }
        return null;
    }

    // Bairro da busca (primeira parte do local, depois de " em "): "Benedito Bentes".
    function jobBairro(job) {
        var kw = job && job.Data && job.Data.keywords && job.Data.keywords[0];
        var parts = String(kw || '').split(' em ');
        return parts.length > 1 ? parts.slice(1).join(' em ').split(',')[0].trim() : '';
    }

    function dateBR(iso) {
        var d = new Date(iso);
        return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    }

    function toast(msg) {
        var t = $('toast');
        t.textContent = msg;
        t.classList.add('on');
        clearTimeout(toast.timer);
        toast.timer = setTimeout(function () { t.classList.remove('on'); }, 2200);
    }

    var ICON = {
        list: '<svg viewBox="0 0 24 24"><path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r=".6"/><circle cx="4" cy="12" r=".6"/><circle cx="4" cy="18" r=".6"/></svg>',
        trash: '<svg viewBox="0 0 24 24" style="width:16px;height:16px"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
        phone: '<svg viewBox="0 0 24 24"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>',
        globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
        pin: '<svg viewBox="0 0 24 24"><path d="M12 21s-7-6.1-7-11.5a7 7 0 0 1 14 0C19 14.9 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
        mail: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>',
        arrow: '<svg viewBox="0 0 24 24" style="width:15px;height:15px"><path d="M7 17 17 7M8 7h9v9"/></svg>'
    };

    // ---------- Formulário ----------

    function updateQtyDesc() {
        var q = QTY[state.qty];
        $('qtyDesc').textContent = 'Aproximado, leva ' + q.label + (state.email ? ' + e-mails' : '');
    }

    function updateRange() {
        var el = $('radius');
        var pct = (el.value - el.min) / (el.max - el.min) * 100;
        el.style.background = 'linear-gradient(to right, #0a0a0a ' + pct + '%, #ebebeb ' + pct + '%)';
        $('radiusVal').textContent = el.value + ' km';
    }

    function segmented(containerId, attr, onPick) {
        $(containerId).addEventListener('click', function (e) {
            var b = e.target.closest('button');
            if (!b) return;
            Array.prototype.forEach.call(this.children, function (c) { c.classList.toggle('on', c === b); });
            onPick(b.getAttribute(attr));
        });
    }

    segmented('qty', 'data-qty', function (v) { state.qty = Number(v); updateQtyDesc(); });

    $('radius').addEventListener('input', function () {
        state.radiusKm = Number(this.value);
        updateRange();
        if (state.geo) drawCircle(state.geo.lat, state.geo.lon, state.radiusKm, false);
    });
    $('radius').addEventListener('change', function () {
        if (state.geo) drawCircle(state.geo.lat, state.geo.lon, state.radiusKm, true);
    });

    $('email').addEventListener('click', function () {
        state.email = !state.email;
        this.setAttribute('aria-pressed', String(state.email));
        updateQtyDesc();
    });

    // Geolocaliza o texto do campo "Onde?" (OpenStreetMap / Nominatim).
    var geoTimer = null;
    var geoSeq = 0;
    var hintDefault = $('locHint').innerHTML;

    function geocode(text) {
        var seq = ++geoSeq;
        $('locSpin').classList.add('on');
        var base = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=pt-BR&q=' + encodeURIComponent(text);
        return fetch(base + '&countrycodes=br')
            .then(function (r) { return r.json(); })
            .then(function (res) { return res.length ? res : fetch(base).then(function (r) { return r.json(); }); })
            .then(function (res) {
                if (seq !== geoSeq) return;
                $('locSpin').classList.remove('on');
                if (!res.length) {
                    state.geo = null;
                    $('locHint').className = 'hint';
                    $('locHint').textContent = 'Não achei esse local no mapa. A busca ainda funciona, só sem raio.';
                    return;
                }
                var parts = res[0].display_name.split(',').map(function (s) { return s.trim(); });
                state.geo = { lat: Number(res[0].lat), lon: Number(res[0].lon), label: parts.slice(0, 3).join(', ') };
                $('locHint').className = 'hint ok';
                $('locHint').textContent = state.geo.label;
                drawCircle(state.geo.lat, state.geo.lon, state.radiusKm, true);
            })
            .catch(function () {
                if (seq !== geoSeq) return;
                $('locSpin').classList.remove('on');
                state.geo = null;
            });
    }

    $('loc').addEventListener('input', function () {
        clearTimeout(geoTimer);
        var v = this.value.trim();
        if (!v) {
            state.geo = null;
            $('locHint').className = 'hint';
            $('locHint').innerHTML = hintDefault;
            if (circle) { map.removeLayer(circle); circle = null; }
            return;
        }
        geoTimer = setTimeout(function () { geocode(v); }, 650);
    });

    // ---------- Presets de parceiro e bairros ----------

    function qTerms() {
        return $('q').value.split(',').map(norm).filter(Boolean);
    }

    // O preset fica ativo só enquanto os termos do campo batem com os dele.
    function syncPreset() {
        var cur = qTerms().sort().join('|');
        var found = PRESETS.filter(function (p) {
            return p.termos.map(norm).sort().join('|') === cur;
        })[0];
        state.preset = found ? found.id : null;
        Array.prototype.forEach.call($('presets').children, function (b) {
            b.classList.toggle('on', b.getAttribute('data-preset') === state.preset);
        });
        $('presetWhy').textContent = found ? 'Por que é parceiro: ' + found.why : '';
    }

    $('presets').innerHTML = PRESETS.map(function (p, i) {
        return '<button type="button" class="' + (p.low ? 'low' : '') + '" data-preset="' + p.id + '">' +
            (p.low ? '' : (i + 1) + '. ') + esc(p.nome) + '</button>';
    }).join('');

    $('presets').addEventListener('click', function (e) {
        var b = e.target.closest('button');
        if (!b) return;
        var p = PRESETS.filter(function (x) { return x.id === b.getAttribute('data-preset'); })[0];
        $('q').value = p.termos.join(', ');
        syncPreset();
    });
    $('q').addEventListener('input', syncPreset);

    $('bairros').innerHTML = BAIRROS.map(function (b, i) {
        return '<button type="button" data-b="' + i + '">' + esc(b.nome) +
            (b.mcmv ? ' <span class="tag mcmv">MCMV</span>' : '') + '</button>';
    }).join('');

    function syncBairros() {
        var v = norm($('loc').value);
        Array.prototype.forEach.call($('bairros').children, function (btn) {
            var b = BAIRROS[Number(btn.getAttribute('data-b'))];
            btn.classList.toggle('on', v === norm(b.loc || b.nome + ', Maceió - AL'));
        });
    }

    $('bairros').addEventListener('click', function (e) {
        var btn = e.target.closest('button');
        if (!btn) return;
        var b = BAIRROS[Number(btn.getAttribute('data-b'))];
        $('loc').value = b.loc || b.nome + ', Maceió - AL';
        var km = b.km || 5; // bairro sem km: volta a 5 km, sem herdar os 12 de Maceió inteira
        state.radiusKm = km;
        $('radius').value = km;
        updateRange();
        syncBairros();
        clearTimeout(geoTimer);
        geocode($('loc').value);
    });
    $('loc').addEventListener('input', syncBairros);

    function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

    function submit() {
        var terms = $('q').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        var loc = $('loc').value.trim();
        $('err').textContent = '';
        if (!terms.length) { $('q').focus(); return; }

        var q = QTY[state.qty];
        var maxSel = $('maxTime').value;
        var maxTime = maxSel === 'auto' ? q.max * (state.email ? 2 : 1) : Number(maxSel);
        var shortLoc = loc ? loc.split(',')[0].trim() : '';

        var body = {
            name: terms.map(cap).join(', ') + (shortLoc ? ' · ' + cap(shortLoc) : ''),
            keywords: terms.map(function (t) { return loc ? t + ' em ' + loc : t; }),
            lang: $('lang').value,
            zoom: zoomFor(state.radiusKm),
            radius: state.radiusKm * 1000,
            depth: q.depth,
            email: state.email,
            max_time: maxTime
        };
        if (state.geo) {
            body.lat = String(state.geo.lat);
            body.lon = String(state.geo.lon);
        }

        $('go').disabled = true;
        $('go').textContent = 'Enviando...';
        fetch('/api/v1/jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        })
            .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.message || 'Erro'); return j; }); })
            .then(function (res) {
                toast('Busca enviada. As empresas vão aparecendo no mapa.');
                return loadJobs().then(function () {
                    var job = state.jobs.filter(function (j) { return j.ID === res.id; })[0];
                    if (job) selectJob(job);
                });
            })
            .catch(function (e) { $('err').textContent = 'Não consegui iniciar a busca: ' + e.message; })
            .then(function () {
                $('go').disabled = false;
                $('go').textContent = 'Buscar empresas';
            });
    }

    $('go').addEventListener('click', submit);
    ['q', 'loc'].forEach(function (id) {
        $(id).addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    });

    document.addEventListener('keydown', function (e) {
        if (e.key === '/' && document.activeElement.tagName !== 'INPUT') {
            e.preventDefault();
            $('q').focus();
        }
    });

    // ---------- Suas buscas ----------

    function loadJobs() {
        return fetch('/api/v1/jobs')
            .then(function (r) { return r.json(); })
            .then(function (jobs) {
                $('engine').className = 'engine on';
                $('engine').innerHTML = '<i></i>motor online';
                state.jobs = (jobs || []).sort(function (a, b) { return new Date(b.Date) - new Date(a.Date); });
                if (state.selected) {
                    var fresh = state.jobs.filter(function (j) { return j.ID === state.selected.ID; })[0];
                    if (fresh) state.selected = fresh;
                }
                countMissing();
                renderJobs();
            })
            .catch(function () {
                $('engine').className = 'engine';
                $('engine').innerHTML = '<i></i>motor offline';
            });
    }

    function countMissing() {
        state.jobs.forEach(function (j) {
            if (j.Status === 'ok' && state.counts[j.ID] == null) {
                state.counts[j.ID] = '...';
                fetch('/api/v1/jobs/' + j.ID + '/places')
                    .then(function (r) { return r.json(); })
                    .then(function (p) { state.counts[j.ID] = p.length; renderJobs(); });
            }
        });
    }

    var pendingDelete = null;

    function renderJobs() {
        var list = $('jobList');
        if (!state.jobs.length) {
            list.innerHTML = '<div class="jobs-empty">Nenhuma busca ainda. A primeira aparece aqui.</div>';
            return;
        }
        list.innerHTML = state.jobs.map(function (j) {
            var sel = state.selected && state.selected.ID === j.ID;
            var st = STATUS[j.Status] || j.Status;
            var meta = [];
            if (j.Status === 'working' || j.Status === 'pending') {
                meta.push('<span class="run">' + st + '</span>');
                if (sel && state.places.length) meta.push('<b>' + state.places.length + '</b> até agora');
            } else {
                meta.push(st);
                if (j.Status === 'ok' && typeof state.counts[j.ID] === 'number') meta.push('<b>' + state.counts[j.ID] + '</b> empresas');
            }
            var seg = presetForJob(j);
            if (seg) meta.push('<span class="seg-tag">' + esc(seg.nome) + '</span>');
            meta.push(dateBR(j.Date));
            if (j.Data && j.Data.email) meta.push('com e-mails');
            var conf = pendingDelete === j.ID;
            return '<div class="job' + (sel ? ' sel' : '') + '" data-id="' + j.ID + '">' +
                '<div class="job-icon">' + ICON.list + '</div>' +
                '<div class="job-body"><div class="job-name">' + esc(j.Name) + '</div>' +
                '<div class="job-meta">' + meta.join(' · ') + '</div></div>' +
                '<button type="button" class="job-del' + (conf ? ' confirm' : '') + '" data-del="' + j.ID + '" title="Excluir">' +
                (conf ? 'Excluir?' : ICON.trash) + '</button></div>';
        }).join('');
    }

    $('jobList').addEventListener('click', function (e) {
        var del = e.target.closest('[data-del]');
        if (del) {
            var id = del.getAttribute('data-del');
            if (pendingDelete !== id) {
                pendingDelete = id;
                renderJobs();
                setTimeout(function () { if (pendingDelete === id) { pendingDelete = null; renderJobs(); } }, 3000);
                return;
            }
            pendingDelete = null;
            fetch('/api/v1/jobs/' + id, { method: 'DELETE' }).then(function () {
                if (state.selected && state.selected.ID === id) clearSelection();
                loadJobs();
            });
            return;
        }
        var row = e.target.closest('.job');
        if (!row) return;
        var job = state.jobs.filter(function (j) { return j.ID === row.getAttribute('data-id'); })[0];
        if (job) selectJob(job);
    });

    function clearSelection() {
        state.selected = null;
        state.places = [];
        markers.clearLayers();
        markerByKey = {};
        $('livebar').hidden = true;
        renderBoard();
    }

    function jobCenter(job) {
        var d = job.Data || {};
        var lat = Number(d.lat), lon = Number(d.lon);
        if (!d.lat || !d.lon || isNaN(lat) || isNaN(lon)) return null;
        return { lat: lat, lon: lon, km: (d.radius || 5000) / 1000 };
    }

    function selectJob(job) {
        var changed = !state.selected || state.selected.ID !== job.ID;
        state.selected = job;
        if (changed) {
            state.places = [];
            state.filter = 'all';
            markers.clearLayers();
            markerByKey = {};
            var c = jobCenter(job);
            if (c) drawCircle(c.lat, c.lon, c.km, true);
        }
        renderJobs();
        loadPlaces(changed);
    }

    // ---------- Empresas ----------

    function placeKey(p) { return p.link || (p.title + p.latitude + p.longitude); }

    // ---------- Não contatar ----------

    // Telefone sem DDI/máscara, para reconhecer a mesma empresa em buscas diferentes.
    function phoneKey(phone) {
        var d = digits(phone);
        if (d.indexOf('55') === 0 && d.length > 11) d = d.slice(2);
        return d;
    }

    function isHidden(p) {
        var k = placeKey(p), ph = phoneKey(p.phone);
        return state.hidden.some(function (h) { return h.key === k || (ph && h.phone === ph); });
    }

    function visiblePlaces() { return state.places.filter(function (p) { return !isHidden(p); }); }

    function saveHidden() {
        return fetch('/api/v1/nao-contatar', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(state.hidden)
        }).then(function (r) { if (!r.ok) throw new Error(); })
            .catch(function () { toast('Não consegui salvar a lista "não contatar".'); });
    }

    function loadHidden() {
        return fetch('/api/v1/nao-contatar')
            .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
            .then(function (list) { state.hidden = list || []; refreshPlaces(); })
            .catch(function () { toast('Não consegui carregar a lista "não contatar". Ela pode estar incompleta.'); });
    }

    function refreshPlaces() {
        markers.clearLayers();
        markerByKey = {};
        addMarkers(state.places);
        renderLive();
        renderBoard();
    }

    function hidePlace(p) {
        state.hidden.push({ key: placeKey(p), phone: phoneKey(p.phone), title: p.title, date: new Date().toISOString() });
        map.closePopup();
        refreshPlaces();
        saveHidden();
        toast(p.title + ' saiu da lista (não contatar)');
    }

    function unhide(i) {
        state.hidden.splice(i, 1);
        refreshPlaces();
        saveHidden();
    }

    function renderHidden() {
        var n = state.hidden.length;
        $('hiddenBar').hidden = !n;
        $('hiddenToggle').textContent = n + (n === 1 ? ' oculta' : ' ocultas') + ' (não contatar) · ' + (state.hiddenOpen ? 'esconder lista' : 'ver lista');
        $('hiddenList').hidden = !state.hiddenOpen || !n;
        $('hiddenList').innerHTML = state.hidden.map(function (h, i) {
            return '<div><span>' + esc(h.title) + '</span><button type="button" class="nc-btn" data-undo="' + i + '">Desfazer</button></div>';
        }).join('');
    }

    $('hiddenToggle').addEventListener('click', function () {
        state.hiddenOpen = !state.hiddenOpen;
        renderHidden();
    });
    $('hiddenList').addEventListener('click', function (e) {
        var b = e.target.closest('[data-undo]');
        if (b) unhide(Number(b.getAttribute('data-undo')));
    });

    // Botão do popup do mapa (o HTML do popup é criado fora do fluxo normal).
    document.addEventListener('click', function (e) {
        var b = e.target.closest('[data-nc]');
        if (!b) return;
        var k = b.getAttribute('data-nc');
        var p = state.places.filter(function (x) { return placeKey(x) === k; })[0];
        if (p) hidePlace(p);
    });

    function popupHtml(p) {
        var wa = whatsapp(p.phone);
        var links = [];
        if (p.phone) {
            links.push(wa
                ? '<a href="https://wa.me/' + wa + '" target="_blank" rel="noopener">' + ICON.phone + esc(p.phone) + ' · WhatsApp</a>'
                : '<a href="tel:' + digits(p.phone) + '">' + ICON.phone + esc(p.phone) + '</a>');
        }
        if (p.website) links.push('<a href="' + esc(p.website) + '" target="_blank" rel="noopener">' + ICON.globe + esc(domain(p.website)) + '</a>');
        if (p.emails) links.push('<a href="mailto:' + esc(p.emails.split(',')[0]) + '">' + ICON.mail + esc(p.emails.split(',')[0]) + '</a>');
        if (p.link) links.push('<a href="' + esc(p.link) + '" target="_blank" rel="noopener">' + ICON.pin + 'Abrir no Google Maps</a>');
        links.push('<button type="button" class="nc-btn" data-nc="' + esc(placeKey(p)) + '">Não contatar</button>');
        return '<div class="pop-title">' + esc(p.title) + '</div>' +
            '<div class="pop-cat">' + esc([p.category, p.borough].filter(Boolean).join(' · ')) + '</div>' +
            (siteKind(p.website) === 'none' ? '<div style="margin-top:8px"><span class="tag dark">Sem site</span></div>' : '') +
            (p.review_rating ? '<div class="pop-rate">★ <b>' + rating(p.review_rating) + '</b> <span style="color:#8a8a8a">(' + int(p.review_count) + ' avaliações)</span></div>' : '') +
            (links.length ? '<div class="pop-links">' + links.join('') + '</div>' : '');
    }

    function addMarkers(list) {
        var c = state.selected ? jobCenter(state.selected) : null;
        list.forEach(function (p) {
            var key = placeKey(p);
            if (markerByKey[key] || isHidden(p)) return;
            var out = c && distKm(c.lat, c.lon, p.latitude, p.longitude) > c.km;
            var m = L.marker([p.latitude, p.longitude], {
                icon: L.divIcon({ className: '', html: '<div class="pin' + (out ? ' out' : '') + '"></div>', iconSize: [14, 14], iconAnchor: [7, 7] })
            }).bindPopup(popupHtml(p), { closeButton: false, offset: [0, -4] });
            markers.addLayer(m);
            markerByKey[key] = m;
        });
    }

    function loadPlaces(fit) {
        var job = state.selected;
        if (!job) return Promise.resolve();
        return fetch('/api/v1/jobs/' + job.ID + '/places')
            .then(function (r) { return r.json(); })
            .then(function (places) {
                if (!state.selected || state.selected.ID !== job.ID) return;
                // Durante a busca o CSV está sendo escrito: nunca regride a lista.
                if (places.length < state.places.length) return;
                state.places = places;
                if (job.Status === 'ok') state.counts[job.ID] = places.length;
                addMarkers(places);
                if (fit && places.length && !jobCenter(job)) {
                    map.flyToBounds(L.latLngBounds(places.map(function (p) { return [p.latitude, p.longitude]; })), {
                        paddingTopLeft: panelOffset(), paddingBottomRight: [40, 40], duration: 0.8
                    });
                }
                renderLive();
                renderJobs();
                renderBoard();
            });
    }

    function renderLive() {
        var job = state.selected;
        if (!job) { $('livebar').hidden = true; return; }
        var running = job.Status === 'working' || job.Status === 'pending';
        $('livebar').hidden = state.view !== 'map';
        $('liveDot').className = 'live-dot' + (running ? ' run' : '');
        var n = visiblePlaces().length;
        $('liveText').innerHTML = running
            ? (job.Status === 'pending' ? 'Na fila, já começa' : 'Buscando: <b>' + n + '</b> empresas até agora')
            : '<b>' + n + '</b> empresas em ' + esc(job.Name);
        $('liveDownload').hidden = running || !n;
    }

    // ---------- Painel ----------

    function filtered() {
        var txt = $('filterText').value.trim().toLowerCase();
        return visiblePlaces().filter(function (p) {
            var k = siteKind(p.website);
            if (state.filter === 'nosite' && k !== 'none') return false;
            if (state.filter === 'social' && k !== 'social') return false;
            if (state.filter === 'whats' && !whatsapp(p.phone)) return false;
            if (state.filter === 'email' && !p.emails) return false;
            if (txt && (p.title + ' ' + p.borough + ' ' + p.category).toLowerCase().indexOf(txt) < 0) return false;
            return true;
        });
    }

    function renderBoard() {
        var job = state.selected;
        $('boardEmpty').hidden = !!job;
        $('boardMain').hidden = !job;
        if (!job) return;

        renderHidden();
        var all = visiblePlaces();
        var running = job.Status === 'working' || job.Status === 'pending';
        var seg = presetForJob(job);
        $('boardTitle').textContent = job.Name;
        $('boardMeta').textContent = (running ? 'Buscando agora · ' : '') + (seg ? seg.nome + ' · ' : '') + dateBR(job.Date) + ' · ' + (job.Data.keywords || []).join(', ');

        var rated = all.filter(function (p) { return p.review_rating; });
        var avg = rated.length ? rated.reduce(function (s, p) { return s + p.review_rating; }, 0) / rated.length : 0;
        var stats = [
            [int(all.length), 'Empresas'],
            [int(all.filter(function (p) { return whatsapp(p.phone); }).length), 'Com WhatsApp'],
            [int(all.filter(function (p) { return siteKind(p.website) === 'none'; }).length), 'Sem site'],
            [int(all.filter(function (p) { return siteKind(p.website) === 'social'; }).length), 'Só rede social'],
            [avg ? rating(avg) : '-', 'Nota média']
        ];
        $('stats').innerHTML = stats.map(function (s) {
            return '<div class="stat"><div class="stat-n">' + s[0] + '</div><div class="stat-l">' + s[1] + '</div></div>';
        }).join('');

        Array.prototype.forEach.call($('filters').children, function (b) {
            b.classList.toggle('on', b.getAttribute('data-f') === state.filter);
        });

        var rows = filtered();
        $('download').textContent = 'Baixar planilha (' + rows.length + ')';
        if (!rows.length) {
            $('rows').innerHTML = '<tr><td colspan="7" class="t-empty">' +
                (all.length ? 'Nenhuma empresa nesse filtro.' : (running ? 'As empresas aparecem aqui conforme a busca anda.' : 'Essa busca não trouxe empresas.')) +
                '</td></tr>';
            return;
        }
        $('rows').innerHTML = rows.map(function (p, i) {
            var k = siteKind(p.website);
            var site = k === 'none' ? '<span class="tag dark">Sem site</span>'
                : '<a class="t-site" href="' + esc(p.website) + '" target="_blank" rel="noopener">' + esc(domain(p.website)) + '</a>' +
                  (k === 'social' ? '<span class="tag">Rede social</span>' : '');
            var wa = whatsapp(p.phone);
            var phone = !p.phone ? '<span class="t-cat">sem telefone</span>'
                : wa ? '<a class="mono" href="https://wa.me/' + wa + '" target="_blank" rel="noopener">' + esc(p.phone) + '</a><span class="wa">WHATS</span>'
                : '<span class="mono">' + esc(p.phone) + '</span>';
            return '<tr data-i="' + i + '">' +
                '<td><div class="t-name">' + esc(p.title) + '</div><div class="t-cat">' + esc(p.category) + '</div></td>' +
                '<td>' + esc(p.borough) + '</td>' +
                '<td class="num">' + (p.review_rating ? '★ ' + rating(p.review_rating) + ' <span class="t-cat">(' + int(p.review_count) + ')</span>' : '') + '</td>' +
                '<td>' + phone + '</td>' +
                '<td>' + site + '</td>' +
                '<td>' + (p.link ? '<a href="' + esc(p.link) + '" target="_blank" rel="noopener" title="Abrir no Google Maps">' + ICON.arrow + '</a>' : '') + '</td>' +
                '<td><button type="button" class="nc-btn" data-nc-row="' + i + '">Não contatar</button></td>' +
                '</tr>';
        }).join('');
        renderBoard.rows = rows;
    }

    segmented('filters', 'data-f', function (v) { state.filter = v; renderBoard(); });
    $('filterText').addEventListener('input', renderBoard);

    // Clicar numa linha leva pro pin no mapa.
    $('rows').addEventListener('click', function (e) {
        if (e.target.closest('a')) return;
        var nc = e.target.closest('[data-nc-row]');
        if (nc) { hidePlace(renderBoard.rows[Number(nc.getAttribute('data-nc-row'))]); return; }
        var tr = e.target.closest('tr[data-i]');
        if (!tr) return;
        var p = renderBoard.rows[Number(tr.getAttribute('data-i'))];
        var m = markerByKey[placeKey(p)];
        setView('map');
        if (m) {
            map.flyTo(m.getLatLng(), 16, { duration: 0.6 });
            setTimeout(function () { m.openPopup(); }, 650);
        }
    });

    function setView(v) {
        state.view = v;
        Array.prototype.forEach.call($('viewSeg').children, function (b) {
            b.classList.toggle('on', b.getAttribute('data-view') === v);
        });
        $('board').hidden = v !== 'board';
        renderLive();
        if (v === 'board') renderBoard();
    }
    segmented('viewSeg', 'data-view', setView);

    // ---------- Exportação ----------

    function csvCell(v) {
        v = String(v == null ? '' : v);
        return /[";\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }

    function slug(s) {
        return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }

    // Planilha no padrão do Excel brasileiro: ponto e vírgula, vírgula decimal e BOM.
    function download(rows) {
        if (!state.selected || !rows.length) return;
        rows = rows.filter(function (p) { return !isHidden(p); });
        if (!rows.length) return;
        var seg = presetForJob(state.selected);
        var bairroBusca = jobBairro(state.selected);
        var head = ['Nome', 'Segmento', 'Bairro', 'Telefone', 'WhatsApp', 'Site', 'Nota', 'Nº avaliações', 'Endereço', 'Google Maps', 'Por que é parceiro'];
        var lines = [head.join(';')].concat(rows.map(function (p) {
            var wa = whatsapp(p.phone);
            return [p.title, seg ? seg.nome : '', p.borough || bairroBusca, p.phone, wa ? 'https://wa.me/' + wa : '', p.website,
                p.review_rating ? rating(p.review_rating) : '', p.review_count || '', p.address, p.link, seg ? seg.why : '']
                .map(csvCell).join(';');
        }));
        var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'parceiros-mcmv-' + slug(state.selected.Name) + '-' + new Date().toISOString().slice(0, 10) + '.csv';
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
        toast(rows.length + ' empresas exportadas');
    }

    $('download').addEventListener('click', function () { download(filtered()); });
    $('liveDownload').addEventListener('click', function () { download(visiblePlaces()); });

    $('copyPhones').addEventListener('click', function () {
        var phones = filtered().map(function (p) { return p.phone; }).filter(Boolean);
        if (!phones.length) return;
        navigator.clipboard.writeText(phones.join('\n')).then(function () {
            toast(phones.length + ' telefones copiados');
        });
    });

    // ---------- Ciclo ----------

    // Local padrão: "Maceió - AL" (igual ao botão "Maceió inteira"), com coordenadas fixas
    // para não depender do geocode na abertura. Digitar ou escolher outro bairro substitui.
    state.radiusKm = 12;
    $('radius').value = 12;
    state.geo = { lat: -9.6658, lon: -35.7353, label: 'Maceió, Alagoas, Brasil' };
    drawCircle(state.geo.lat, state.geo.lon, state.radiusKm, false);
    syncBairros();

    updateQtyDesc();
    updateRange();
    loadHidden();
    loadJobs();

    setInterval(function () {
        loadJobs().then(function () {
            var j = state.selected;
            if (j && (j.Status === 'working' || j.Status === 'pending' || state.counts[j.ID] !== state.places.length)) loadPlaces(false);
        });
    }, 3000);
})();
