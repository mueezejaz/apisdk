export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gemini LB — Key Dashboard</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --yellow: #d29922; --red: #f85149;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .wrap { max-width: 1020px; margin: 0 auto; padding: 24px 16px 60px; }
  header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
  h1 { font-size: 18px; margin: 0; }
  h1 span { color: var(--accent); }
  .muted { color: var(--muted); font-size: 12px; }
  button {
    background: var(--panel); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 13px;
  }
  button:hover { border-color: var(--accent); }
  button.primary { background: #238636; border-color: #2ea043; }
  button.primary:hover { background: #2ea043; }
  button.danger:hover { border-color: var(--red); color: var(--red); }
  button.ghost { background: transparent; border-style: dashed; }
  input[type=text], input[type=password], input[type=number] {
    background: var(--bg); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 8px 10px; font-size: 13px; width: 100%;
  }
  input:focus { outline: none; border-color: var(--accent); }
  input[type=number] { -moz-appearance: textfield; }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .panel-title { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin-bottom: 10px; }
  .grid3 { display: grid; grid-template-columns: 1fr 1fr 2fr; gap: 8px; margin-bottom: 8px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .models-box { border: 1px dashed var(--border); border-radius: 6px; padding: 8px; margin-top: 4px; }
  .model-row { display: grid; grid-template-columns: 1fr 110px 110px 32px; gap: 6px; align-items: center; margin-bottom: 6px; }
  .model-row:last-child { margin-bottom: 0; }
  .model-row .hdr { font-size: 10px; text-transform: uppercase; color: var(--muted); text-align: center; }
  .rm-btn { padding: 4px 0; width: 32px; text-align: center; color: var(--muted); }
  .rm-btn:hover { color: var(--red); border-color: var(--red); }
  .form-actions { display: flex; gap: 8px; margin-top: 12px; align-items: center; }
  .group-hdr {
    display: flex; align-items: baseline; gap: 8px; margin: 22px 0 10px;
    font-size: 13px; color: var(--accent); font-weight: 600;
  }
  .group-hdr .proj { color: var(--muted); font-weight: 400; font-size: 12px; }
  .group-hdr:before { content: ""; width: 8px; height: 8px; border-radius: 2px; background: var(--accent); flex: none; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; margin-bottom: 10px; }
  .card.disabled { opacity: 0.55; }
  .card-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .key-id { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 13px; }
  .acct-chip { background: #1f6feb33; color: var(--accent); border-radius: 10px; padding: 1px 9px; font-size: 12px; }
  .proj-chip { background: #30363d; color: var(--muted); border-radius: 10px; padding: 1px 9px; font-size: 12px; }
  .spacer { flex: 1; }
  .err-badge { background: #f8514922; color: var(--red); border: 1px solid #f8514955; border-radius: 10px; padding: 1px 9px; font-size: 12px; cursor: pointer; }
  .err-badge.none { background: transparent; color: var(--muted); border-color: var(--border); cursor: default; }
  .usage { margin-top: 12px; display: grid; gap: 8px; }
  .usage-row { display: grid; grid-template-columns: 230px 1fr; gap: 10px; align-items: center; }
  .model-name { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, Consolas, monospace; }
  .bars { display: grid; gap: 4px; }
  .bar-line { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--muted); }
  .bar-line .tag { width: 52px; flex: none; }
  .track { flex: 1; height: 7px; background: #21262d; border-radius: 4px; overflow: hidden; }
  .fill { height: 100%; background: var(--green); border-radius: 4px; transition: width .4s; }
  .fill.warn { background: var(--yellow); }
  .fill.crit { background: var(--red); }
  .bar-line .num { width: 74px; flex: none; text-align: right; font-variant-numeric: tabular-nums; }
  .errors { margin-top: 10px; border-top: 1px solid var(--border); padding-top: 8px; display: none; }
  .errors.open { display: block; }
  .err-item { display: flex; gap: 10px; padding: 5px 0; font-size: 12px; border-bottom: 1px dashed #21262d; align-items: baseline; }
  .err-item:last-child { border-bottom: none; }
  .chip { border-radius: 4px; padding: 0 6px; font-size: 11px; font-weight: 600; flex: none; }
  .chip.e429 { background: #d2992222; color: var(--yellow); }
  .chip.ered { background: #f8514922; color: var(--red); }
  .chip.egray { background: #21262d; color: var(--muted); }
  .err-msg { flex: 1; color: var(--muted); word-break: break-word; }
  .err-time { color: var(--muted); flex: none; font-variant-numeric: tabular-nums; }
  .editbox { margin-top: 12px; border-top: 1px dashed var(--border); padding-top: 12px; }
  .editbox .grid3 { grid-template-columns: 1fr 1fr; }
  .switch { position: relative; width: 36px; height: 20px; flex: none; }
  .switch input { opacity: 0; width: 0; height: 0; }
  .slider { position: absolute; inset: 0; background: #30363d; border-radius: 12px; cursor: pointer; transition: .2s; }
  .slider:before { content: ""; position: absolute; width: 14px; height: 14px; left: 3px; top: 3px; background: #8b949e; border-radius: 50%; transition: .2s; }
  .switch input:checked + .slider { background: #238636; }
  .switch input:checked + .slider:before { transform: translateX(16px); background: #fff; }
  .empty { text-align: center; color: var(--muted); padding: 40px 0; }
  .toast { position: fixed; bottom: 20px; right: 20px; background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 10px 16px; display: none; z-index: 10; }
  .toast.show { display: block; }
  .toast.err { border-color: var(--red); color: var(--red); }
  #login-overlay { position: fixed; inset: 0; background: var(--bg); display: none; align-items: center; justify-content: center; z-index: 100; }
  #login-overlay.show { display: flex; }
  .login-box { width: 320px; }
  .login-box h2 { font-size: 16px; margin: 0 0 14px; text-align: center; }
  .login-box .row { display: grid; gap: 10px; }
  .login-error { color: var(--red); font-size: 12px; min-height: 16px; text-align: center; }
  @media (max-width: 720px) {
    .grid3, .grid2 { grid-template-columns: 1fr; }
    .model-row { grid-template-columns: 1fr 80px 80px 32px; }
    .usage-row { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div id="login-overlay">
  <div class="login-box">
    <h2>🔐 Gemini LB Dashboard</h2>
    <form class="row" id="login-form">
      <input type="password" id="login-password" placeholder="Dashboard password" autocomplete="current-password">
      <div class="login-error" id="login-error"></div>
      <button class="primary" type="submit">Sign in</button>
    </form>
  </div>
</div>

<div class="wrap">
  <header>
    <h1>Gemini <span>LB</span> · API Key Dashboard</h1>
    <div style="display:flex;gap:10px;align-items:center">
      <span class="muted" id="updated"></span>
      <button id="logout-btn" style="display:none">Logout</button>
    </div>
  </header>

  <div class="panel">
    <div class="panel-title">Add API key</div>
    <form id="add-form">
      <div class="grid3">
        <input type="text" id="add-account" placeholder="Account name *" autocomplete="off">
        <input type="text" id="add-project" placeholder="Project name *" autocomplete="off">
        <input type="text" id="add-key" placeholder="AIza… API key *" autocomplete="off">
      </div>

      <div class="models-box">
        <div class="model-row" style="margin-bottom:6px">
          <span class="hdr" style="text-align:left">Model ID</span>
          <span class="hdr">Max / min</span>
          <span class="hdr">Max / day</span>
          <span></span>
        </div>
        <div id="add-models"></div>
      </div>

      <div class="form-actions">
        <button type="button" class="ghost" id="add-model-btn">+ Add model</button>
        <span class="spacer"></span>
        <button class="primary" type="submit">+ Add key</button>
      </div>
    </form>
  </div>

  <div id="keys"></div>
</div>

<div class="toast" id="toast"></div>

<script>
(function () {
  var editingId = null;
  var openErrors = {};
  var authed = false;
  var defaults = null; // { models: [...], maxPerMinute, maxPerDay, windowMs }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function toast(msg, isErr) {
    var t = document.getElementById("toast");
    t.textContent = msg;
    t.className = "toast show" + (isErr ? " err" : "");
    setTimeout(function () { t.className = "toast"; }, 2600);
  }

  async function req(path, opts) {
    opts = opts || {};
    opts.headers = { "Content-Type": "application/json" };
    var res = await fetch(path, opts);
    if (res.status === 401) {
      authed = false;
      showLogin();
      throw new Error("unauthorized");
    }
    if (!res.ok) {
      var body = await res.json().catch(function () { return {}; });
      throw new Error(body.error || ("HTTP " + res.status));
    }
    return res.json();
  }

  function showLogin(msg) {
    document.getElementById("login-overlay").classList.add("show");
    document.getElementById("logout-btn").style.display = "none";
    document.getElementById("login-error").textContent = msg || "";
    setTimeout(function () { document.getElementById("login-password").focus(); }, 50);
  }

  function hideLogin() {
    document.getElementById("login-overlay").classList.remove("show");
    document.getElementById("logout-btn").style.display = "";
  }

  // ── Model rows (shared by add form and edit box) ─────────────────

  function makeModelRow(container, modelId, rpm, dpm) {
    var row = document.createElement("div");
    row.className = "model-row";

    var idInput = document.createElement("input");
    idInput.type = "text";
    idInput.className = "m-id";
    idInput.placeholder = "e.g. gemini-3.1-flash-lite";
    idInput.value = modelId || "";
    idInput.setAttribute("autocomplete", "off");

    var rpmInput = document.createElement("input");
    rpmInput.type = "number";
    rpmInput.className = "m-rpm";
    rpmInput.min = "1";
    rpmInput.placeholder = "max/min";
    rpmInput.value = String(rpm || (defaults ? defaults.maxPerMinute : 15));

    var dpmInput = document.createElement("input");
    dpmInput.type = "number";
    dpmInput.className = "m-dpm";
    dpmInput.min = "1";
    dpmInput.placeholder = "max/day";
    dpmInput.value = String(dpm || (defaults ? defaults.maxPerDay : 500));

    var rm = document.createElement("button");
    rm.type = "button";
    rm.className = "rm-btn";
    rm.title = "Remove model";
    rm.textContent = "✕";
    rm.addEventListener("click", function () {
      if (container.children.length <= 1) {
        toast("At least one model is required", true);
        return;
      }
      row.remove();
    });

    row.appendChild(idInput);
    row.appendChild(rpmInput);
    row.appendChild(dpmInput);
    row.appendChild(rm);
    container.appendChild(row);
    idInput.focus();
    return row;
  }

  function collectModels(container) {
    var models = [];
    container.querySelectorAll(".model-row").forEach(function (row) {
      var id = row.querySelector(".m-id").value.trim();
      if (!id) return;
      models.push({
        id: id,
        maxPerMinute: parseInt(row.querySelector(".m-rpm").value, 10) || 15,
        maxPerDay: parseInt(row.querySelector(".m-dpm").value, 10) || 500
      });
    });
    return models;
  }

  function fillAddDefaults() {
    var box = document.getElementById("add-models");
    if (box.children.length > 0 || !defaults) return;
    var suggested = defaults.models && defaults.models[0]
      ? [{ id: defaults.models[0], rpm: defaults.maxPerMinute, dpm: defaults.maxPerDay }]
      : [{ id: "", rpm: 15, dpm: 500 }];
    makeModelRow(box, suggested[0].id, suggested[0].rpm, suggested[0].dpm);
  }

  // ── Rendering ─────────────────────────────────────────────────────

  function barClass(used, total) {
    var pct = total > 0 ? used / total : 0;
    if (pct >= 0.9) return "fill crit";
    if (pct >= 0.7) return "fill warn";
    return "fill";
  }

  function barLine(tag, used, total) {
    var pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
    return '<div class="bar-line">' +
      '<span class="tag">' + tag + '</span>' +
      '<span class="track"><span class="' + barClass(used, total) + '" style="width:' + pct + '%"></span></span>' +
      '<span class="num">' + used + " / " + total + '</span>' +
      '</div>';
  }

  function errChip(status) {
    var cls = "egray";
    var txt = status ? String(status) : "ERR";
    if (status === 429) cls = "e429";
    else if (status && (status === 401 || status === 403 || status >= 500)) cls = "ered";
    return '<span class="chip ' + cls + '">' + esc(txt) + '</span>';
  }

  function editBoxHtml(k) {
    var h = '<div class="editbox">';
    h += '<div class="grid2">' +
      '<input type="text" class="ed-account" placeholder="account" value="' + esc(k.account) + '">' +
      '<input type="text" class="ed-project" placeholder="project" value="' + esc(k.project) + '">' +
      '</div>';
    h += '<div style="margin-top:8px"><input type="text" class="ed-key" placeholder="rotate key — leave blank to keep current" autocomplete="off"></div>';
    h += '<div class="models-box" style="margin-top:8px">' +
      '<div class="model-row" style="margin-bottom:6px">' +
      '<span class="hdr" style="text-align:left">Model ID</span>' +
      '<span class="hdr">Max / min</span>' +
      '<span class="hdr">Max / day</span><span></span></div>' +
      '<div class="ed-models"></div></div>';
    h += '<div class="form-actions">' +
      '<button type="button" class="ghost" data-act="ed-add-model">+ Add model</button>' +
      '<span class="spacer"></span>' +
      '<button class="primary" data-act="save">Save</button>' +
      '<button data-act="cancel">Cancel</button>' +
      '</div>';
    h += '</div>';
    return h;
  }

  function cardHtml(k, stats, errors) {
    var h = '<div class="card' + (k.enabled ? "" : " disabled") + '" data-id="' + k.id + '">';

    h += '<div class="card-head">';
    h += '<span class="key-id">' + esc(k.masked) + '</span>';
    if (k.account) h += '<span class="acct-chip">' + esc(k.account) + '</span>';
    if (k.project) h += '<span class="proj-chip">' + esc(k.project) + '</span>';
    h += '<span class="muted">' + k.models.length + ' model' + (k.models.length === 1 ? "" : "s") + ' · added ' + new Date(k.createdAt).toLocaleDateString() + '</span>';
    h += '<span class="spacer"></span>';

    if (errors.length > 0) {
      h += '<span class="err-badge" data-act="errs">' + errors.length + ' recent err</span>';
    } else {
      h += '<span class="err-badge none">no errors</span>';
    }

    h += '<label class="switch" title="Enable / disable"><input type="checkbox" data-act="toggle"' + (k.enabled ? " checked" : "") + '><span class="slider"></span></label>';
    h += '<button data-act="edit">Edit</button>';
    h += '<button class="danger" data-act="del">Delete</button>';
    h += '</div>';

    if (editingId === k.id) h += editBoxHtml(k);

    if (stats.length > 0) {
      h += '<div class="usage">';
      stats.forEach(function (s) {
        h += '<div class="usage-row">' +
          '<span class="model-name" title="' + esc(s.model) + '">' + esc(s.model) + '</span>' +
          '<span class="bars">' +
          barLine("min", s.minuteUsed, s.minuteUsed + s.minuteRemaining) +
          barLine("day", s.dayUsed, s.dayUsed + s.dayRemaining) +
          '</span></div>';
      });
      h += '</div>';
    }

    h += '<div class="errors' + (openErrors[k.id] ? " open" : "") + '">';
    if (errors.length === 0) h += '<div class="muted">No recent errors.</div>';
    errors.forEach(function (e) {
      var when = e.ts ? new Date(e.ts) : null;
      h += '<div class="err-item">' +
        errChip(e.status) +
        '<span class="err-msg">' + esc(e.message) + ' <span class="muted">(' + esc(e.model) + ')</span></span>' +
        '<span class="err-time">' + (when ? when.toLocaleString() : "") + '</span>' +
        '</div>';
    });
    h += '</div>';

    h += '</div>';
    return h;
  }

  function render(data) {
    defaults = data.defaults || defaults;

    var byKey = {};
    (data.stats || []).forEach(function (s) {
      (byKey[s.keyId] = byKey[s.keyId] || []).push(s);
    });

    var el = document.getElementById("keys");
    if (!data.keys.length) {
      el.innerHTML = '<div class="card empty">No API keys yet — add one above.</div>';
      fillAddDefaults();
      return;
    }

    // Group: account → project → keys (server already sorts, keep stable order)
    var html = "";
    var lastGroup = null;
    data.keys.forEach(function (k) {
      var group = (k.account || "—") + " / " + (k.project || "—");
      if (group !== lastGroup) {
        html += '<div class="group-hdr">' + esc(k.account || "unassigned") +
          ' <span class="proj">/ ' + esc(k.project || "unassigned") + '</span></div>';
        lastGroup = group;
      }
      html += cardHtml(k, byKey[k.id] || [], (data.errors || {})[k.id] || []);
    });
    el.innerHTML = html;

    fillAddDefaults();
    wireCards();
  }

  function wireCards() {
    document.querySelectorAll(".card[data-id]").forEach(function (card) {
      var id = card.getAttribute("data-id");

      card.querySelectorAll("[data-act]").forEach(function (elm) {
        var act = elm.getAttribute("data-act");
        var handler = null;

        if (act === "edit") handler = function () { editingId = id; refresh(true); };
        if (act === "cancel") handler = function () { editingId = null; refresh(true); };
        if (act === "errs") handler = function () { openErrors[id] = !openErrors[id]; refresh(true); };
        if (act === "ed-add-model") handler = function () {
          makeModelRow(card.querySelector(".ed-models"), "", null, null);
        };
        if (act === "toggle") handler = function () {
          req("/api/keys/" + id, { method: "PATCH", body: JSON.stringify({ enabled: elm.checked }) })
            .then(function () { refresh(); })
            .catch(function (e) { toast(e.message, true); refresh(); });
        };
        if (act === "del") handler = function () {
          if (!confirm("Delete this key? Its usage stats and errors will be removed.")) return;
          req("/api/keys/" + id, { method: "DELETE" })
            .then(function () { toast("Key deleted"); refresh(); })
            .catch(function (e) { toast(e.message, true); });
        };
        if (act === "save") handler = function () {
          var account = card.querySelector(".ed-account").value.trim();
          var project = card.querySelector(".ed-project").value.trim();
          var models = collectModels(card.querySelector(".ed-models"));
          if (!account) { toast("Account is required", true); return; }
          if (!project) { toast("Project is required", true); return; }
          if (models.length === 0) { toast("At least one model with an ID is required", true); return; }

          var patch = { account: account, project: project, models: models };
          var newKey = card.querySelector(".ed-key").value.trim();
          if (newKey) patch.key = newKey;

          req("/api/keys/" + id, { method: "PATCH", body: JSON.stringify(patch) })
            .then(function () { editingId = null; toast("Saved"); refresh(); })
            .catch(function (e) { toast(e.message, true); });
        };

        if (handler) {
          if (act === "toggle") elm.addEventListener("change", handler);
          else elm.addEventListener("click", handler);
        }
      });

      if (editingId === id) {
        var box = card.querySelector(".ed-models");
        var key = data_key(id);
        if (box && box.children.length === 0 && key) {
          key.models.forEach(function (m) {
            makeModelRow(box, m.id, m.maxPerMinute, m.maxPerDay);
          });
          if (key.models.length === 0) makeModelRow(box, "", null, null);
        }
        var first = card.querySelector(".ed-account");
        if (first) first.focus();
      }
    });
  }

  // last overview data, for populating the edit box
  var lastData = null;
  function data_key(id) {
    if (!lastData) return null;
    return lastData.keys.find(function (k) { return k.id === id; }) || null;
  }

  async function refresh(force) {
    if (!authed && !force) return;
    try {
      var data = await req("/api/overview");
      authed = true;
      hideLogin();
      lastData = data;
      render(data);
      document.getElementById("updated").textContent =
        "updated " + new Date().toLocaleTimeString();
    } catch (e) {
      if (e.message !== "unauthorized") toast(e.message, true);
    }
  }

  // ── Events ────────────────────────────────────────────────────────

  document.getElementById("login-form").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    var pw = document.getElementById("login-password").value;
    try {
      var res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw })
      });
      if (!res.ok) {
        document.getElementById("login-error").textContent = "Wrong password";
        return;
      }
      document.getElementById("login-password").value = "";
      authed = true;
      hideLogin();
      refresh();
    } catch (e) {
      document.getElementById("login-error").textContent = e.message;
    }
  });

  document.getElementById("logout-btn").addEventListener("click", async function () {
    await fetch("/api/logout", { method: "POST" }).catch(function () {});
    authed = false;
    showLogin();
  });

  document.getElementById("add-model-btn").addEventListener("click", function () {
    makeModelRow(document.getElementById("add-models"), "", null, null);
  });

  document.getElementById("add-form").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    var account = document.getElementById("add-account").value.trim();
    var project = document.getElementById("add-project").value.trim();
    var key = document.getElementById("add-key").value.trim();
    var models = collectModels(document.getElementById("add-models"));

    if (!account) { toast("Account name is required", true); return; }
    if (!project) { toast("Project name is required", true); return; }
    if (!key) { toast("API key is required", true); return; }
    if (models.length === 0) { toast("At least one model with an ID is required", true); return; }

    try {
      await req("/api/keys", {
        method: "POST",
        body: JSON.stringify({ account: account, project: project, key: key, models: models })
      });
      document.getElementById("add-key").value = "";
      toast("Key added");
      refresh();
    } catch (e) {
      toast(e.message, true);
    }
  });

  setInterval(function () {
    if (authed && document.visibilityState === "visible") refresh();
  }, 5000);

  refresh(true);
})();
</script>
</body>
</html>`;
