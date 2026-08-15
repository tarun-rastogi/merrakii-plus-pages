/**
 * Spreadsheet editor for dashboard Scope / Updates panels.
 */
(function (global) {
  "use strict";

  var ESC = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;"
  };

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (ch) {
      return ESC[ch];
    });
  }

  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function sheetNames(sheets) {
    return Object.keys(sheets || {}).filter(function (k) {
      return k.charAt(0) !== "_";
    });
  }

  function ensureRect(rows, minR, minC) {
    while (rows.length < minR) rows.push([]);
    var maxC = minC;
    rows.forEach(function (row) {
      if (row.length > maxC) maxC = row.length;
    });
    rows.forEach(function (row) {
      while (row.length < maxC) row.push("");
    });
    return maxC;
  }

  function normalizeSelection(sel) {
    if (!sel) return null;
    return {
      r0: Math.min(sel.r0, sel.r1),
      c0: Math.min(sel.c0, sel.c1),
      r1: Math.max(sel.r0, sel.r1),
      c1: Math.max(sel.c0, sel.c1)
    };
  }

  function mergeKey(m) {
    return m.r + ":" + m.c;
  }

  function buildCoverMap(merges, rowCount, colCount) {
    var cover = {};
    var origins = {};
    (merges || []).forEach(function (m) {
      var rs = Math.max(1, Number(m.rowSpan) || 1);
      var cs = Math.max(1, Number(m.colSpan) || 1);
      origins[mergeKey(m)] = { r: m.r, c: m.c, rowSpan: rs, colSpan: cs };
      for (var rr = m.r; rr < m.r + rs && rr < rowCount; rr++) {
        for (var cc = m.c; cc < m.c + cs && cc < colCount; cc++) {
          if (rr === m.r && cc === m.c) continue;
          cover[rr + ":" + cc] = mergeKey(m);
        }
      }
    });
    return { cover: cover, origins: origins };
  }

  function overlapsMerge(merges, r0, c0, r1, c1) {
    return (merges || []).some(function (m) {
      var rs = Math.max(1, Number(m.rowSpan) || 1);
      var cs = Math.max(1, Number(m.colSpan) || 1);
      var mr1 = m.r + rs - 1;
      var mc1 = m.c + cs - 1;
      return !(r1 < m.r || r0 > mr1 || c1 < m.c || c0 > mc1);
    });
  }

  function removeOverlappingMerges(merges, r0, c0, r1, c1) {
    return (merges || []).filter(function (m) {
      var rs = Math.max(1, Number(m.rowSpan) || 1);
      var cs = Math.max(1, Number(m.colSpan) || 1);
      var mr1 = m.r + rs - 1;
      var mc1 = m.c + cs - 1;
      return r1 < m.r || r0 > mr1 || c1 < m.c || c0 > mc1;
    });
  }

  function adjustMergesAfterRowDelete(merges, rowIndex) {
    var next = [];
    (merges || []).forEach(function (m) {
      var rs = Math.max(1, Number(m.rowSpan) || 1);
      var cs = Math.max(1, Number(m.colSpan) || 1);
      var rEnd = m.r + rs - 1;
      if (rowIndex < m.r) {
        next.push({ r: m.r - 1, c: m.c, rowSpan: rs, colSpan: cs });
      } else if (rowIndex > rEnd) {
        next.push({ r: m.r, c: m.c, rowSpan: rs, colSpan: cs });
      } else if (rs <= 1) {
        /* delete origin row — drop merge */
      } else {
        next.push({ r: m.r, c: m.c, rowSpan: rs - 1, colSpan: cs });
      }
    });
    return next.filter(function (m) {
      return m.rowSpan > 1 || m.colSpan > 1;
    });
  }

  function adjustMergesAfterColDelete(merges, colIndex) {
    var next = [];
    (merges || []).forEach(function (m) {
      var rs = Math.max(1, Number(m.rowSpan) || 1);
      var cs = Math.max(1, Number(m.colSpan) || 1);
      var cEnd = m.c + cs - 1;
      if (colIndex < m.c) {
        next.push({ r: m.r, c: m.c - 1, rowSpan: rs, colSpan: cs });
      } else if (colIndex > cEnd) {
        next.push({ r: m.r, c: m.c, rowSpan: rs, colSpan: cs });
      } else if (cs <= 1) {
        /* drop */
      } else {
        next.push({ r: m.r, c: m.c, rowSpan: rs, colSpan: cs - 1 });
      }
    });
    return next.filter(function (m) {
      return m.rowSpan > 1 || m.colSpan > 1;
    });
  }

  function adjustMergesAfterRowInsert(merges, rowIndex) {
    return (merges || []).map(function (m) {
      var rs = Math.max(1, Number(m.rowSpan) || 1);
      var cs = Math.max(1, Number(m.colSpan) || 1);
      if (rowIndex <= m.r) return { r: m.r + 1, c: m.c, rowSpan: rs, colSpan: cs };
      if (rowIndex < m.r + rs) return { r: m.r, c: m.c, rowSpan: rs + 1, colSpan: cs };
      return { r: m.r, c: m.c, rowSpan: rs, colSpan: cs };
    });
  }

  function adjustMergesAfterColInsert(merges, colIndex) {
    return (merges || []).map(function (m) {
      var rs = Math.max(1, Number(m.rowSpan) || 1);
      var cs = Math.max(1, Number(m.colSpan) || 1);
      if (colIndex <= m.c) return { r: m.r, c: m.c + 1, rowSpan: rs, colSpan: cs };
      if (colIndex < m.c + cs) return { r: m.r, c: m.c, rowSpan: rs, colSpan: cs + 1 };
      return { r: m.r, c: m.c, rowSpan: rs, colSpan: cs };
    });
  }

  function emptyLayout() {
    return { colWidths: {}, rowHeights: {}, cells: {} };
  }

  function ensureLayout(layoutMap, sheetName) {
    if (!layoutMap[sheetName]) layoutMap[sheetName] = emptyLayout();
    var L = layoutMap[sheetName];
    if (!L.colWidths) L.colWidths = {};
    if (!L.rowHeights) L.rowHeights = {};
    if (!L.cells) L.cells = {};
    return L;
  }

  function cellStyleKey(r, c) {
    return r + ":" + c;
  }

  function shiftLayoutAfterRowInsert(layout, at) {
    var nextHeights = {};
    Object.keys(layout.rowHeights || {}).forEach(function (k) {
      var r = Number(k);
      nextHeights[String(r >= at ? r + 1 : r)] = layout.rowHeights[k];
    });
    var nextCells = {};
    Object.keys(layout.cells || {}).forEach(function (k) {
      var parts = k.split(":");
      var r = Number(parts[0]);
      var c = Number(parts[1]);
      var nr = r >= at ? r + 1 : r;
      nextCells[cellStyleKey(nr, c)] = layout.cells[k];
    });
    layout.rowHeights = nextHeights;
    layout.cells = nextCells;
  }

  function shiftLayoutAfterRowDelete(layout, at) {
    var nextHeights = {};
    Object.keys(layout.rowHeights || {}).forEach(function (k) {
      var r = Number(k);
      if (r === at) return;
      nextHeights[String(r > at ? r - 1 : r)] = layout.rowHeights[k];
    });
    var nextCells = {};
    Object.keys(layout.cells || {}).forEach(function (k) {
      var parts = k.split(":");
      var r = Number(parts[0]);
      var c = Number(parts[1]);
      if (r === at) return;
      var nr = r > at ? r - 1 : r;
      nextCells[cellStyleKey(nr, c)] = layout.cells[k];
    });
    layout.rowHeights = nextHeights;
    layout.cells = nextCells;
  }

  function shiftLayoutAfterColInsert(layout, at) {
    var nextWidths = {};
    Object.keys(layout.colWidths || {}).forEach(function (k) {
      var c = Number(k);
      nextWidths[String(c >= at ? c + 1 : c)] = layout.colWidths[k];
    });
    var nextCells = {};
    Object.keys(layout.cells || {}).forEach(function (k) {
      var parts = k.split(":");
      var r = Number(parts[0]);
      var c = Number(parts[1]);
      var nc = c >= at ? c + 1 : c;
      nextCells[cellStyleKey(r, nc)] = layout.cells[k];
    });
    layout.colWidths = nextWidths;
    layout.cells = nextCells;
  }

  function shiftLayoutAfterColDelete(layout, at) {
    var nextWidths = {};
    Object.keys(layout.colWidths || {}).forEach(function (k) {
      var c = Number(k);
      if (c === at) return;
      nextWidths[String(c > at ? c - 1 : c)] = layout.colWidths[k];
    });
    var nextCells = {};
    Object.keys(layout.cells || {}).forEach(function (k) {
      var parts = k.split(":");
      var r = Number(parts[0]);
      var c = Number(parts[1]);
      if (c === at) return;
      var nc = c > at ? c - 1 : c;
      nextCells[cellStyleKey(r, nc)] = layout.cells[k];
    });
    layout.colWidths = nextWidths;
    layout.cells = nextCells;
  }

  function SheetEditor(options) {
    this.root = options.root;
    this.onSave = options.onSave || function () {
      return Promise.resolve();
    };
    this.onClose = options.onClose || function () {};
    this.state = null;
    this._dragAnchor = null;
    this._resize = null;
    this._boundKey = this._onKeyDown.bind(this);
  }

  SheetEditor.prototype.open = function (payload) {
    this.state = {
      kind: payload.kind,
      title: payload.title || "Edit",
      document: payload.document ? clone(payload.document) : null,
      sheets: clone(payload.sheets || {}),
      merges: clone(payload.merges || {}),
      layout: clone(payload.layout || {}),
      activeSheet: payload.activeSheet || sheetNames(payload.sheets)[0] || "",
      selection: null,
      status: "",
      saving: false
    };
    var names = sheetNames(this.state.sheets);
    if (!this.state.activeSheet || names.indexOf(this.state.activeSheet) < 0) {
      this.state.activeSheet = names[0] || "";
    }
    this.root.hidden = false;
    this.root.setAttribute("aria-hidden", "false");
    document.body.classList.add("sheet-editor-open");
    document.addEventListener("keydown", this._boundKey, true);
    if (!this._boundMouseUp) {
      var self = this;
      this._boundMouseUp = function () {
        self._dragAnchor = null;
      };
      document.addEventListener("mouseup", this._boundMouseUp);
    }
    this.render();
  };

  SheetEditor.prototype.close = function () {
    document.removeEventListener("keydown", this._boundKey, true);
    if (this._boundMouseUp) {
      document.removeEventListener("mouseup", this._boundMouseUp);
      this._boundMouseUp = null;
    }
    this.root.hidden = true;
    this.root.setAttribute("aria-hidden", "true");
    document.body.classList.remove("sheet-editor-open");
    this.state = null;
    this.onClose();
  };

  SheetEditor.prototype._activeRows = function () {
    return this.state.sheets[this.state.activeSheet] || [];
  };

  SheetEditor.prototype._activeMerges = function () {
    if (!this.state.merges[this.state.activeSheet]) {
      this.state.merges[this.state.activeSheet] = [];
    }
    return this.state.merges[this.state.activeSheet];
  };

  SheetEditor.prototype._activeLayout = function () {
    return ensureLayout(this.state.layout, this.state.activeSheet);
  };

  SheetEditor.prototype._ensureCellStyle = function (r, c) {
    var layout = this._activeLayout();
    var key = cellStyleKey(r, c);
    if (!layout.cells[key]) layout.cells[key] = {};
    return layout.cells[key];
  };

  SheetEditor.prototype._setStatus = function (msg, ok) {
    if (!this.state) return;
    this.state.status = msg || "";
    this.state.statusOk = !!ok;
    var el = this.root.querySelector("[data-se-status]");
    if (el) {
      el.textContent = this.state.status;
      el.classList.toggle("is-ok", !!ok);
      el.classList.toggle("is-err", !!msg && !ok);
    }
  };

  SheetEditor.prototype.render = function () {
    if (!this.state) return;
    var st = this.state;
    var names = sheetNames(st.sheets);
    var rows = this._activeRows();
    var colCount = ensureRect(rows, Math.max(rows.length, 1), 1);
    var merges = this._activeMerges();
    var layout = this._activeLayout();
    var map = buildCoverMap(merges, rows.length, colCount);
    var sel = normalizeSelection(st.selection);
    var sampleStyle =
      sel && layout.cells[cellStyleKey(sel.r0, sel.c0)]
        ? layout.cells[cellStyleKey(sel.r0, sel.c0)]
        : {};
    var sampleColW =
      sel && layout.colWidths[String(sel.c0)] != null
        ? layout.colWidths[String(sel.c0)]
        : "";
    var sampleRowH =
      sel && layout.rowHeights[String(sel.r0)] != null
        ? layout.rowHeights[String(sel.r0)]
        : "";

    var html = "";
    html += '<div class="se-backdrop" data-se-close></div>';
    html += '<div class="se-panel" role="dialog" aria-modal="true" aria-label="Spreadsheet editor">';
    html += '<header class="se-header">';
    html += "<div><h2>" + escapeHtml(st.title) + "</h2>";
    html +=
      '<p class="se-hint">Edit cells · resize columns/rows by dragging headers · align text · Cmd/Ctrl+S to save · Esc to close</p></div>';
    html += '<div class="se-header-actions">';
    html +=
      '<span class="se-status" data-se-status aria-live="polite">' +
      escapeHtml(st.status || "") +
      "</span>";
    html +=
      '<button type="button" class="se-btn se-btn-ghost" data-se-close>Close</button>';
    html +=
      '<button type="button" class="se-btn se-btn-primary" data-se-save' +
      (st.saving ? " disabled" : "") +
      ">" +
      (st.saving ? "Saving…" : "Save") +
      "</button>";
    html += "</div></header>";

    html += '<div class="se-toolbar">';
    html += '<button type="button" class="se-btn" data-se-action="add-row">+ Row</button>';
    html += '<button type="button" class="se-btn" data-se-action="add-col">+ Column</button>';
    html +=
      '<button type="button" class="se-btn" data-se-action="del-row">Delete row</button>';
    html +=
      '<button type="button" class="se-btn" data-se-action="del-col">Delete column</button>';
    html += '<span class="se-sep"></span>';
    html += '<button type="button" class="se-btn" data-se-action="merge">Merge</button>';
    html += '<button type="button" class="se-btn" data-se-action="unmerge">Unmerge</button>';
    html += '<span class="se-sep"></span>';
    html +=
      '<button type="button" class="se-btn" data-se-action="add-sheet">+ Sheet</button>';
    html +=
      '<button type="button" class="se-btn" data-se-action="rename-sheet">Rename sheet</button>';
    html +=
      '<button type="button" class="se-btn se-btn-danger" data-se-action="del-sheet">Delete sheet</button>';
    html += "</div>";

    html += '<div class="se-toolbar se-toolbar-format">';
    html += '<span class="se-tool-label">Horizontal</span>';
    html +=
      '<button type="button" class="se-btn" data-se-action="align-left" title="Align left">Left</button>';
    html +=
      '<button type="button" class="se-btn" data-se-action="align-center" title="Align center">Center</button>';
    html +=
      '<button type="button" class="se-btn" data-se-action="align-right" title="Align right">Right</button>';
    html += '<span class="se-sep"></span>';
    html += '<span class="se-tool-label">Vertical</span>';
    html +=
      '<button type="button" class="se-btn" data-se-action="valign-top" title="Align top">Top</button>';
    html +=
      '<button type="button" class="se-btn" data-se-action="valign-middle" title="Align middle">Middle</button>';
    html +=
      '<button type="button" class="se-btn" data-se-action="valign-bottom" title="Align bottom">Bottom</button>';
    html += '<span class="se-sep"></span>';
    html += '<span class="se-tool-label">Column W</span>';
    html +=
      '<input class="se-size-input" type="number" min="60" max="900" step="10" data-se-col-width value="' +
      escapeHtml(sampleColW) +
      '" placeholder="px" title="Column width (px)" />';
    html +=
      '<button type="button" class="se-btn" data-se-action="apply-col-width">Apply</button>';
    html += '<span class="se-tool-label">Row H</span>';
    html +=
      '<input class="se-size-input" type="number" min="24" max="600" step="4" data-se-row-height value="' +
      escapeHtml(sampleRowH) +
      '" placeholder="px" title="Row height (px)" />';
    html +=
      '<button type="button" class="se-btn" data-se-action="apply-row-height">Apply</button>';
    html += '<span class="se-sep"></span>';
    html += '<span class="se-tool-label">Cell W</span>';
    html +=
      '<input class="se-size-input" type="number" min="60" max="900" step="10" data-se-cell-width value="' +
      escapeHtml(sampleStyle.width || "") +
      '" placeholder="px" title="Selected cell min-width (px)" />';
    html += '<span class="se-tool-label">Cell H</span>';
    html +=
      '<input class="se-size-input" type="number" min="24" max="600" step="4" data-se-cell-height value="' +
      escapeHtml(sampleStyle.height || "") +
      '" placeholder="px" title="Selected cell min-height (px)" />';
    html +=
      '<button type="button" class="se-btn" data-se-action="apply-cell-size">Apply cell size</button>';
    html += "</div>";

    html += '<div class="se-sheets" role="tablist">';
    names.forEach(function (name) {
      html +=
        '<button type="button" class="se-sheet-tab' +
        (name === st.activeSheet ? " is-active" : "") +
        '" data-se-sheet="' +
        escapeHtml(name) +
        '" role="tab" aria-selected="' +
        (name === st.activeSheet ? "true" : "false") +
        '">' +
        escapeHtml(name) +
        "</button>";
    });
    html += "</div>";

    html += '<div class="se-grid-wrap"><table class="se-grid"><colgroup>';
    html += '<col class="se-rowhead-col" style="width:48px" />';
    for (var cg = 0; cg < colCount; cg++) {
      var cw = layout.colWidths[String(cg)];
      html +=
        "<col" +
        (cw ? ' style="width:' + Number(cw) + 'px"' : "") +
        " />";
    }
    html += "</colgroup><thead><tr>";
    html += '<th class="se-corner"></th>';
    for (var c = 0; c < colCount; c++) {
      var headW = layout.colWidths[String(c)];
      html +=
        '<th class="se-colhead" data-se-col="' +
        c +
        '"' +
        (headW ? ' style="width:' + Number(headW) + 'px;min-width:' + Number(headW) + 'px"' : "") +
        ">" +
        escapeHtml(colLabel(c)) +
        '<span class="se-col-resizer" data-se-resize-col="' +
        c +
        '" title="Drag to resize column"></span></th>';
    }
    html += "</tr></thead><tbody>";

    for (var r = 0; r < rows.length; r++) {
      var rh = layout.rowHeights[String(r)];
      html +=
        "<tr" +
        (rh ? ' style="height:' + Number(rh) + 'px"' : "") +
        ">";
      html +=
        '<th class="se-rowhead" data-se-row="' +
        r +
        '"' +
        (rh ? ' style="height:' + Number(rh) + 'px"' : "") +
        ">" +
        (r + 1) +
        '<span class="se-row-resizer" data-se-resize-row="' +
        r +
        '" title="Drag to resize row"></span></th>';
      for (var cc = 0; cc < colCount; cc++) {
        var key = r + ":" + cc;
        if (map.cover[key]) continue;
        var origin = map.origins[key];
        var rs = origin ? origin.rowSpan : 1;
        var cs = origin ? origin.colSpan : 1;
        var selected =
          sel && r >= sel.r0 && r <= sel.r1 && cc >= sel.c0 && cc <= sel.c1;
        var val = rows[r][cc] != null ? rows[r][cc] : "";
        var style = layout.cells[cellStyleKey(r, cc)] || {};
        var align = style.align || "left";
        var valign = style.valign || "top";
        var styleParts = [];
        styleParts.push("text-align:" + align);
        styleParts.push("vertical-align:" + valign);
        if (style.width) {
          styleParts.push("min-width:" + Number(style.width) + "px");
          styleParts.push("width:" + Number(style.width) + "px");
        }
        if (style.height) {
          styleParts.push("min-height:" + Number(style.height) + "px");
          styleParts.push("height:" + Number(style.height) + "px");
        }
        html +=
          '<td class="se-cell' +
          (selected ? " is-selected" : "") +
          (r === 0 ? " is-header-row" : "") +
          " se-align-" +
          align +
          " se-valign-" +
          valign +
          '" data-r="' +
          r +
          '" data-c="' +
          cc +
          '"' +
          (rs > 1 ? ' rowspan="' + rs + '"' : "") +
          (cs > 1 ? ' colspan="' + cs + '"' : "") +
          ' style="' +
          styleParts.join(";") +
          '" contenteditable="true" spellcheck="false">' +
          escapeHtml(val) +
          "</td>";
      }
      html += "</tr>";
    }
    html += "</tbody></table></div></div>";

    this.root.innerHTML = html;
    this._bind();
  };

  function colLabel(i) {
    var s = "";
    var n = i;
    do {
      s = String.fromCharCode(65 + (n % 26)) + s;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return s;
  }

  // contenteditable turns typed line breaks into <br>/<div>, which textContent
  // would silently flatten. Cells can hold multi-line content, so walk the DOM.
  function cellDomToText(el) {
    var parts = [];
    function push(s) {
      parts.push(s);
    }
    function lastIsBreak() {
      return !parts.length || parts[parts.length - 1] === "\n";
    }
    function walk(node) {
      for (var i = 0; i < node.childNodes.length; i++) {
        var n = node.childNodes[i];
        if (n.nodeType === 3) {
          push(n.nodeValue);
          continue;
        }
        if (n.nodeType !== 1) continue;
        var tag = n.nodeName.toLowerCase();
        if (tag === "br") {
          push("\n");
          continue;
        }
        var isBlock = tag === "div" || tag === "p" || tag === "li";
        if (isBlock && !lastIsBreak()) push("\n");
        walk(n);
        if (isBlock && !lastIsBreak()) push("\n");
      }
    }
    walk(el);
    return parts.join("").replace(/\u00a0/g, " ").replace(/\s+$/, "");
  }

  SheetEditor.prototype._syncCellFromDom = function (td) {
    if (!td || !this.state) return;
    var r = Number(td.getAttribute("data-r"));
    var c = Number(td.getAttribute("data-c"));
    var rows = this._activeRows();
    if (!rows[r]) return;
    rows[r][c] = cellDomToText(td);
  };

  SheetEditor.prototype._syncAllCells = function () {
    var self = this;
    this.root.querySelectorAll("td.se-cell").forEach(function (td) {
      self._syncCellFromDom(td);
    });
  };

  SheetEditor.prototype._bind = function () {
    var self = this;
    var root = this.root;

    root.querySelectorAll("[data-se-close]").forEach(function (el) {
      el.addEventListener("click", function () {
        self.close();
      });
    });

    var saveBtn = root.querySelector("[data-se-save]");
    if (saveBtn) {
      saveBtn.addEventListener("click", function () {
        self.save();
      });
    }

    root.querySelectorAll("[data-se-sheet]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        self._syncAllCells();
        self.state.activeSheet = btn.getAttribute("data-se-sheet");
        self.state.selection = null;
        self.render();
      });
    });

    root.querySelectorAll("[data-se-action]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        self._runAction(btn.getAttribute("data-se-action"));
      });
    });

    root.querySelectorAll("td.se-cell").forEach(function (td) {
      td.addEventListener("mousedown", function (e) {
        if (e.button !== 0) return;
        var r = Number(td.getAttribute("data-r"));
        var c = Number(td.getAttribute("data-c"));
        if (e.shiftKey && self.state.selection) {
          var a = self.state.selection;
          self.state.selection = { r0: a.r0, c0: a.c0, r1: r, c1: c };
          self._dragAnchor = null;
          self._paintSelection();
          return;
        }
        self._dragAnchor = { r: r, c: c };
        self.state.selection = { r0: r, c0: c, r1: r, c1: c };
        self._paintSelection();
      });
      td.addEventListener("mouseenter", function () {
        if (!self._dragAnchor) return;
        var r = Number(td.getAttribute("data-r"));
        var c = Number(td.getAttribute("data-c"));
        self.state.selection = {
          r0: self._dragAnchor.r,
          c0: self._dragAnchor.c,
          r1: r,
          c1: c
        };
        self._paintSelection();
      });
      td.addEventListener("blur", function () {
        self._syncCellFromDom(td);
      });
      td.addEventListener("input", function () {
        self._setStatus("Unsaved changes", false);
      });
    });

    root.querySelectorAll("[data-se-resize-col]").forEach(function (handle) {
      handle.addEventListener("mousedown", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var col = Number(handle.getAttribute("data-se-resize-col"));
        var th = handle.parentElement;
        var startX = e.clientX;
        var startW = th.getBoundingClientRect().width;
        self._resize = { type: "col", col: col, startX: startX, startW: startW };
        function onMove(ev) {
          if (!self._resize || self._resize.type !== "col") return;
          var w = Math.max(60, Math.round(self._resize.startW + (ev.clientX - self._resize.startX)));
          self._activeLayout().colWidths[String(self._resize.col)] = w;
          var table = root.querySelector("table.se-grid");
          if (!table) return;
          var cols = table.querySelectorAll("colgroup col");
          // +1 for rowhead col
          if (cols[self._resize.col + 1]) {
            cols[self._resize.col + 1].style.width = w + "px";
          }
          var head = root.querySelector('.se-colhead[data-se-col="' + self._resize.col + '"]');
          if (head) {
            head.style.width = w + "px";
            head.style.minWidth = w + "px";
          }
        }
        function onUp() {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          self._resize = null;
          self._setStatus("Column width updated — save to keep", false);
          var input = root.querySelector("[data-se-col-width]");
          if (input && self.state.selection) {
            var sel = normalizeSelection(self.state.selection);
            var val = self._activeLayout().colWidths[String(sel.c0)];
            input.value = val != null ? val : "";
          }
        }
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    });

    root.querySelectorAll("[data-se-resize-row]").forEach(function (handle) {
      handle.addEventListener("mousedown", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var row = Number(handle.getAttribute("data-se-resize-row"));
        var th = handle.parentElement;
        var startY = e.clientY;
        var startH = th.getBoundingClientRect().height;
        self._resize = { type: "row", row: row, startY: startY, startH: startH };
        function onMove(ev) {
          if (!self._resize || self._resize.type !== "row") return;
          var h = Math.max(24, Math.round(self._resize.startH + (ev.clientY - self._resize.startY)));
          self._activeLayout().rowHeights[String(self._resize.row)] = h;
          var tr = th.parentElement;
          if (tr) tr.style.height = h + "px";
          th.style.height = h + "px";
        }
        function onUp() {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          self._resize = null;
          self._setStatus("Row height updated — save to keep", false);
          var input = root.querySelector("[data-se-row-height]");
          if (input && self.state.selection) {
            var sel = normalizeSelection(self.state.selection);
            var val = self._activeLayout().rowHeights[String(sel.r0)];
            input.value = val != null ? val : "";
          }
        }
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    });
  };

  SheetEditor.prototype._paintSelection = function () {
    var sel = normalizeSelection(this.state.selection);
    this.root.querySelectorAll("td.se-cell").forEach(function (td) {
      var r = Number(td.getAttribute("data-r"));
      var c = Number(td.getAttribute("data-c"));
      var on =
        sel && r >= sel.r0 && r <= sel.r1 && c >= sel.c0 && c <= sel.c1;
      td.classList.toggle("is-selected", !!on);
    });
  };

  SheetEditor.prototype._runAction = function (action) {
    this._syncAllCells();
    var rows = this._activeRows();
    var merges = this._activeMerges();
    var sel = normalizeSelection(this.state.selection);
    var colCount = ensureRect(rows, rows.length || 1, 1);

    if (action === "add-row") {
      var at = sel ? sel.r1 + 1 : rows.length;
      var blank = [];
      for (var i = 0; i < colCount; i++) blank.push("");
      rows.splice(at, 0, blank);
      this.state.merges[this.state.activeSheet] = adjustMergesAfterRowInsert(merges, at);
      shiftLayoutAfterRowInsert(this._activeLayout(), at);
      this.state.selection = { r0: at, c0: 0, r1: at, c1: 0 };
      this._setStatus("Row added", true);
      this.render();
      return;
    }

    if (action === "add-col") {
      var atC = sel ? sel.c1 + 1 : colCount;
      rows.forEach(function (row) {
        row.splice(atC, 0, "");
      });
      this.state.merges[this.state.activeSheet] = adjustMergesAfterColInsert(merges, atC);
      shiftLayoutAfterColInsert(this._activeLayout(), atC);
      this.state.selection = { r0: 0, c0: atC, r1: 0, c1: atC };
      this._setStatus("Column added", true);
      this.render();
      return;
    }

    if (action === "del-row") {
      if (!sel) {
        this._setStatus("Select a cell or row first", false);
        return;
      }
      if (rows.length <= 1) {
        this._setStatus("Keep at least one row", false);
        return;
      }
      for (var rr = sel.r1; rr >= sel.r0; rr--) {
        if (rows.length <= 1) break;
        rows.splice(rr, 1);
        merges = adjustMergesAfterRowDelete(merges, rr);
        shiftLayoutAfterRowDelete(this._activeLayout(), rr);
      }
      this.state.merges[this.state.activeSheet] = merges;
      this.state.selection = null;
      this._setStatus("Row(s) deleted", true);
      this.render();
      return;
    }

    if (action === "del-col") {
      if (!sel) {
        this._setStatus("Select a cell or column first", false);
        return;
      }
      if (colCount <= 1) {
        this._setStatus("Keep at least one column", false);
        return;
      }
      for (var cc = sel.c1; cc >= sel.c0; cc--) {
        if (ensureRect(rows, rows.length, 1) <= 1) break;
        rows.forEach(function (row) {
          row.splice(cc, 1);
        });
        merges = adjustMergesAfterColDelete(merges, cc);
        shiftLayoutAfterColDelete(this._activeLayout(), cc);
      }
      this.state.merges[this.state.activeSheet] = merges;
      this.state.selection = null;
      this._setStatus("Column(s) deleted", true);
      this.render();
      return;
    }

    if (action === "align-left" || action === "align-center" || action === "align-right") {
      if (!sel) {
        this._setStatus("Select cell(s) first", false);
        return;
      }
      var align = action.replace("align-", "");
      for (var ar = sel.r0; ar <= sel.r1; ar++) {
        for (var ac = sel.c0; ac <= sel.c1; ac++) {
          this._ensureCellStyle(ar, ac).align = align;
        }
      }
      this._setStatus("Horizontal align: " + align, true);
      this.render();
      return;
    }

    if (action === "valign-top" || action === "valign-middle" || action === "valign-bottom") {
      if (!sel) {
        this._setStatus("Select cell(s) first", false);
        return;
      }
      var valign = action.replace("valign-", "");
      for (var vr = sel.r0; vr <= sel.r1; vr++) {
        for (var vc = sel.c0; vc <= sel.c1; vc++) {
          this._ensureCellStyle(vr, vc).valign = valign;
        }
      }
      this._setStatus("Vertical align: " + valign, true);
      this.render();
      return;
    }

    if (action === "apply-col-width") {
      if (!sel) {
        this._setStatus("Select a cell in the column first", false);
        return;
      }
      var colInput = this.root.querySelector("[data-se-col-width]");
      var colW = colInput ? Number(colInput.value) : NaN;
      if (!isFinite(colW) || colW < 60) {
        this._setStatus("Enter a column width of at least 60px", false);
        return;
      }
      for (var cw = sel.c0; cw <= sel.c1; cw++) {
        this._activeLayout().colWidths[String(cw)] = Math.round(colW);
      }
      this._setStatus("Column width set to " + Math.round(colW) + "px", true);
      this.render();
      return;
    }

    if (action === "apply-row-height") {
      if (!sel) {
        this._setStatus("Select a cell in the row first", false);
        return;
      }
      var rowInput = this.root.querySelector("[data-se-row-height]");
      var rowH = rowInput ? Number(rowInput.value) : NaN;
      if (!isFinite(rowH) || rowH < 24) {
        this._setStatus("Enter a row height of at least 24px", false);
        return;
      }
      for (var rh = sel.r0; rh <= sel.r1; rh++) {
        this._activeLayout().rowHeights[String(rh)] = Math.round(rowH);
      }
      this._setStatus("Row height set to " + Math.round(rowH) + "px", true);
      this.render();
      return;
    }

    if (action === "apply-cell-size") {
      if (!sel) {
        this._setStatus("Select cell(s) first", false);
        return;
      }
      var cellWInput = this.root.querySelector("[data-se-cell-width]");
      var cellHInput = this.root.querySelector("[data-se-cell-height]");
      var cellW = cellWInput && cellWInput.value !== "" ? Number(cellWInput.value) : null;
      var cellH = cellHInput && cellHInput.value !== "" ? Number(cellHInput.value) : null;
      if (cellW != null && (!isFinite(cellW) || cellW < 60)) {
        this._setStatus("Cell width must be at least 60px", false);
        return;
      }
      if (cellH != null && (!isFinite(cellH) || cellH < 24)) {
        this._setStatus("Cell height must be at least 24px", false);
        return;
      }
      for (var cr = sel.r0; cr <= sel.r1; cr++) {
        for (var ccell = sel.c0; ccell <= sel.c1; ccell++) {
          var cs = this._ensureCellStyle(cr, ccell);
          if (cellW != null) cs.width = Math.round(cellW);
          else delete cs.width;
          if (cellH != null) cs.height = Math.round(cellH);
          else delete cs.height;
        }
      }
      this._setStatus("Cell size applied", true);
      this.render();
      return;
    }

    if (action === "merge") {
      if (!sel || (sel.r0 === sel.r1 && sel.c0 === sel.c1)) {
        this._setStatus("Select a range of 2+ cells to merge", false);
        return;
      }
      merges = removeOverlappingMerges(merges, sel.r0, sel.c0, sel.r1, sel.c1);
      var keep = rows[sel.r0][sel.c0];
      for (var r = sel.r0; r <= sel.r1; r++) {
        for (var c = sel.c0; c <= sel.c1; c++) {
          if (r === sel.r0 && c === sel.c0) continue;
          rows[r][c] = "";
        }
      }
      rows[sel.r0][sel.c0] = keep;
      merges.push({
        r: sel.r0,
        c: sel.c0,
        rowSpan: sel.r1 - sel.r0 + 1,
        colSpan: sel.c1 - sel.c0 + 1
      });
      this.state.merges[this.state.activeSheet] = merges;
      this._setStatus("Cells merged", true);
      this.render();
      return;
    }

    if (action === "unmerge") {
      if (!sel) {
        this._setStatus("Select a merged cell to unmerge", false);
        return;
      }
      var before = merges.length;
      merges = removeOverlappingMerges(merges, sel.r0, sel.c0, sel.r1, sel.c1);
      if (merges.length === before) {
        this._setStatus("No merge in selection", false);
        return;
      }
      this.state.merges[this.state.activeSheet] = merges;
      this._setStatus("Unmerged", true);
      this.render();
      return;
    }

    if (action === "add-sheet") {
      var name = window.prompt("New sheet name", "Sheet " + (namesCount(this.state.sheets) + 1));
      if (!name) return;
      name = String(name).trim();
      if (!name || name.charAt(0) === "_") {
        this._setStatus("Invalid sheet name", false);
        return;
      }
      if (this.state.sheets[name]) {
        this._setStatus("Sheet already exists", false);
        return;
      }
      this.state.sheets[name] = [["Column A", "Column B"], ["", ""]];
      this.state.merges[name] = [];
      this.state.layout[name] = emptyLayout();
      this.state.activeSheet = name;
      this.state.selection = null;
      this._setStatus("Sheet created", true);
      this.render();
      return;
    }

    if (action === "rename-sheet") {
      var cur = this.state.activeSheet;
      var next = window.prompt("Rename sheet", cur);
      if (!next) return;
      next = String(next).trim();
      if (!next || next.charAt(0) === "_" || next === cur) return;
      if (this.state.sheets[next]) {
        this._setStatus("Sheet already exists", false);
        return;
      }
      this.state.sheets[next] = this.state.sheets[cur];
      delete this.state.sheets[cur];
      this.state.merges[next] = this.state.merges[cur] || [];
      delete this.state.merges[cur];
      this.state.layout[next] = this.state.layout[cur] || emptyLayout();
      delete this.state.layout[cur];
      this.state.activeSheet = next;
      this._setStatus("Sheet renamed", true);
      this.render();
      return;
    }

    if (action === "del-sheet") {
      var names = sheetNames(this.state.sheets);
      if (names.length <= 1) {
        this._setStatus("Keep at least one sheet", false);
        return;
      }
      if (!window.confirm('Delete sheet "' + this.state.activeSheet + '"?')) return;
      var gone = this.state.activeSheet;
      delete this.state.sheets[gone];
      delete this.state.merges[gone];
      delete this.state.layout[gone];
      this.state.activeSheet = sheetNames(this.state.sheets)[0];
      this.state.selection = null;
      this._setStatus("Sheet deleted", true);
      this.render();
    }
  };

  function namesCount(sheets) {
    return sheetNames(sheets).length;
  }

  SheetEditor.prototype._onKeyDown = function (e) {
    if (!this.state || this.root.hidden) return;
    var meta = e.metaKey || e.ctrlKey;
    if (meta && String(e.key).toLowerCase() === "s") {
      e.preventDefault();
      this.save();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
    }
  };

  SheetEditor.prototype.save = function () {
    var self = this;
    if (!this.state || this.state.saving) return;
    this._syncAllCells();
    this.state.saving = true;
    this._setStatus("Saving…", false);
    this.render();

    var payload;
    if (this.state.kind === "scope") {
      payload = clone(this.state.sheets);
      payload._merges = clone(this.state.merges);
      payload._layout = clone(this.state.layout);
    } else if (this.state.kind === "feedback") {
      payload = {
        sheets: clone(this.state.sheets),
        merges: clone(this.state.merges),
        layout: clone(this.state.layout)
      };
    } else {
      payload = {
        document: clone(this.state.document || {}),
        sheets: clone(this.state.sheets),
        merges: clone(this.state.merges),
        layout: clone(this.state.layout)
      };
    }

    Promise.resolve(this.onSave(this.state.kind, payload))
      .then(function () {
        if (!self.state) return;
        self.state.saving = false;
        self._setStatus(
          "Saved " +
            new Date().toLocaleTimeString("en-IN", {
              hour: "numeric",
              minute: "2-digit",
              second: "2-digit"
            }),
          true
        );
        self.render();
      })
      .catch(function (err) {
        if (!self.state) return;
        self.state.saving = false;
        self._setStatus(err.message || "Save failed", false);
        self.render();
      });
  };

  SheetEditor.sheetNames = sheetNames;
  SheetEditor.buildCoverMap = buildCoverMap;
  SheetEditor.escapeHtml = escapeHtml;
  SheetEditor.ensureRect = ensureRect;

  global.SheetEditor = SheetEditor;
})(window);
