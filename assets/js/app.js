/* ============================================================
   PRISKOLL — allt körs lokalt i webbläsaren.
   Data lagras i localStorage per leverantör (ingen server, ingen databas).
   Vill man senare byta till inloggning + molnlagring: byt bara ut
   loadSnapshot()/saveSnapshot()/loadMapping()/saveMapping() mot API-anrop.
   ============================================================ */
(function(){
  "use strict";

  var PDF_WORKER_CDN_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
  var pdfWorkerReady = null;

  function ensurePdfWorker(){
    if (pdfWorkerReady) return pdfWorkerReady;
    if (typeof pdfjsLib === "undefined") return Promise.reject(new Error("pdf.js kunde inte laddas (kontrollera internetanslutningen)."));
    pdfWorkerReady = fetch(PDF_WORKER_CDN_URL)
      .then(function(r){ if (!r.ok) throw new Error("worker fetch failed"); return r.text(); })
      .then(function(code){
        var blobUrl = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
        pdfjsLib.GlobalWorkerOptions.workerSrc = blobUrl;
      })
      .catch(function(){
        // Direkt CDN-URL som reserv om blob-vägen misslyckas (t.ex. offline).
        pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_CDN_URL;
      });
    return pdfWorkerReady;
  }

  /* ---------- Fält vi förstår + synonymer att gissa på ---------- */
  var FIELD_SYNONYMS = {
    namn: ["namn","produktnamn","produkt","artikel","artikelbeskrivning","beskrivning","benamning","vara","varunamn","varubenamning","name","product","description","text","varutext"],
    artikelnummer: ["artikelnr","artikelnummer","artnr","varunummer","ean","sku","bestnr","bestallningsnummer","id","nr"],
    kategori: ["kategori","grupp","varugrupp","typ","category","sortiment","huvudgrupp"],
    pris: ["pris","apris","styckpris","nettopris","listpris","prisst","price","inkopspris","kostnad","nettoprisst","brpris","aktpris"],
    enhet: ["enhet","forp","forpackning","unit","enh","forpackningsstorlek"],
    antal: ["antal","mangd","qty","quantity","kvantitet","st","styck"]
  };
  var FIELD_ORDER = ["namn","pris","kategori","enhet","antal","artikelnummer"];
  var FIELD_LABELS = {
    namn: "Namn", pris: "Pris", kategori: "Kategori",
    enhet: "Enhet", antal: "Antal", artikelnummer: "Artikelnr"
  };
  var REQUIRED_FIELDS = ["namn","pris"];

  /* ---------- State ---------- */
  var state = {
    supplier: "",
    headers: [],
    rows: [],          // raw data rows (arrays), after header row
    mapping: {},        // field -> header index
    items: [],          // parsed + diffed items
    removed: [],
    sort: { key: "diffPct", dir: "desc" }
  };

  /* ---------- Helpers ---------- */
  function $(sel, root){ return (root||document).querySelector(sel); }
  function $all(sel, root){ return Array.prototype.slice.call((root||document).querySelectorAll(sel)); }

  function slugify(s){
    return String(s||"").toLowerCase().trim()
      .replace(/[åä]/g,"a").replace(/ö/g,"o")
      .replace(/[^a-z0-9]+/g,"-").replace(/(^-|-$)/g,"");
  }
  function normalizeHeader(h){
    return String(h||"").toLowerCase()
      .replace(/[åä]/g,"a").replace(/ö/g,"o")
      .replace(/[^a-z0-9]/g,"");
  }
  function guessField(header){
    var norm = normalizeHeader(header);
    if (!norm) return null;
    for (var i=0;i<FIELD_ORDER.length;i++){
      var field = FIELD_ORDER[i];
      var words = FIELD_SYNONYMS[field];
      for (var j=0;j<words.length;j++){
        if (norm === words[j]) return field;
      }
    }
    for (var i2=0;i2<FIELD_ORDER.length;i2++){
      var field2 = FIELD_ORDER[i2];
      var words2 = FIELD_SYNONYMS[field2];
      for (var j2=0;j2<words2.length;j2++){
        if (norm.indexOf(words2[j2]) !== -1) return field2;
      }
    }
    return null;
  }
  function parsePrice(v){
    if (v === null || v === undefined) return null;
    if (typeof v === "number") return v;
    var s = String(v).trim();
    if (!s) return null;
    s = s.replace(/kr|sek|:-/gi, "").trim();
    s = s.replace(/\s| /g, "");
    if (s.indexOf(",") !== -1 && s.indexOf(".") !== -1){
      s = s.replace(/\./g, "").replace(",", ".");
    } else if (s.indexOf(",") !== -1){
      s = s.replace(",", ".");
    }
    var n = parseFloat(s);
    return isNaN(n) ? null : n;
  }
  function formatPris(n){
    if (n === null || n === undefined) return "—";
    return n.toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " kr";
  }
  function formatPct(n){
    if (n === null || n === undefined) return "";
    var sign = n > 0 ? "+" : "";
    return sign + n.toFixed(1).replace(".", ",") + "%";
  }
  function escapeHtml(s){
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  /* ---------- localStorage (per leverantör) ---------- */
  function suppliersListKey(){ return "pk_suppliers"; }
  function snapshotKey(slug){ return "pk_snapshot_" + slug; }
  function mappingKey(slug){ return "pk_mapping_" + slug; }

  function getKnownSuppliers(){
    try { return JSON.parse(localStorage.getItem(suppliersListKey())) || []; }
    catch(e){ return []; }
  }
  function rememberSupplier(name){
    var list = getKnownSuppliers();
    if (list.indexOf(name) === -1){
      list.push(name);
      localStorage.setItem(suppliersListKey(), JSON.stringify(list));
    }
  }
  function loadSnapshot(slug){
    try {
      var raw = localStorage.getItem(snapshotKey(slug));
      return raw ? JSON.parse(raw) : null;
    } catch(e){ return null; }
  }
  function saveSnapshot(slug, items){
    localStorage.setItem(snapshotKey(slug), JSON.stringify({ items: items, savedAt: new Date().toISOString() }));
  }
  function clearSnapshot(slug){
    localStorage.removeItem(snapshotKey(slug));
  }
  function loadMapping(slug){
    try {
      var raw = localStorage.getItem(mappingKey(slug));
      return raw ? JSON.parse(raw) : null;
    } catch(e){ return null; }
  }
  function saveMapping(slug, headerSignature, mapping){
    localStorage.setItem(mappingKey(slug), JSON.stringify({ signature: headerSignature, mapping: mapping }));
  }
  function headerSignature(headers){ return headers.map(normalizeHeader).join("|"); }

  /* ---------- Hitta rubrikrad + bygg rader ---------- */
  function findHeaderRowIndex(rows){
    var maxScan = Math.min(rows.length, 15);
    var bestIdx = 0, bestScore = -1;
    for (var i=0;i<maxScan;i++){
      var row = rows[i] || [];
      var nonEmpty = row.filter(function(c){ return c !== undefined && c !== null && String(c).trim() !== ""; });
      if (nonEmpty.length < 2) continue;
      var textish = nonEmpty.filter(function(c){
        return isNaN(parseFloat(String(c).replace(",", ".")));
      }).length;
      var score = nonEmpty.length + textish;
      if (score > bestScore){ bestScore = score; bestIdx = i; }
    }
    return bestIdx;
  }

  /* ---------- Diff mot förra listan ---------- */
  function itemKey(item){
    if (item.artikelnummer !== null && item.artikelnummer !== undefined && String(item.artikelnummer).trim() !== ""){
      return "id:" + String(item.artikelnummer).trim().toLowerCase();
    }
    return "namn:" + String(item.namn||"").trim().toLowerCase();
  }
  function computeDiff(current, previous){
    var prevMap = {};
    (previous||[]).forEach(function(p){ prevMap[itemKey(p)] = p; });
    var currentKeys = {};
    var items = current.map(function(item){
      var key = itemKey(item);
      currentKeys[key] = true;
      var prev = prevMap[key];
      if (!prev){
        return Object.assign({}, item, { status: "new", prevPris: null, diffPct: null });
      }
      if (prev.pris !== null && prev.pris !== undefined && item.pris !== null && item.pris !== undefined && prev.pris !== 0){
        var diffPct = ((item.pris - prev.pris) / prev.pris) * 100;
        if (Math.abs(diffPct) < 0.05){
          return Object.assign({}, item, { status: "unchanged", prevPris: prev.pris, diffPct: 0 });
        }
        return Object.assign({}, item, { status: diffPct > 0 ? "up" : "down", prevPris: prev.pris, diffPct: diffPct });
      }
      return Object.assign({}, item, { status: "unchanged", prevPris: prev.pris, diffPct: 0 });
    });
    var removed = (previous||[]).filter(function(p){ return !currentKeys[itemKey(p)]; })
      .map(function(p){ return Object.assign({}, p, { status: "removed", diffPct: null }); });
    return { items: items, removed: removed };
  }

  /* ---------- Skärmar ---------- */
  var screenUpload = $("#screenUpload");
  var screenMapping = $("#screenMapping");
  var screenDashboard = $("#screenDashboard");
  var supplierSwitch = $("#supplierSwitch");
  var activeSupplierName = $("#activeSupplierName");

  function showScreen(name){
    screenUpload.hidden = name !== "upload";
    screenMapping.hidden = name !== "mapping";
    screenDashboard.hidden = name !== "dashboard";
    supplierSwitch.hidden = name === "upload";
  }

  /* ---------- Upload screen wiring ---------- */
  var supplierInput = $("#supplierInput");
  var supplierListEl = $("#supplierList");
  var dropzone = $("#dropzone");
  var fileInput = $("#fileInput");
  var uploadError = $("#uploadError");

  function refreshSupplierDatalist(){
    supplierListEl.innerHTML = getKnownSuppliers().map(function(s){
      return '<option value="' + escapeHtml(s) + '"></option>';
    }).join("");
  }
  refreshSupplierDatalist();

  function showUploadError(msg){
    uploadError.hidden = false;
    uploadError.textContent = msg;
  }
  function clearUploadError(){
    uploadError.hidden = true;
    uploadError.textContent = "";
  }

  dropzone.addEventListener("click", function(){
    if (dropzone.classList.contains("is-busy")) return;
    fileInput.click();
  });
  dropzone.addEventListener("keydown", function(e){
    if (dropzone.classList.contains("is-busy")) return;
    if (e.key === "Enter" || e.key === " "){ e.preventDefault(); fileInput.click(); }
  });
  ["dragenter","dragover"].forEach(function(evt){
    dropzone.addEventListener(evt, function(e){
      e.preventDefault(); e.stopPropagation();
      dropzone.classList.add("is-dragover");
    });
  });
  ["dragleave","drop"].forEach(function(evt){
    dropzone.addEventListener(evt, function(e){
      e.preventDefault(); e.stopPropagation();
      dropzone.classList.remove("is-dragover");
    });
  });
  dropzone.addEventListener("drop", function(e){
    var file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
  fileInput.addEventListener("change", function(){
    if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]);
  });

  var dzMain = dropzone.querySelector(".dz-main");
  var dzSub = dropzone.querySelector(".dz-sub");
  var dzMainDefault = dzMain.textContent;
  var dzSubDefault = dzSub.textContent;

  function setDropzoneBusy(label){
    dropzone.classList.add("is-busy");
    dzMain.textContent = label;
    dzSub.textContent = "Det kan ta en liten stund för PDF-filer…";
  }
  function resetDropzone(){
    dropzone.classList.remove("is-busy");
    dzMain.textContent = dzMainDefault;
    dzSub.textContent = dzSubDefault;
  }
  function withTimeout(promise, ms, message){
    var timer;
    var timeout = new Promise(function(_, reject){
      timer = setTimeout(function(){
        var err = new Error(message);
        err.isTimeout = true;
        reject(err);
      }, ms);
    });
    return Promise.race([promise, timeout]).finally(function(){ clearTimeout(timer); });
  }

  function handleFile(file){
    clearUploadError();
    var supplier = supplierInput.value.trim();
    if (!supplier){
      showUploadError("Fyll i vilken leverantör listan kommer från först.");
      supplierInput.focus();
      return;
    }
    var isCsv = /\.csv$/i.test(file.name);
    var isPdf = /\.pdf$/i.test(file.name);
    var reader = new FileReader();
    reader.onerror = function(){
      resetDropzone();
      showUploadError("Kunde inte läsa filen. Testa att spara om den i Excel och ladda upp igen.");
    };

    setDropzoneBusy(isPdf ? "Läser PDF-filen…" : "Läser filen…");

    if (isPdf){
      reader.onload = function(e){
        withTimeout(
          parsePdfToRows(e.target.result),
          20000,
          "Det tog för lång tid att läsa PDF:en. Kontrollera internetanslutningen (PDF-läsning laddar ett litet tilläggsbibliotek första gången) och försök igen."
        ).then(function(rows){
          resetDropzone();
          continueWithRows(supplier, rows, "Kunde inte hitta någon tabell i PDF:en. Fungerar bäst med PDF:er exporterade direkt från Excel (inte inskannade papper/foton).");
        }).catch(function(err){
          resetDropzone();
          showUploadError(
            (err && err.isTimeout && err.message) ||
            "Kunde inte tolka PDF:en. Fungerar bäst med PDF:er exporterade direkt från Excel (inte inskannade papper/foton)."
          );
        });
      };
      reader.readAsArrayBuffer(file);
      return;
    }

    reader.onload = function(e){
      try{
        var wb = isCsv
          ? XLSX.read(e.target.result, { type: "string" })
          : XLSX.read(new Uint8Array(e.target.result), { type: "array" });
        var sheetName = wb.SheetNames[0];
        var bestSheet = null, bestLen = -1;
        wb.SheetNames.forEach(function(name){
          var rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: "" });
          if (rows.length > bestLen){ bestLen = rows.length; bestSheet = name; }
        });
        sheetName = bestSheet || sheetName;
        var rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: "" });
        resetDropzone();
        continueWithRows(supplier, rows, "Hittade inga rader i filen.");
      } catch(err){
        resetDropzone();
        showUploadError("Kunde inte tolka filen som Excel/CSV. Kontrollera att det är rätt filtyp.");
      }
    };
    if (isCsv) reader.readAsText(file, "UTF-8");
    else reader.readAsArrayBuffer(file);
  }

  function continueWithRows(supplier, rows, emptyMessage){
    if (!rows || !rows.length){
      showUploadError(emptyMessage || "Hittade inga rader i filen.");
      return;
    }
    var headerIdx = findHeaderRowIndex(rows);
    var headers = rows[headerIdx].map(function(h){ return String(h).trim(); });
    var dataRows = rows.slice(headerIdx + 1).filter(function(r){
      return r.some(function(c){ return c !== undefined && c !== null && String(c).trim() !== ""; });
    });
    if (!dataRows.length){
      showUploadError("Hittade rubriker men inga datarader under dem.");
      return;
    }
    state.supplier = supplier;
    state.headers = headers;
    state.rows = dataRows;
    rememberSupplier(supplier);
    activeSupplierName.textContent = supplier;

    var slug = slugify(supplier);
    var sig = headerSignature(headers);
    var storedMapping = loadMapping(slug);
    if (storedMapping && storedMapping.signature === sig){
      state.mapping = storedMapping.mapping;
      buildItemsAndRender();
    } else {
      openMappingScreen(headers, dataRows);
    }
  }

  /* ---------- PDF: rekonstruera rader/kolumner från textpositioner ---------- */
  function parsePdfToRows(arrayBuffer){
    if (typeof pdfjsLib === "undefined"){
      return Promise.reject(new Error("pdf.js saknas"));
    }
    return ensurePdfWorker().then(function(){
      return pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    }).then(function(pdf){
      var pagePromises = [];
      for (var i = 1; i <= pdf.numPages; i++){
        pagePromises.push(pdf.getPage(i).then(function(page){
          return page.getTextContent().then(function(tc){
            return tc.items.map(function(it){
              return {
                text: it.str,
                x: it.transform[4],
                y: it.transform[5],
                w: it.width,
                h: Math.abs(it.transform[3]) || it.height || 8
              };
            });
          });
        }));
      }
      return Promise.all(pagePromises);
    }).then(function(pagesItems){
      var lineRows = [];
      pagesItems.forEach(function(items){
        lineRows = lineRows.concat(itemsToLines(items));
      });
      return alignLinesToColumns(lineRows);
    });
  }

  function itemsToLines(items){
    var filtered = items.filter(function(it){ return it.text && it.text.trim() !== ""; });
    if (!filtered.length) return [];
    filtered.sort(function(a,b){ return b.y - a.y; });
    var lines = [];
    var current = [];
    var lastY = null;
    filtered.forEach(function(it){
      var tol = Math.max(3, (it.h||8) * 0.4);
      if (lastY === null || Math.abs(it.y - lastY) <= tol){
        current.push(it);
        lastY = lastY === null ? it.y : lastY;
      } else {
        lines.push(current);
        current = [it];
        lastY = it.y;
      }
    });
    if (current.length) lines.push(current);

    return lines.map(function(lineItems){
      lineItems.sort(function(a,b){ return a.x - b.x; });
      var cells = [];
      var cur = null;
      lineItems.forEach(function(it){
        var gapThreshold = Math.max(6, (it.h||8) * 1.0);
        if (cur && (it.x - cur.endX) < gapThreshold){
          cur.text += " " + it.text.trim();
          cur.endX = it.x + it.w;
        } else {
          if (cur) cells.push(cur);
          cur = { x: it.x, text: it.text.trim(), endX: it.x + it.w };
        }
      });
      if (cur) cells.push(cur);
      return cells;
    });
  }

  function alignLinesToColumns(lineRows){
    lineRows = lineRows.filter(function(cells){ return cells.length > 0; });
    if (!lineRows.length) return [];

    var maxScan = Math.min(lineRows.length, 20);
    var bestIdx = 0, bestScore = -1;
    for (var i=0;i<maxScan;i++){
      var cells = lineRows[i];
      if (cells.length < 2) continue;
      var textish = cells.filter(function(c){ return isNaN(parseFloat(String(c.text).replace(",", "."))); }).length;
      var score = cells.length + textish;
      if (score > bestScore){ bestScore = score; bestIdx = i; }
    }

    var anchors = lineRows[bestIdx].map(function(c){ return c.x; }).sort(function(a,b){ return a-b; });
    if (!anchors.length) return [];

    var bounds = anchors.map(function(a, k){
      var lo = k === 0 ? -Infinity : (anchors[k-1] + a) / 2;
      var hi = k === anchors.length-1 ? Infinity : (a + anchors[k+1]) / 2;
      return { lo: lo, hi: hi };
    });

    function colIndexFor(x){
      for (var b=0;b<bounds.length;b++){
        if (x >= bounds[b].lo && x < bounds[b].hi) return b;
      }
      return bounds.length - 1;
    }

    return lineRows.map(function(cells){
      var row = new Array(anchors.length).fill("");
      cells.forEach(function(c){
        var idx = colIndexFor(c.x);
        row[idx] = row[idx] ? (row[idx] + " " + c.text) : c.text;
      });
      return row;
    });
  }

  /* ---------- Mapping screen ---------- */
  var mappingGrid = $("#mappingGrid");
  var btnConfirmMapping = $("#btnConfirmMapping");
  var btnCancelMapping = $("#btnCancelMapping");

  function openMappingScreen(headers, dataRows){
    var sampleRow = dataRows[0] || [];
    var guesses = headers.map(function(h){ return guessField(h); });

    mappingGrid.innerHTML = headers.map(function(h, idx){
      var options = ['<option value="">— hoppa över —</option>'].concat(
        FIELD_ORDER.map(function(f){
          var sel = guesses[idx] === f ? " selected" : "";
          var star = REQUIRED_FIELDS.indexOf(f) !== -1 ? " *" : "";
          return '<option value="' + f + '"' + sel + '>' + FIELD_LABELS[f] + star + '</option>';
        })
      ).join("");
      var sample = sampleRow[idx] !== undefined ? String(sampleRow[idx]) : "";
      return (
        '<div class="mapping-item">' +
          '<div class="col-name">' + escapeHtml(h || "(namnlös kolumn)") + '</div>' +
          '<select data-col="' + idx + '">' + options + '</select>' +
          (sample ? '<div class="col-sample">t.ex. "' + escapeHtml(sample) + '"</div>' : "") +
        '</div>'
      );
    }).join("");

    btnConfirmMapping.disabled = false;
    showScreen("mapping");
  }

  btnCancelMapping.addEventListener("click", function(){
    showScreen("upload");
  });

  btnConfirmMapping.addEventListener("click", function(){
    if (btnConfirmMapping.disabled) return;
    var mapping = {};
    $all("select[data-col]", mappingGrid).forEach(function(sel){
      var field = sel.value;
      if (field) mapping[field] = parseInt(sel.getAttribute("data-col"), 10);
    });
    var missing = REQUIRED_FIELDS.filter(function(f){ return mapping[f] === undefined; });
    if (missing.length){
      alert("Du måste välja en kolumn för: " + missing.map(function(f){ return FIELD_LABELS[f]; }).join(", "));
      return;
    }
    btnConfirmMapping.disabled = true;
    state.mapping = mapping;
    saveMapping(slugify(state.supplier), headerSignature(state.headers), mapping);
    buildItemsAndRender();
  });

  /* ---------- Bygg items, diffa, rendera dashboard ---------- */
  function buildItemsAndRender(){
    var m = state.mapping;
    var current = state.rows.map(function(row){
      var namn = m.namn !== undefined ? String(row[m.namn] || "").trim() : "";
      if (!namn) return null;
      return {
        namn: namn,
        pris: m.pris !== undefined ? parsePrice(row[m.pris]) : null,
        kategori: m.kategori !== undefined ? String(row[m.kategori] || "").trim() : "",
        enhet: m.enhet !== undefined ? String(row[m.enhet] || "").trim() : "",
        antal: m.antal !== undefined ? parsePrice(row[m.antal]) : null,
        artikelnummer: m.artikelnummer !== undefined ? String(row[m.artikelnummer] || "").trim() : ""
      };
    }).filter(Boolean);

    var slug = slugify(state.supplier);
    var previousSnapshot = loadSnapshot(slug);
    var diff = computeDiff(current, previousSnapshot ? previousSnapshot.items : null);

    state.items = diff.items;
    state.removed = diff.removed;

    saveSnapshot(slug, current);

    populateCategoryFilter();
    renderKPIs();
    renderTable();
    showScreen("dashboard");
  }

  /* ---------- KPI:er ---------- */
  var kpiRow = $("#kpiRow");
  var footnoteInfo = $("#footnoteInfo");

  function renderKPIs(){
    var items = state.items;
    var up = items.filter(function(i){ return i.status === "up"; });
    var down = items.filter(function(i){ return i.status === "down"; });
    var neu = items.filter(function(i){ return i.status === "new"; });
    var totalVarde = items.reduce(function(sum, i){
      if (i.pris === null) return sum;
      return sum + i.pris * (i.antal || 1);
    }, 0);
    var storstOkning = up.reduce(function(max, i){ return Math.max(max, i.diffPct); }, 0);

    var cards = [
      { label: "Artiklar", value: items.length, sub: state.removed.length ? state.removed.length + " borttagna" : "" },
      { label: "Totalt värde", value: totalVarde.toLocaleString("sv-SE", {maximumFractionDigits:0}) + " kr", sub: "" },
      { label: "Höjda priser", value: up.length, sub: up.length ? "störst: " + formatPct(storstOkning) : "", cls: up.length ? "kpi--up" : "" },
      { label: "Sänkta priser", value: down.length, sub: "", cls: down.length ? "kpi--down" : "" },
      { label: "Nya varor", value: neu.length, sub: "", cls: neu.length ? "kpi--new" : "" }
    ];

    kpiRow.innerHTML = cards.map(function(c){
      return (
        '<div class="kpi ' + (c.cls||"") + '">' +
          '<div class="kpi-label">' + c.label + '</div>' +
          '<div class="kpi-value">' + c.value + '</div>' +
          (c.sub ? '<div class="kpi-sub">' + c.sub + '</div>' : "") +
        '</div>'
      );
    }).join("");

    footnoteInfo.textContent = previousCompareText();
  }

  function previousCompareText(){
    var hadPrevious = state.items.some(function(i){ return i.status !== "new"; }) || state.removed.length;
    return hadPrevious
      ? "Jämfört mot senast sparade listan för " + state.supplier + "."
      : "Ingen tidigare lista hittades för " + state.supplier + " — detta blir jämförelsebasen framåt.";
  }

  /* ---------- Tabell ---------- */
  var categoryFilter = $("#categoryFilter");
  var statusFilter = $("#statusFilter");
  var searchInput = $("#searchInput");
  var tableBody = $("#tableBody");
  var emptyState = $("#emptyState");

  function populateCategoryFilter(){
    var cats = Array.from(new Set(
      state.items.concat(state.removed)
        .map(function(i){ return i.kategori; })
        .filter(function(c){ return c; })
    )).sort();
    categoryFilter.innerHTML = '<option value="">Alla kategorier</option>' +
      cats.map(function(c){ return '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + '</option>'; }).join("");
  }

  function getFilteredSorted(){
    var q = searchInput.value.trim().toLowerCase();
    var cat = categoryFilter.value;
    var status = statusFilter.value;

    var all = state.items.concat(state.removed);

    var filtered = all.filter(function(i){
      if (q && i.namn.toLowerCase().indexOf(q) === -1 && (i.kategori||"").toLowerCase().indexOf(q) === -1) return false;
      if (cat && i.kategori !== cat) return false;
      if (status === "changed" && ["up","down","new","removed"].indexOf(i.status) === -1) return false;
      if (status === "new" && i.status !== "new") return false;
      if (status === "up" && i.status !== "up") return false;
      if (status === "down" && i.status !== "down") return false;
      if (status === "removed" && i.status !== "removed") return false;
      return true;
    });

    var key = state.sort.key, dir = state.sort.dir === "asc" ? 1 : -1;
    filtered.sort(function(a,b){
      var av = a[key], bv = b[key];
      if (key === "diffPct"){
        av = av === null || av === undefined ? -Infinity : av;
        bv = bv === null || bv === undefined ? -Infinity : bv;
      }
      if (typeof av === "string") av = av.toLowerCase();
      if (typeof bv === "string") bv = bv.toLowerCase();
      if (av === bv) return 0;
      return av > bv ? dir : -dir;
    });

    return filtered;
  }

  function statusStamp(item){
    switch(item.status){
      case "new": return '<span class="stamp stamp--new">Ny</span>';
      case "up": return '<span class="stamp stamp--up">Höjt ' + formatPct(item.diffPct) + '</span>';
      case "down": return '<span class="stamp stamp--down">Sänkt ' + formatPct(item.diffPct) + '</span>';
      case "removed": return '<span class="stamp stamp--removed">Borttagen</span>';
      default: return '<span class="stamp stamp--none">Oförändrat</span>';
    }
  }

  function renderTable(){
    var rows = getFilteredSorted();
    emptyState.hidden = rows.length !== 0;

    tableBody.innerHTML = rows.map(function(item){
      var trCls = item.status === "removed" ? ' class="is-removed"' : "";
      var enhetAntal = [item.antal, item.enhet].filter(Boolean).join(" ");
      return (
        '<tr' + trCls + '>' +
          '<td class="col-namn">' + escapeHtml(item.namn) +
            (enhetAntal ? '<span class="cat">' + escapeHtml(enhetAntal) + '</span>' : "") +
          '</td>' +
          '<td>' + escapeHtml(item.kategori || "—") + '</td>' +
          '<td class="col-pris">' + formatPris(item.pris) +
            (item.prevPris !== null && item.prevPris !== undefined && item.status !== "unchanged" && item.status !== "new" ? '<span class="prev-pris">' + formatPris(item.prevPris) + '</span>' : "") +
          '</td>' +
          '<td>' + statusStamp(item) + '</td>' +
        '</tr>'
      );
    }).join("");

    $all("#pkTable thead th[data-sort]").forEach(function(th){
      var arrow = th.querySelector(".arrow");
      if (th.getAttribute("data-sort") === state.sort.key){
        arrow.textContent = state.sort.dir === "asc" ? "↑" : "↓";
      } else {
        arrow.textContent = "";
      }
    });
  }

  searchInput.addEventListener("input", renderTable);
  categoryFilter.addEventListener("change", renderTable);
  statusFilter.addEventListener("change", renderTable);

  $all("#pkTable thead th[data-sort]").forEach(function(th){
    th.addEventListener("click", function(){
      var key = th.getAttribute("data-sort");
      if (state.sort.key === key){
        state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
      } else {
        state.sort.key = key;
        state.sort.dir = key === "diffPct" ? "desc" : "asc";
      }
      renderTable();
    });
  });

  /* ---------- Header actions ---------- */
  $("#btnNewUpload").addEventListener("click", function(){
    clearUploadError();
    fileInput.value = "";
    showScreen("upload");
  });
  $("#btnPrint").addEventListener("click", function(){ window.print(); });
  $("#btnResetHistory").addEventListener("click", function(){
    if (!state.supplier) return;
    if (confirm("Nollställ jämförelsehistorik för " + state.supplier + "? Nästa uppladdning blir en ny jämförelsebas.")){
      clearSnapshot(slugify(state.supplier));
      alert("Klart. Historiken för " + state.supplier + " är nollställd.");
    }
  });

  showScreen("upload");
})();
