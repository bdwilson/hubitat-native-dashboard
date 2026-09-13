  // Only skip if source is explicitly something other than DEVICE (e.g. 'APP', 'LOCATION').
  if (!evt || (evt.source && evt.source !== 'DEVICE')) return;
  if (!evt.deviceId) return;
  console.debug('[ws event]', evt.source ?? '(no source)', evt.name, evt.value, 'deviceId:', evt.deviceId);
  lastDataAt = Date.now();
  applyDeviceAttrUpdate(evt.deviceId, evt.name, evt.value);
}

// ── Settings modal ────────────────────────────────────────────────────────────

const settingsModal = document.getElementById('settings-modal');
function refreshPresencePickerList() {
  const list = document.getElementById('presence-picker-list');
  if (!list) return;
  const presenceDevs = devices.filter(d =>
    hasCapability(d, 'PresenceSensor') || getAttr(d, 'presence') !== undefined
  ).sort((a, b) => (a.label || a.name || '').localeCompare(b.label || b.name || ''));
  if (!presenceDevs.length) {
    list.innerHTML = '<div style="color:var(--text-dim);font-size:12px">No presence devices found. Click "Reload Devices &amp; Test" above.</div>';
    return;
  }
  list.innerHTML = presenceDevs.map(d => {
    const id = String(d.id);
    const deviceLabel = d.label || d.name || id;
    const savedLabel  = statusBarPresenceDevices[id]?.label || '';
    const checked = statusBarPresenceDevices[id] ? 'checked' : '';
    return `<div style="display:flex;align-items:center;gap:8px">
      <input type="checkbox" class="presence-bar-cb" data-device-id="${escapeHtml(id)}" ${checked}>
      <input type="text" class="presence-bar-label" data-device-id="${escapeHtml(id)}"
        value="${escapeHtml(savedLabel)}"
        placeholder="${escapeHtml(deviceLabel)}"
        style="flex:1;background:var(--surface-2);border:1px solid var(--tile-border);color:var(--tile-text);padding:3px 6px;border-radius:3px;font-size:12px">
    </div>`;
  }).join('');
}

function openSettings() {
  document.getElementById('cfg-url').value   = cfg.hubBaseUrl || '';
  const hubId = extractHubId();
  const hubIdRow = document.getElementById('hub-id-row');
  const hubIdDisplay = document.getElementById('hub-id-display');
  if (hubId && hubIdDisplay) {
    hubIdDisplay.value = hubId;
    if (hubIdRow) hubIdRow.style.display = '';
  } else if (hubIdRow) {
    hubIdRow.style.display = 'none';
  }
  document.getElementById('cfg-app').value   = cfg.hubAppId  || '';
  document.getElementById('cfg-token').value = '';
  document.getElementById('cfg-token').placeholder = cfg.hubToken
    ? '••• token saved in browser; re-enter to update'
    : cfg.hubHasToken ? '••• token stored on the hub; re-enter to change'
    : 'paste Maker API access token';
  document.getElementById('token-status').textContent = cfg.hubToken
    ? '✓ in browser'
    : cfg.hubHasToken ? '✓ on hub'
    : '⚠ not set';
  document.getElementById('show-token-cb').checked      = false;
  // Auto-detect from URL when possible; manual checkbox only needed for ambiguous cases
  document.getElementById('cfg-is-cloud').checked = cfg.hubBaseUrl
    ? cfg.hubBaseUrl.includes('cloud.hubitat.com')
    : !!cfg.hubIsCloud;
  document.getElementById('cfg-hub-link').value          = cfg.hubExternalUrl || '';
  document.getElementById('cfg-poll').value             = cfg.pollSec;
  document.getElementById('cfg-title').value            = cfg.title || 'Home';
  document.getElementById('cfg-grid-cols').value        = String(cfg.gridCols || 3);
  document.getElementById('cfg-tile-h').value           = String(cfg.tileH || 80);
  document.getElementById('cfg-icon-scale').value       = String(cfg.iconScale || 1);
  document.getElementById('cfg-icon-scale-out').textContent = `${Math.round((cfg.iconScale || 1) * 100)}%`;
  document.getElementById('cfg-chip-accent').value      = cfg.chipAccent || '#2d7fbf';
  document.getElementById('cfg-chip-accent-dynamic').value = cfg.chipAccentDynamic || '#2d7fbf';
  document.getElementById('cfg-theme').value            = cfg.theme || 'auto';
  refreshPresencePickerList();
  refreshCustomDashList();
  renderDashboardManager();
  syncAutoDynamicCheckbox();
  settingsModal.classList.add('open');
}
function closeSettings() { settingsModal.classList.remove('open'); }

document.getElementById('open-settings').addEventListener('click', openSettings);
document.getElementById('open-hub-link').addEventListener('click', () => {
  if (cfg.hubExternalUrl) window.open(cfg.hubExternalUrl, '_blank', 'noopener,noreferrer');
  else openSettings();
});
document.getElementById('close-settings').addEventListener('click', async () => {
  readSettingsForm(); saveConfigCache();
  closeSettings();
  renderAll(); startPolling(); refreshAll();
});

document.getElementById('save-cfg').addEventListener('click', async () => {
  readSettingsForm(); saveConfigCache();
  setStatus('Saving to hub…', '');
  try {
    const payload = {
      // Hub URL/appId saved to KV for WebSocket and reference — token intentionally excluded
      hub: { baseUrl: cfg.hubBaseUrl, appId: cfg.hubAppId, isCloud: cfg.hubIsCloud },
      dashboard: {
        title: cfg.title, pollSec: cfg.pollSec,
        slots: cfg.slots, layout: cfg.layout,
        gridCols: cfg.gridCols, tileH: cfg.tileH,
        iconScale: cfg.iconScale, hubExternalUrl: cfg.hubExternalUrl,
        chipAccent: cfg.chipAccent, chipAccentDynamic: cfg.chipAccentDynamic,
        theme: cfg.theme,
      },
    };
    if (Object.keys(dynamicHidden).length || Object.keys(dynamicOrder).length || Object.keys(dynamicOverrides).length) {
      payload.dynamic = { hidden: dynamicHidden, order: dynamicOrder,
        overrides: Object.keys(dynamicOverrides).length ? dynamicOverrides : undefined };
    }
    if (Object.keys(customDashboards).length) {
      payload.custom = customDashboards;
    }
    if (Object.keys(dashboardsVisible).length) {
      payload.dashboardsVisible = dashboardsVisible;
    }
    if (dashboardsOrder.length) {
      payload.dashboardsOrder = dashboardsOrder;
    }
    // Collect presence bar selections from the settings checkbox list
    const newPresence = {};
    document.querySelectorAll('.presence-bar-cb').forEach(cb => {
      if (cb.checked) {
        const id = cb.dataset.deviceId;
        const labelInput = document.querySelector(`.presence-bar-label[data-device-id="${id}"]`);
        const label = (labelInput && labelInput.value.trim()) || labelInput?.placeholder || id;
        newPresence[id] = { label, kind: 'presence' };
      }
    });
    // Preserve entries for devices not currently listed (devices not loaded this session)
    Object.entries(statusBarPresenceDevices).forEach(([id, info]) => {
      if (!document.querySelector(`.presence-bar-cb[data-device-id="${id}"]`)) {
        newPresence[id] = info;
      }
    });
    statusBarPresenceDevices = newPresence;
    if (Object.keys(statusBarPresenceDevices).length) {
      payload.statusBarPresenceDevices = statusBarPresenceDevices;
    }
    await pushConfigToWorker(payload);
    markClean();
    setStatus('✓ Saved to hub.', 'ok');
    const serverCfg = await fetchConfigFromWorker(false).catch(() => null);
    if (serverCfg) applyServerConfig(serverCfg);
  } catch (e) {
    setStatus(`✗ Save failed: ${e.message}`, 'err');
  }
});

document.getElementById('reset-cfg').addEventListener('click', async () => {
  if (!confirm('Wipe ALL dashboard config from browser and KV (if configured)? Cannot be undone.')) return;
  let kvMsg = '';
  try {
    const r = await fetch(API_CONFIG, { method: 'DELETE', credentials: 'same-origin', headers: workerHeaders() });
    if (r.status === 503) {
      kvMsg = ' (KV not configured — browser only)';
    } else if (!r.ok) {
      throw new Error(`HTTP ${r.status}`);
    }
  } catch (e) {
    setStatus(`✗ Reset failed: ${e.message}`, 'err');
    return;
  }
  localStorage.removeItem(STORAGE_KEY);
  cfg = JSON.parse(JSON.stringify(defaultConfig));
  dynamicHidden = {}; dynamicOrder = {}; dynamicOverrides = {};
  customDashboards = {}; dashboardsVisible = {}; dashboardsOrder = [];
  statusBarPresenceDevices = {};
  devices = [];
  buildLayout(); renderAll(); openSettings();
  setStatus(`Config wiped${kvMsg}.`, 'ok');
});

document.getElementById('test-conn').addEventListener('click', async () => {
  readSettingsForm();
  setStatus('Testing connection…', '');
  const r = await refreshDevices();
  if (r.ok) {
    const imgCount = devices.filter(isImageDevice).length;
    setStatus(`✓ Connected. ${devices.length} devices (${imgCount} image device${imgCount===1?'':'s'}).`, 'ok');
    // Snapshot presence picker selections before rebuilding the list so checked
    // boxes aren't lost when refreshPresencePickerList() recreates the DOM.
    document.querySelectorAll('.presence-bar-cb').forEach(cb => {
      const id = cb.dataset.deviceId;
      if (cb.checked) {
        const labelInput = document.querySelector(`.presence-bar-label[data-device-id="${id}"]`);
        const label = (labelInput && labelInput.value.trim()) || labelInput?.placeholder || id;
        statusBarPresenceDevices[id] = { label, kind: 'presence' };
      } else {
        delete statusBarPresenceDevices[id];
      }
    });
    saveConfigCache();
    renderAll();
    refreshPresencePickerList();
    if (ws) { ws.close(); ws = null; }
    connectWebSocket();
  } else {
    setStatus(`✗ ${r.error}`, 'err');
  }
});

document.getElementById('cfg-url').addEventListener('input', e => {
  const url = e.target.value.trim();
  if (!url) return;

  // Auto-set cloud checkbox based on URL
  document.getElementById('cfg-is-cloud').checked = url.includes('cloud.hubitat.com');

  // Update Hub ID display to reflect what ID would be used with this URL
  const hubIdDisplay = document.getElementById('hub-id-display');
  const hubIdRow    = document.getElementById('hub-id-row');
  if (hubIdDisplay) {
    const hubId = extractHubId(url);
    hubIdDisplay.value = hubId || '';
    if (hubIdRow) hubIdRow.style.display = hubId ? '' : 'none';
  }
});

document.getElementById('cfg-icon-scale').addEventListener('input', e => {
  const scale = parseFloat(e.target.value) || 1;
  document.getElementById('cfg-icon-scale-out').textContent = `${Math.round(scale * 100)}%`;
  document.documentElement.style.setProperty('--icon-scale', String(scale));
});

document.getElementById('cfg-chip-accent').addEventListener('input', e => {
  document.documentElement.style.setProperty('--chip-accent', e.target.value);
});

document.getElementById('cfg-chip-accent-dynamic').addEventListener('input', e => {
  document.documentElement.style.setProperty('--chip-accent-dynamic', e.target.value);
});

document.getElementById('cfg-theme').addEventListener('change', e => {
  cfg.theme = e.target.value;
  applyTheme();
});

document.getElementById('show-token-cb').addEventListener('change', async e => {
  const tf = document.getElementById('cfg-token');
  if (e.target.checked) {
    if (cfg.hubToken) {
      // Token is in browser — show it directly, no server round-trip needed
      tf.type  = 'text';
      tf.value = cfg.hubToken;
    } else {
      // Fall back to KV fetch (legacy full-KV mode)
      try {
        const full = await fetchConfigFromWorker(true);
        tf.type  = 'text';
        tf.value = (full.hub && full.hub.token) || '';
      } catch (err) {
        setStatus(`Could not fetch token: ${err.message}`, 'err');
        e.target.checked = false;
      }
    }
  } else {
    tf.type  = 'password';
    tf.value = '';
  }
});

function readSettingsForm() {
  let rawUrl = document.getElementById('cfg-url').value.trim().replace(/\/$/, '');
  // Auto-add https:// if the user forgot the protocol — prevents the Worker's new URL() from throwing
  if (rawUrl && !rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) {
    rawUrl = 'https://' + rawUrl;
    document.getElementById('cfg-url').value = rawUrl;
  }
  cfg.hubBaseUrl = rawUrl;
  cfg.hubAppId   = document.getElementById('cfg-app').value.trim();
  const tok      = document.getElementById('cfg-token').value.trim();
  if (tok) { cfg.hubToken = tok; cfg.hubHasToken = true; }
  cfg.hubIsCloud = document.getElementById('cfg-is-cloud').checked;
  let hubLink    = document.getElementById('cfg-hub-link').value.trim();
  if (hubLink && !hubLink.startsWith('http://') && !hubLink.startsWith('https://')) {
    hubLink = 'https://' + hubLink;
    document.getElementById('cfg-hub-link').value = hubLink;
  }
  cfg.hubExternalUrl = hubLink;
  cfg.pollSec    = parseInt(document.getElementById('cfg-poll').value, 10) || 5;
  cfg.title      = document.getElementById('cfg-title').value.trim() || 'Home';
  cfg.gridCols   = parseInt(document.getElementById('cfg-grid-cols').value, 10) || 3;
  cfg.tileH      = parseInt(document.getElementById('cfg-tile-h').value, 10) || 80;
  cfg.iconScale  = parseFloat(document.getElementById('cfg-icon-scale').value) || 1;
  cfg.chipAccent = document.getElementById('cfg-chip-accent').value || '#2d7fbf';
  cfg.chipAccentDynamic = document.getElementById('cfg-chip-accent-dynamic').value || '#2d7fbf';
  cfg.theme      = document.getElementById('cfg-theme').value || 'auto';
  applyCssVars();
}
function setStatus(msg, kind) {
  const el = document.getElementById('conn-status');
  el.className = 'status-msg ' + (kind || '');
  el.textContent = msg;
}

// ── Dashboard Manager (in settings) ────────────────────────────────────────────

// Sync the "auto-generated dashboards" checkbox to current dashboardsVisible state.
// Checked = all dynamic groups visible; indeterminate = some; unchecked = none.
function syncAutoDynamicCheckbox() {
  const cb = document.getElementById('cfg-auto-dynamic');
  if (!cb) return;
  const allOn = DYNAMIC_GROUPS.every(g => dashboardsVisible[g.key] !== false);
  const anyOn = DYNAMIC_GROUPS.some(g => dashboardsVisible[g.key] !== false);
  cb.checked = allOn;
  cb.indeterminate = !allOn && anyOn;
}

document.getElementById('cfg-auto-dynamic').addEventListener('change', e => {
  DYNAMIC_GROUPS.forEach(g => { dashboardsVisible[g.key] = e.target.checked; });
  saveConfigCache();
  updateNavChips();
  renderDashboardManager();
});

function renderDashboardManager() {
  const managerList = document.getElementById('dashboard-manager-list');
  if (!managerList) return;

  // Build list of all dashboards
  const allDashboards = [
    { key: 'main', label: 'Main', kind: 'main' },
    ...DYNAMIC_GROUPS.map(g => ({ key: g.key, label: g.label, kind: 'dynamic' })),
    ...Object.entries(customDashboards).map(([name, dash]) =>
      ({ key: 'custom/' + name, label: dash.title || name, kind: 'custom' }))
  ];

  // Initialize if empty. Dynamic dashboards are opt-in; main/custom start visible.
  if (!dashboardsOrder.length) {
    dashboardsOrder = allDashboards.map(d => d.key);
    dashboardsVisible = {};
    allDashboards.forEach(d => { dashboardsVisible[d.key] = d.kind !== 'dynamic'; });
  }

  // Render draggable items for each dashboard
  let draggedIndex = null;
  managerList.innerHTML = dashboardsOrder
    .filter(key => allDashboards.some(d => d.key === key)) // Only render if still exists
    .map((key, index) => {
      const dashboard = allDashboards.find(d => d.key === key);
      const isVisible = dashboardsVisible[key] !== false;
      const cls = `dashboard-item${isVisible ? '' : ' hidden-dashboard'}`;
      return `<div class="${cls}" draggable="true" data-dashboard-key="${key}" data-dashboard-index="${index}">
        <span class="drag-handle" title="Drag to reorder">⠿</span>
        <input type="checkbox" ${isVisible ? 'checked' : ''} data-toggle-key="${key}" class="dashboard-toggle" />
        <label data-label-key="${key}">${escapeHtml(dashboard.label)}</label>
      </div>`;
    }).join('');

  // Bind toggle events
  managerList.querySelectorAll('.dashboard-toggle').forEach(toggle => {
    toggle.addEventListener('change', e => {
      const key = e.target.dataset.toggleKey;
      dashboardsVisible[key] = e.target.checked;
      saveConfigCache();
      // Update UI: add/remove hidden-dashboard class
      e.target.closest('.dashboard-item').classList.toggle('hidden-dashboard', !e.target.checked);
      updateNavChips();
      syncAutoDynamicCheckbox();
    });
  });

  // Bind drag events
  managerList.querySelectorAll('.dashboard-item').forEach((el, index) => {
    el.addEventListener('dragstart', e => {
      draggedIndex = index;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      managerList.querySelectorAll('.drag-over').forEach(t => t.classList.remove('drag-over'));
      draggedIndex = null;
    });
    el.addEventListener('dragover', e => {
      if (draggedIndex === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', e => {
      e.preventDefault();
      el.classList.remove('drag-over');
      const targetIndex = parseInt(el.dataset.dashboardIndex, 10);
      if (draggedIndex === null || draggedIndex === targetIndex) return;

      // Reorder the dashboards
      const [movedKey] = dashboardsOrder.splice(draggedIndex, 1);
      dashboardsOrder.splice(targetIndex, 0, movedKey);
      saveConfigCache();
      renderDashboardManager(); // Re-render with new order
      updateNavChips();
    });
  });
}

// Reset dashboards to default order and visibility
document.addEventListener('click', e => {
  if (e.target.id === 'reset-dashboards') {
    dashboardsOrder = [];
    dashboardsVisible = {};
    saveConfigCache();
    renderDashboardManager();
    updateNavChips();
  }
});

// ── Export / Import ───────────────────────────────────────────────────────────

function setIoStatus(msg, kind) {
  const el = document.getElementById('io-status');
  el.className = 'status-msg ' + (kind || '');
  el.textContent = msg;
  if (msg) setTimeout(() => { el.textContent = ''; el.className = ''; }, kind === 'warn' ? 12000 : 4000);
}

document.getElementById('export-cfg').addEventListener('click', async () => {
  const inc = confirm('Include hub access token in download?\n\nOK = include (sensitive)\nCancel = exclude');
  let out;
  try {
    out = await fetchConfigFromWorker(inc);
    if (!inc && out.hub) delete out.hub.token;
  } catch (e) {
    // KV not configured or unavailable — build export from in-memory state
    out = {
      hub: {
        baseUrl: cfg.hubBaseUrl,
        appId:   cfg.hubAppId,
        isCloud: cfg.hubIsCloud,
        ...(inc && cfg.hubToken ? { token: cfg.hubToken } : { hasToken: cfg.hubHasToken }),
      },
      dashboard: {
        title:          cfg.title,
        pollSec:        cfg.pollSec,
        slots:          cfg.slots,
        layout:         cfg.layout,
        gridCols:       cfg.gridCols,
        tileH:          cfg.tileH,
        iconScale:      cfg.iconScale,
        hubExternalUrl: cfg.hubExternalUrl,
        chipAccent:     cfg.chipAccent,
        chipAccentDynamic: cfg.chipAccentDynamic,
        theme:          cfg.theme,
      },
      dynamic:                  { hidden: dynamicHidden, order: dynamicOrder, overrides: dynamicOverrides },
      custom:                   customDashboards,
      dashboardsVisible,
      dashboardsOrder,
      statusBarPresenceDevices,
    };
  }
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const ts   = new Date().toISOString().replace(/[:.]/g,'-').substring(0,19);
  a.href = url; a.download = `hubitat-dashboard-${ts}${inc?'-with-token':''}.json`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  setIoStatus(`Downloaded${inc ? ' (includes token — keep secure)' : ''}.`, 'ok');
});

document.getElementById('import-cfg-btn').addEventListener('click', () => {
  document.getElementById('import-cfg-file').click();
});
document.getElementById('import-cfg-file').addEventListener('change', e => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      applyImportedConfig(JSON.parse(ev.target.result), 'file');
    } catch (err) { setIoStatus('Import failed: ' + err.message, 'err'); }
  };
  reader.readAsText(file);
  e.target.value = '';
});
document.getElementById('copy-cfg').addEventListener('click', async () => {
  try {
    const out = await fetchConfigFromWorker(false);
    await navigator.clipboard.writeText(JSON.stringify(out, null, 2));
    setIoStatus('Copied to clipboard.', 'ok');
  } catch (e) {
    document.getElementById('cfg-json').value = JSON.stringify(cfg, null, 2);
    setIoStatus('Clipboard blocked — showing in textarea.', 'err');
  }
});
document.getElementById('apply-json').addEventListener('click', () => {
  try {
    const txt = document.getElementById('cfg-json').value.trim();
    if (!txt) { setIoStatus('Textarea is empty.', 'err'); return; }
    applyImportedConfig(JSON.parse(txt), 'textarea');
  } catch (e) { setIoStatus('Parse failed: ' + e.message, 'err'); }
});
document.getElementById('show-json').addEventListener('click', async () => {
  try {
    const server = await fetchConfigFromWorker(false);
    document.getElementById('cfg-json').value = JSON.stringify(server, null, 2);
  } catch (e) { setIoStatus(`Could not fetch from KV: ${e.message}`, 'err'); }
});

function applyImportedConfig(parsed, source) {
  if (!parsed || typeof parsed !== 'object') throw new Error('Not a valid config object');
  let hub, dashboard;
  if (parsed.hub || parsed.dashboard) {
    hub = parsed.hub || {}; dashboard = parsed.dashboard || {};
  } else {
    hub = { baseUrl: parsed.url || parsed.hubBaseUrl || '', appId: parsed.appId || parsed.hubAppId || '', token: parsed.token || parsed.hubToken || '' };
    dashboard = { title: parsed.title, pollSec: parsed.pollSec, slots: parsed.slots };
  }
  cfg.hubBaseUrl = hub.baseUrl || ''; cfg.hubAppId = hub.appId || '';
  cfg.hubIsCloud = !!hub.isCloud;
  if (hub.token) { cfg.hubToken = hub.token; cfg.hubHasToken = true; }
  else if (hub.hasToken) { cfg.hubHasToken = true; }
  cfg.title   = dashboard.title   || cfg.title;
  cfg.pollSec = dashboard.pollSec || cfg.pollSec;
  if (dashboard.slots) cfg.slots = { ...DEFAULT_SLOTS, ...dashboard.slots };
  if (dashboard.layout) cfg.layout = dashboard.layout;
  if (typeof dashboard.gridCols  === 'number') cfg.gridCols  = dashboard.gridCols;
  if (typeof dashboard.tileH     === 'number') cfg.tileH     = dashboard.tileH;
  if (typeof dashboard.iconScale === 'number') cfg.iconScale = dashboard.iconScale;
  if (typeof dashboard.hubExternalUrl === 'string') cfg.hubExternalUrl = dashboard.hubExternalUrl;
  if (typeof dashboard.chipAccent === 'string') cfg.chipAccent = dashboard.chipAccent;
  if (typeof dashboard.chipAccentDynamic === 'string') cfg.chipAccentDynamic = dashboard.chipAccentDynamic;
  if (typeof dashboard.theme === 'string') cfg.theme = dashboard.theme;
  if (parsed.dynamic) {
    dynamicHidden    = parsed.dynamic.hidden    || {};
    dynamicOrder     = parsed.dynamic.order     || {};
    dynamicOverrides = parsed.dynamic.overrides || {};
  }
  if (parsed.custom)                   customDashboards         = parsed.custom;
  if (parsed.dashboardsVisible)        dashboardsVisible        = parsed.dashboardsVisible;
  if (parsed.dashboardsOrder)          dashboardsOrder          = parsed.dashboardsOrder;
  if (parsed.statusBarPresenceDevices) statusBarPresenceDevices = parsed.statusBarPresenceDevices;
  saveConfigCache();
  applyCssVars();
  markDirty();
  buildLayout(); renderAll(); updateNavChips(); refreshCustomDashList();
  // Sync form fields to the newly imported values so readSettingsForm() doesn't overwrite them
  const syncImportedField = (id, v) => {
    const el = document.getElementById(id);
    if (el && v != null) el.value = v;
  };
  syncImportedField('cfg-title', cfg.title);
  syncImportedField('cfg-poll', cfg.pollSec);
  syncImportedField('cfg-grid-cols', cfg.gridCols);
  syncImportedField('cfg-tile-h', cfg.tileH);
  syncImportedField('cfg-icon-scale', cfg.iconScale);
  const urlField = document.getElementById('cfg-url');
  if (urlField) urlField.value = cfg.hubBaseUrl;
  const appField = document.getElementById('cfg-app');
  if (appField) appField.value = cfg.hubAppId;
  const cloudCb = document.getElementById('cfg-is-cloud');
  if (cloudCb) cloudCb.checked = cfg.hubBaseUrl
    ? cfg.hubBaseUrl.includes('cloud.hubitat.com')
    : !!cfg.hubIsCloud;
  const hubLinkField = document.getElementById('cfg-hub-link');
  if (hubLinkField) hubLinkField.value = cfg.hubExternalUrl || '';
  const chipAccentField = document.getElementById('cfg-chip-accent');
  if (chipAccentField) chipAccentField.value = cfg.chipAccent || '#2d7fbf';
  const chipAccentDynamicField = document.getElementById('cfg-chip-accent-dynamic');
  if (chipAccentDynamicField) chipAccentDynamicField.value = cfg.chipAccentDynamic || '#2d7fbf';
  const themeSel = document.getElementById('cfg-theme');
  if (themeSel) themeSel.value = cfg.theme || 'auto';
  // Sync Hub ID display to the imported URL
  const hubIdDisplay = document.getElementById('hub-id-display');
  const hubIdRow = document.getElementById('hub-id-row');
  if (hubIdDisplay) {
    const hubId = extractHubId();
    hubIdDisplay.value = hubId || '';
    if (hubIdRow) hubIdRow.style.display = hubId ? '' : 'none';
  }
  // Also refresh the token status indicator in the settings form (which is open during import)
  const tf = document.getElementById('cfg-token');
  if (tf) tf.placeholder = cfg.hubToken
    ? '••• token saved in browser; re-enter to update'
    : cfg.hubHasToken ? '••• token not in export — paste it here to connect'
    : 'paste Maker API access token';
  const ts = document.getElementById('token-status');
  if (ts) ts.textContent = cfg.hubToken ? '✓ in browser' : cfg.hubHasToken ? '⚠ token needed' : '⚠ not set';
  const tokenMissing = !cfg.hubToken && hub.hasToken;
  setIoStatus(
    tokenMissing
      ? `Imported from ${source}. Settings restored — access token was not included. Paste your Maker API token in the field above, then click "Save to Browser & Test".`
      : `Imported from ${source}. Settings saved to this browser — click "Save Config to Hub" to sync to all devices.`,
    tokenMissing ? 'warn' : 'ok',
  );
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  readHash();
  applyCssVars();
  buildLayout();
  renderAll();
  renderView();   // apply section visibility from hash before config loads
  updateNavChips();

  // Load config from KV (source of truth)
  try {
    const serverCfg = await fetchConfigFromWorker(false);
    applyServerConfig(serverCfg);
    buildLayout();
    renderAll();
    renderView();  // re-apply after config (custom dashboards now loaded)
    updateNavChips();
    refreshCustomDashList();
    markClean(); // fresh from KV — no unsaved changes
  } catch (e) {
    console.warn('Could not load config from Worker, using cache:', e.message);
  }

  if (!cfg.hubBaseUrl || !cfg.hubAppId || (!cfg.hubToken && !cfg.hubHasToken)) {
    openSettings();
  } else {
    await refreshDevices();
    renderAll();
    updateStatusBar();
    // Try WebSocket first; fall back to polling on close/error
    connectWebSocket();
    // Also start polling as a safety net (WebSocket close disables polling when ws is live)
    startPolling();
    // Independent of both — catches devices added on the hub during a
    // long-lived WebSocket session (see startDeviceListSync above)
    startDeviceListSync();
  }
  // Re-evaluate 'auto' theme periodically so a long-lived kiosk display
  // crosses the day/night boundary without needing a reload.
  setInterval(applyTheme, 5 * 60 * 1000);
}

// ── Pull-to-refresh ───────────────────────────────────────────────────────────
// iOS Safari doesn't have a native pull-to-refresh gesture in standalone/PWA
// mode (unlike Android Chrome), so this implements one by hand. Only enabled
// in standalone mode — a regular browser tab already has its own reload
// affordances (URL bar, keyboard shortcut) so this isn't needed there.
function initPullToRefresh() {
  const isStandalone = window.navigator.standalone === true
    || window.matchMedia('(display-mode: standalone)').matches;
  if (!isStandalone) return;

  const PULL_THRESHOLD = 70; // px of (resistance-adjusted) pull before release triggers a refresh
  const MAX_PULL = 90;
  const RESISTANCE = 0.5;
  const indicator = document.getElementById('pull-refresh');
  let startY = 0;
  let pulling = false;
  let refreshing = false;
  let currentPull = 0;

  function setPull(px) {
    currentPull = px;
    indicator.style.transform = `translate(-50%, ${px - 60}px)`;
    indicator.classList.toggle('ready', px >= PULL_THRESHOLD);
  }

  document.addEventListener('touchstart', e => {
    // Ignore multi-touch, and only start tracking when already at the top —
    // otherwise this would hijack ordinary scrolling anywhere on the page.
    if (refreshing || e.touches.length !== 1 || window.scrollY > 0) return;
    // A modal (settings, tile editor, pickers, lightbox, etc.) has its own
    // independent scroll region layered over the page — don't interfere.
    if (document.querySelector('.modal.open')) return;
    startY = e.touches[0].clientY;
    pulling = true;
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!pulling || refreshing) return;
    if (window.scrollY > 0) { pulling = false; setPull(0); return; }
    const deltaY = e.touches[0].clientY - startY;
    if (deltaY <= 0) { setPull(0); return; }
    e.preventDefault();
    setPull(Math.min(deltaY * RESISTANCE, MAX_PULL));
  }, { passive: false });

  document.addEventListener('touchend', async () => {
    if (!pulling || refreshing) return;
    pulling = false;
    if (currentPull < PULL_THRESHOLD) { setPull(0); return; }
    refreshing = true;
    indicator.classList.add('spinning');
    indicator.style.transform = 'translate(-50%, 20px)';
    // force=true bypasses each image tile's own refreshRate throttle — a
    // manual pull is explicit user intent for "get me the latest now",
    // not a background poll tick that should respect rate limits.
    try { await refreshAll(true); } catch {}
    // Briefly show a checkmark so a completed refresh is visibly distinct
    // from an in-progress one, even when nothing on screen actually changed.
    indicator.classList.remove('spinning', 'ready');
    indicator.classList.add('done');
    indicator.textContent = '✓';
    await new Promise(r => setTimeout(r, 500));
    indicator.classList.remove('done');
    indicator.textContent = '↻';
    setPull(0);
    refreshing = false;
  });
}

initPullToRefresh();
boot();
})();