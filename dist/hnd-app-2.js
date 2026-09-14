  if (confirmResolve) { confirmResolve(false); confirmResolve = null; }
});

// ── Lightbox ──────────────────────────────────────────────────────────────────

// Tracks which device (if any) is behind the currently-open lightbox, so a
// pull-to-refresh can re-fetch a fresh frame into it. The lightbox's <img>
// is otherwise a one-time snapshot set at open time — unlike the grid tile
// it was opened from, nothing else in the app ever touches it again.
let lightboxDeviceId = null;

function bustImageUrl(url) {
  return url + (url.includes('?') ? '&' : '?') + '_t=' + Date.now();
}

function openLightbox(url, label, deviceId) {
  const modal = document.getElementById('lightbox-modal');
  const img   = document.getElementById('lightbox-img');
  const lbl   = document.getElementById('lightbox-label');
  if (!modal || !img) return;
  lightboxDeviceId = deviceId || null;
  img.src = url;
  if (lbl) lbl.textContent = label || '';
  modal.classList.add('open');
}

// Called on a forced refresh (pull-to-refresh) — re-derives the freshest
// known URL for the open lightbox's device and cache-busts it, since the
// lightbox has no polling/render cycle of its own.
function refreshLightboxImage() {
  const modal = document.getElementById('lightbox-modal');
  if (!modal || !modal.classList.contains('open') || !lightboxDeviceId) return;
  const d = findDevice(lightboxDeviceId);
  const url = d ? getImageUrl(d) : '';
  if (!url) return;
  document.getElementById('lightbox-img').src = bustImageUrl(url);
}

document.getElementById('lightbox-modal').addEventListener('click', e => {
  if (e.target.id !== 'lightbox-close' && e.target.id !== 'lightbox-modal' && e.target.id !== 'lightbox-img') return;
  document.getElementById('lightbox-modal').classList.remove('open');
});
document.getElementById('lightbox-close').addEventListener('click', () => {
  document.getElementById('lightbox-modal').classList.remove('open');
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.getElementById('lightbox-modal').classList.remove('open');
});

// ── Picker (mode / HSM) ───────────────────────────────────────────────────────

const pickerModal = document.getElementById('picker-modal');
function showPicker(title, options, currentValue, onSelect) {
  document.getElementById('picker-title').textContent = title;
  const container = document.getElementById('picker-options');
  container.innerHTML = '';
  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'btn' + (opt.value === currentValue ? '' : ' secondary');
    btn.textContent = opt.label;
    btn.style.cssText = 'justify-content:flex-start;padding:12px 16px;font-size:15px;';
    btn.addEventListener('click', async () => {
      pickerModal.classList.remove('open');
      try { await onSelect(opt.value); setTimeout(refreshAll, 400); }
      catch (e) { alert('Action failed: ' + (e.message || e)); }
    });
    container.appendChild(btn);
  });
  pickerModal.classList.add('open');
}
document.getElementById('picker-cancel').addEventListener('click', () => {
  pickerModal.classList.remove('open');
});
function showModePicker() {
  if (!hubModes.length) { alert('No modes loaded — test the hub connection first.'); return; }
  const cur = window.__currentMode;
  showPicker('Set Hubitat Mode',
    hubModes.map(m => ({ value: m.name, label: m.name + (m.name === cur ? '  ✓' : '') })),
    cur, name => setMode(name));
}
async function setMode(name) {
  const m = hubModes.find(x => x.name === name);
  if (m) await api(`/modes/${m.id}`);
}
function showHsmPicker() {
  const cur = (window.__hsmState || '').toLowerCase();
  const options = [
    { value:'armAway',      label:'Arm — Away'   + (cur.includes('away')  ? '  ✓' : '') },
    { value:'armHome',      label:'Arm — Home'   + (cur.includes('home') && !cur.includes('night') ? '  ✓' : '') },
    { value:'armNight',     label:'Arm — Night'  + (cur.includes('night') ? '  ✓' : '') },
    { value:'disarm',       label:'Disarm'       + (cur === 'disarmed' || cur === '' ? '  ✓' : '') },
    { value:'armRules',     label:'Arm Rules Only' },
    { value:'disarmRules',  label:'Disarm Rules Only' },
    { value:'cancelAlerts', label:'Cancel Alerts' },
  ];
  showPicker('Set HSM State', options, null, async cmd => {
    // api() surfaces the response body on failure — a raw fetch here threw a
    // bare "HTTP 400" with no way to see the actual hub/Maker API error.
    await api(`/hsm/${cmd}`);
  });
}

async function showValveTimerPicker(deviceId, label, isCurrentlyOpen, openCmd, closeCmd) {
  const modal = document.getElementById('valve-timer-modal');
  if (!modal) {
    console.error('Valve timer modal not found');
    return;
  }
  const openCommand  = openCmd  || 'open';
  const closeCommand = closeCmd || 'close';
  document.getElementById('valve-title').textContent = `${label || 'Valve'} - How long?`;
  modal.classList.add('open');
  console.log('Valve modal opened:', modal.classList);

  const durations = [
    { btn: 'valve-open-5', minutes: 5 },
    { btn: 'valve-open-30', minutes: 30 },
    { btn: 'valve-open-60', minutes: 60 },
    { btn: 'valve-open-90', minutes: 90 },
  ];

  // Set up timer buttons
  durations.forEach(({ btn, minutes }) => {
    const el = document.getElementById(btn);
    if (el) {
      el.onclick = async () => {
        modal.classList.remove('open');
        try {
          // /devices/{id}/{openCommand}/{minutes} — the duration is REQUIRED here, not a
          // nicety: an open with no duration falls back to the device's own (shorter)
          // auto-off preference instead of running the requested time. Silently dropping
          // the duration on failure would silently shorten the run, so on error we
          // surface it instead of retrying without a duration.
          //
          // openCommand is configurable per-tile because Maker API cannot reliably
          // dispatch a *timed* open on drivers that declare `command 'open', ['number']`
          // alongside `capability 'Valve'` (which already defines a no-argument open) —
          // two commands share the name, and the hub answers with a generic
          // "An unexpected error occurred." even though the same command works from the
          // Hubitat device page. Point the tile at a distinctly-named driver command to
          // avoid the collision.
          await sendCommand(deviceId, openCommand, String(minutes));
        } catch (e) {
          console.error('Timed valve open failed:', e);
          alert(`Failed to open ${label || 'valve'} for ${minutes} min via "${openCommand}": ${e.message || e}\n\nThe valve was NOT opened — retry, or open it directly in the Hubitat app.\n\nIf this is an "unexpected error", the driver may not accept a timed "${openCommand}" through Maker API. Set a different Open command on this tile in Edit → tile settings.`);
          return;
        }
        setTimeout(refreshAll, 400);
      };
    }
  });

  // Close valve button
  const closeBtn = document.getElementById('valve-close');
  if (closeBtn) {
    closeBtn.onclick = async () => {
      modal.classList.remove('open');
      await sendCommand(deviceId, closeCommand);
      setTimeout(refreshAll, 400);
    };
  }

  // Cancel button - just close the modal
  const cancelBtn = document.getElementById('valve-cancel');
  if (cancelBtn) {
    cancelBtn.onclick = () => {
      modal.classList.remove('open');
    };
  }
}

async function showShadePositionPicker(deviceId, label, currentPos) {
  const modal = document.getElementById('shade-position-modal');
  if (!modal) {
    console.error('Shade position modal not found');
    return;
  }
  document.getElementById('shade-title').textContent = `${label || 'Shade'} Position`;
  modal.classList.add('open');
  console.log('Shade modal opened:', modal.classList);

  const positions = [
    { btn: 'shade-open', cmd: 'open', label: 'Open' },
    { btn: 'shade-75', cmd: 'setPosition', value: 75 },
    { btn: 'shade-50', cmd: 'setPosition', value: 50 },
    { btn: 'shade-25', cmd: 'setPosition', value: 25 },
    { btn: 'shade-close', cmd: 'close', label: 'Close' },
  ];

  positions.forEach(({ btn, cmd, value, label: btnLabel }) => {
    const el = document.getElementById(btn);
    if (el) {
      el.onclick = async () => {
        modal.classList.remove('open');
        // sendCommand takes (deviceId, command, secondary) — don't combine them
        if (value !== undefined) {
          await sendCommand(deviceId, cmd, String(value));
        } else {
          await sendCommand(deviceId, cmd);
        }
        setTimeout(refreshAll, 400);
      };
    }
  });

  // Cancel button - just close the modal
  const cancelBtn = document.getElementById('shade-cancel');
  if (cancelBtn) {
    cancelBtn.onclick = () => {
      modal.classList.remove('open');
    };
  }
}

// ── Thermostat control ───────────────────────────────────────────────────────

const THERMOSTAT_MODE_OPTIONS = [
  { value: 'off',            label: 'Off' },
  { value: 'heat',           label: 'Heat' },
  { value: 'cool',           label: 'Cool' },
  { value: 'auto',           label: 'Auto' },
  { value: 'emergency heat', label: 'Emerg. Heat' },
];
const THERMOSTAT_FAN_MODE_OPTIONS = [
  { value: 'auto',      label: 'Fan: Auto' },
  { value: 'on',        label: 'Fan: On' },
  { value: 'circulate', label: 'Fan: Circulate' },
];

function showThermostatPicker(deviceId, label) {
  const modal = document.getElementById('thermostat-modal');
  if (!modal) { console.error('Thermostat modal not found'); return; }
  document.getElementById('thermostat-title').textContent = label || 'Thermostat';
  renderThermostatBody(deviceId);
  modal.classList.add('open');
}

// Re-fetches devices, re-renders the modal body in place (stays open) so
// setpoint/mode/fan taps give immediate feedback without closing the modal.
async function thermostatSendCommand(deviceId, command, value) {
  try {
    await sendCommand(deviceId, command, value !== undefined ? String(value) : undefined);
  } catch (e) {
    alert('Command failed: ' + (e.message || e));
  }
  await refreshAll();
  renderThermostatBody(deviceId);
}

function renderThermostatBody(deviceId) {
  const d = findDevice(deviceId);
  const body = document.getElementById('thermostat-body');
  if (!body) return;
  if (!d) { body.innerHTML = '<div class="thermo-sub">Device not found</div>'; return; }

  const mode     = (getAttr(d, 'thermostatMode') || '').toLowerCase();
  const opState  = getAttr(d, 'thermostatOperatingState') || '';
  const temp     = getAttr(d, 'temperature');
  const humidity = getAttr(d, 'humidity');
  const heatSp   = getAttr(d, 'heatingSetpoint');
  const coolSp   = getAttr(d, 'coolingSetpoint');
  const fanMode  = (getAttr(d, 'thermostatFanMode') || '').toLowerCase();

  const supportedModes    = parseSupportedList(d, 'supportedThermostatModes') || THERMOSTAT_MODE_OPTIONS.map(o => o.value);
  const supportedFanModes = parseSupportedList(d, 'supportedThermostatFanModes');
  const hasHeat = getAttr(d, 'heatingSetpoint') !== undefined;
  const hasCool = getAttr(d, 'coolingSetpoint') !== undefined;

  let html = `<div class="thermo-temp">${iconSvg(thermostatModeIcon(mode, opState))}<span>${temp != null ? temp + '°' : '—'}</span></div>`;
  html += `<div class="thermo-sub">${escapeHtml(opState || mode || '—')}${humidity != null ? ` · ${humidity}% humidity` : ''}</div>`;

  if (hasHeat) {
    html += `<div class="thermo-setpoint-row">
      <span class="thermo-setpoint-label">Heat to</span>
      <button class="thermo-step" data-sp="heat" data-dir="-1">−</button>
      <span class="thermo-setpoint-value">${heatSp != null ? heatSp + '°' : '—'}</span>
      <button class="thermo-step" data-sp="heat" data-dir="1">+</button>
    </div>`;
  }
  if (hasCool) {
    html += `<div class="thermo-setpoint-row">
      <span class="thermo-setpoint-label">Cool to</span>
      <button class="thermo-step" data-sp="cool" data-dir="-1">−</button>
      <span class="thermo-setpoint-value">${coolSp != null ? coolSp + '°' : '—'}</span>
      <button class="thermo-step" data-sp="cool" data-dir="1">+</button>
    </div>`;
  }

  html += `<div class="thermo-modes">${THERMOSTAT_MODE_OPTIONS
    .filter(o => supportedModes.includes(o.value))
    .map(o => `<button class="btn sm thermo-mode-btn${o.value === mode ? '' : ' secondary'}" data-mode="${o.value}">${o.label}</button>`)
    .join('')}</div>`;

  if (supportedFanModes && supportedFanModes.length) {
    html += `<div class="thermo-fan">${THERMOSTAT_FAN_MODE_OPTIONS
      .filter(o => supportedFanModes.includes(o.value))
      .map(o => `<button class="btn sm${o.value === fanMode ? '' : ' secondary'}" data-fan="${o.value}">${o.label}</button>`)
      .join('')}</div>`;
  }

  body.innerHTML = html;

  body.querySelectorAll('[data-sp]').forEach(btn => {
    btn.addEventListener('click', () => {
      const spKind = btn.dataset.sp;
      const dir = parseInt(btn.dataset.dir, 10);
      const cur = spKind === 'heat' ? heatSp : coolSp;
      const next = (parseFloat(cur) || 0) + dir;
      thermostatSendCommand(deviceId, spKind === 'heat' ? 'setHeatingSetpoint' : 'setCoolingSetpoint', next);
    });
  });
  body.querySelectorAll('[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => thermostatSendCommand(deviceId, 'setThermostatMode', btn.dataset.mode));
  });
  body.querySelectorAll('[data-fan]').forEach(btn => {
    btn.addEventListener('click', () => thermostatSendCommand(deviceId, 'setThermostatFanMode', btn.dataset.fan));
  });
}

document.getElementById('thermostat-cancel').addEventListener('click', () => {
  document.getElementById('thermostat-modal').classList.remove('open');
});

async function showBulbLevelPicker(deviceId, label) {
  const modal = document.getElementById('bulb-level-modal');
  if (!modal) return;
  document.getElementById('bulb-title').textContent = `${label || 'Light'} Level`;
  modal.classList.add('open');

  const levels = [
    { btn: 'bulb-100', level: 100 },
    { btn: 'bulb-75',  level: 75 },
    { btn: 'bulb-50',  level: 50 },
    { btn: 'bulb-25',  level: 25 },
  ];

  levels.forEach(({ btn, level }) => {
    const el = document.getElementById(btn);
    if (el) {
      el.onclick = async () => {
        modal.classList.remove('open');
        await sendCommand(deviceId, 'setLevel', String(level));
        setTimeout(refreshAll, 400);
      };
    }
  });

  const offBtn = document.getElementById('bulb-off');
  if (offBtn) {
    offBtn.onclick = async () => {
      modal.classList.remove('open');
      await sendCommand(deviceId, 'off');
      setTimeout(refreshAll, 400);
    };
  }

  const cancelBtn = document.getElementById('bulb-cancel');
  if (cancelBtn) {
    cancelBtn.onclick = () => modal.classList.remove('open');
  }
}

function showDynKindPicker(deviceId, label, groupKey) {
  const currentKind = dynamicOverrides[deviceId] || '__auto__';
  const options = [
    { value: '__auto__', label: 'Auto-detect (reset to default)' },
    { value: 'switch',   label: 'Switch (on/off)' },
    { value: 'bulb',     label: 'Light / Dimmer' },
    { value: 'lock',     label: 'Lock' },
    { value: 'contact',  label: 'Contact Sensor' },
    { value: 'presence', label: 'Presence' },
    { value: 'shade',    label: 'Window Shade' },
    { value: 'valve',    label: 'Valve' },
    { value: 'water',    label: 'Water Sensor' },
    { value: 'thermostat', label: 'Thermostat' },
    { value: 'momentary', label: 'Momentary Button' },
  ].map(o => ({ ...o, label: o.label + (o.value === currentKind ? '  ✓' : '') }));

  showPicker(`Reclassify: ${label}`, options, currentKind, async val => {
    if (val === '__auto__') {
      delete dynamicOverrides[deviceId];
    } else {
      dynamicOverrides[deviceId] = val;
    }
    await saveDynamicConfig();
    // Re-render the current group (device may have left it)
    renderDynamicDashboard(groupKey);
  });
}

// ── Edit mode ─────────────────────────────────────────────────────────────────

document.getElementById('edit-mode-btn').addEventListener('click', e => {
  editMode = !editMode;
  document.body.classList.toggle('edit-mode', editMode);
  e.currentTarget.classList.toggle('on', editMode);
  // Show/hide add-device button in custom view
  const addBtn = document.getElementById('custom-add-tile');
  if (addBtn) addBtn.style.display = editMode && currentView.startsWith('custom/') ? '' : 'none';
  // Re-evaluate section visibility (hidden sections show in edit mode)
  updateSectionVisibility();
});

document.getElementById('theme-toggle').addEventListener('click', () => {
  // Always flips to the opposite of what's currently on screen, so every
  // click is visible — cycling through 'auto' here would sometimes be a
  // no-op click (e.g. going dark -> auto at night looks identical, so
  // "switching back to light" silently took two clicks). 'auto' remains
  // available as an explicit choice in Settings.
  cfg.theme = resolveTheme() === 'light' ? 'dark' : 'light';
  applyTheme();
  saveConfigCache();
  const sel = document.getElementById('cfg-theme');
  if (sel) sel.value = cfg.theme;
});

// Hide a tile (soft-delete): sets kind='hidden' so it shows as ghost in edit mode
// and disappears in normal mode. Dense grid-auto-flow fills the gap.
function onRemoveTile(e) {
  e.stopPropagation();
  e.preventDefault();
  const slotId = e.currentTarget.dataset.slot;
  if (!slotId) return;

  const s = cfg.slots[slotId] || {};

  // If this is a presence tile, preserve it in statusBarPresenceDevices
  // so the status bar pill still shows even though the tile is hidden
  if (s.kind === 'presence' && s.deviceId) {
    const d = findDevice(s.deviceId);
    statusBarPresenceDevices[s.deviceId] = {
      label: s.label || (d && (d.label || d.name)) || '',
      kind: 'presence'
    };
  }

  s.kind = 'hidden';
  cfg.slots[slotId] = s;
  saveConfigCache();
  markDirty();
  renderTile(slotId);   // re-render in place (hides or shows ghost)
  updateStatusBar();    // presence chips may change
}

// Add a new empty tile to a section
function onAddTile(sectionId) {
  const id = generateSlotId();
  cfg.slots[id] = { label: 'New Tile', kind: 'hidden' };
  const layout = cfg.layout || JSON.parse(JSON.stringify(LAYOUT_DEFAULTS));
  if (!layout[sectionId]) layout[sectionId] = [];
  layout[sectionId].push(id);
  cfg.layout = layout;
  saveConfigCache();
  markDirty();
  buildLayout();
  openTileEditor(id);
}

// ── Drag-to-reorder (edit mode) ───────────────────────────────────────────────

function bindDragEvents(el, sectionId) {
  el.setAttribute('draggable', 'true');

  el.addEventListener('dragstart', e => {
    if (!editMode) { e.preventDefault(); return; }
    dragSlot    = el.dataset.slot;
    dragSection = sectionId;
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => el.classList.add('dragging'), 0);
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    document.querySelectorAll('.drag-over').forEach(t => t.classList.remove('drag-over'));
    dragSlot = null; dragSection = null;
  });
  el.addEventListener('dragover', e => {
    if (!editMode || !dragSlot) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('drag-over');
  });
  el.addEventListener('dragleave', () => {
    el.classList.remove('drag-over');
  });
  el.addEventListener('drop', e => {
    e.preventDefault();
    el.classList.remove('drag-over');
    const targetSlot = el.dataset.slot;
    if (!dragSlot || dragSlot === targetSlot) return;

    const layout = cfg.layout || JSON.parse(JSON.stringify(LAYOUT_DEFAULTS));
    // Find which section each belongs to
    let fromSection = null, toSection = null;
    for (const [sec, ids] of Object.entries(layout)) {
      if (ids.includes(dragSlot))  fromSection = sec;
      if (ids.includes(targetSlot)) toSection  = sec;
    }
    if (!fromSection || !toSection) return;

    // Remove from source
    const fromArr = layout[fromSection];
    fromArr.splice(fromArr.indexOf(dragSlot), 1);

    // Insert before target in destination
    const toArr = layout[toSection];
    const toIdx = toArr.indexOf(targetSlot);
    if (toIdx === -1) toArr.push(dragSlot);
    else toArr.splice(toIdx, 0, dragSlot);

    cfg.layout = layout;
    saveConfigCache();
    markDirty();
    buildLayout();
    renderAll();
    dragSlot = null; dragSection = null;
  });
}

// ── Corner resize handle ─────────────────────────────────────────────────────
// Pointer-capture drag on the bottom-right corner resizes colSpan/rowSpan and
// saves to cfg. Works for both .tile and .image-tile elements in grid sections.

function bindResizeHandle(tileEl, slotId) {
  const handle = tileEl.querySelector('.resize-handle');
  if (!handle) return;

  handle.addEventListener('pointerdown', e => {
    if (!editMode) return;
    e.stopPropagation(); e.preventDefault();
    handle.setPointerCapture(e.pointerId);

    const sectionEl = tileEl.parentElement;
    const userCols = cfg.gridCols || 3;
    const rowH = parseFloat(getComputedStyle(document.documentElement)
      .getPropertyValue('--row-h')) || 80;
    const gap = parseFloat(getComputedStyle(document.documentElement)
      .getPropertyValue('--gap')) || 6;

    // Width of 1 user-column (= 2 internal CSS units + gap between them)
    const cssColCount = userCols * 2;
    const cssUnitW = sectionEl
      ? (sectionEl.offsetWidth - gap * (cssColCount - 1)) / cssColCount
      : 50;
    const userColW = cssUnitW * 2 + gap; // 2 CSS units + 1 gap

    const startX = e.clientX, startY = e.clientY;
    const startW = tileEl.offsetWidth, startH = tileEl.offsetHeight;

    // Valid user-column snapping values (0.5, 1, 2, 3 — capped at userCols)
    const validCols = [0.5, 1, 2, 3].filter(c => c <= userCols);

    let snapCol = cfg.slots[slotId]?.colSpan ?? 1;
    let snapRow = cfg.slots[slotId]?.rowSpan ?? 1;

    function onMove(ev) {
      const dw = ev.clientX - startX;
      const dh = ev.clientY - startY;
      const rawUserCols = (startW + dw) / userColW;
      snapCol = validCols.reduce((p, c) => Math.abs(c - rawUserCols) < Math.abs(p - rawUserCols) ? c : p);
      snapRow = Math.max(1, Math.min(4, Math.round((startH + dh + gap / 2) / (rowH + gap))));
      // Apply inline preview using CSS span units
      const cssSpan = colToSpan(snapCol);
      tileEl.style.gridColumn = `span ${cssSpan}`;
      tileEl.style.gridRow    = snapRow > 1 ? `span ${snapRow}` : '';
    }

    function onUp() {
      handle.removeEventListener('pointermove', onMove);
      tileEl.style.gridColumn = '';
      tileEl.style.gridRow = '';
      const s = cfg.slots[slotId] || {};
      if (snapCol !== 1) s.colSpan = snapCol; else delete s.colSpan;
      if (snapRow > 1)   s.rowSpan = snapRow; else delete s.rowSpan;
      cfg.slots[slotId] = s;
      saveConfigCache();
      markDirty();
      buildLayout(); renderAll();
    }

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup',     onUp, { once: true });
    handle.addEventListener('pointercancel', onUp, { once: true });
  });
}

// ── Dynamic dashboards ────────────────────────────────────────────────────────

function renderDynamicDashboard(key) {
  const group = DYNAMIC_GROUPS.find(g => g.key === key);
  const grid  = document.getElementById('dynamic-grid');
  if (!group || !grid) return;

  document.getElementById('dash-title').textContent = group.label;

  let matched = devices.filter(group.match);
  if (!matched.length) {
    grid.innerHTML = '<div style="color:var(--text-dim);padding:20px;font-size:13px">No devices found for this group.</div>';
    return;
  }

  // Apply stored drag order if present; otherwise sort battery by level ascending
  const storedOrder = dynamicOrder[key];
  if (storedOrder && storedOrder.length) {
    matched = [...matched].sort((a, b) => {
      const ia = storedOrder.indexOf(String(a.id));
      const ib = storedOrder.indexOf(String(b.id));
      if (ia === -1 && ib === -1) return 0;
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
  } else if (key === 'battery') {
    // Battery page: sort ascending by battery level (lowest first)
    matched = [...matched].sort((a, b) => {
      const ba = getAttr(a, 'battery') ?? 999;
      const bb = getAttr(b, 'battery') ?? 999;
      return ba - bb;
    });
  }

  // Record device ID order for drag ops
  const deviceIdOrder = matched.map(d => String(d.id));

  grid.innerHTML = matched.map(d => {
    const hidden   = !!dynamicHidden[String(d.id)];
    const kind     = dynKindForDevice(d);
    const battery  = getAttr(d, 'battery');
    const valTxt   = dynValueForDevice(d, kind);
    const isActive = dynIsActive(d, kind);

    let cls = 'tile' + (hidden ? ' dyn-hidden' : '');
    if (!hidden) {
      if (key === 'battery' && battery != null) {
        // Color-code by battery level: red <20%, amber 20-50%, green >50%
        const pct = Number(battery);
        if (pct < 20)      cls += ' batt-red';
        else if (pct < 50) cls += ' batt-amber';
        else               cls += ' batt-green';
      } else if (kind === 'garage') {
        cls += isActive ? ' alert' : ' active'; // open=red, closed=green
      } else if (isActive) {
        cls += ' active';
      }
    }

    const overrideLabel = dynamicOverrides[String(d.id)] ? ` (${dynamicOverrides[String(d.id)]})` : '';
    return `<div class="${cls}" data-dyn-id="${d.id}" data-dyn-key="${key}">
      ${battery != null ? `<span class="tile-battery">${battery}%</span>` : ''}
      <span class="tile-edit" title="Reclassify">⋮</span>
      <span class="tile-label">${escapeHtml(d.label || d.name)}${escapeHtml(overrideLabel)}</span>
      <span class="tile-value">${valTxt}</span>
      <button class="tile-hide-toggle" data-dyn-id="${d.id}">${hidden ? 'Show' : 'Hide'}</button>
      <span class="tile-drag-handle" title="Drag to reorder">⠿</span>
    </div>`;
  }).join('');

  // Bind click and drag handlers
  grid.querySelectorAll('[data-dyn-id]').forEach(el => {
    if (el.classList.contains('tile-hide-toggle')) {
      el.addEventListener('click', e => {
        e.stopPropagation();
        const id = e.currentTarget.dataset.dynId;
        dynamicHidden[id] = !dynamicHidden[id];
        if (!dynamicHidden[id]) delete dynamicHidden[id];
        saveDynamicConfig();
        renderDynamicDashboard(key);
      });
    } else {
      el.addEventListener('click', () => onDynTileClick(el.dataset.dynId, key));
    }
  });

  bindDynDragEvents(grid, key, deviceIdOrder);
}

function dynKindForDevice(d) {
  const override = dynamicOverrides[String(d.id)];
  if (override) return override;
  if ((hasCapability(d,'SwitchLevel') || getAttr(d,'level') !== undefined) &&
      (hasCapability(d,'Switch') || getAttr(d,'switch') !== undefined)) return 'bulb';
  if (hasCapability(d,'Switch') || getAttr(d,'switch') !== undefined) return 'switch';
  if (hasCapability(d,'Lock')   || getAttr(d,'lock')   !== undefined) return 'lock';
  if (hasCapability(d,'GarageDoorControl') || getAttr(d,'door') !== undefined) return 'garage';
  if (hasCapability(d,'ContactSensor') || getAttr(d,'contact') !== undefined) return 'contact';
  if (hasCapability(d,'PresenceSensor') || getAttr(d,'presence') !== undefined) return 'presence';
  if (hasCapability(d,'WindowShade') || getAttr(d,'windowShade') !== undefined) return 'shade';
  if (hasCapability(d,'Valve') || getAttr(d,'valve') !== undefined) return 'valve';
  if (hasCapability(d,'WaterSensor') || getAttr(d,'water') !== undefined) return 'water';
  if (hasCapability(d,'Thermostat') || getAttr(d,'thermostatMode') !== undefined) return 'thermostat';
  if (hasCapability(d,'Momentary')) return 'momentary';
  return 'text';
}

function dynValueForDevice(d, kind, tile = {}) {
  switch (kind) {
    case 'bulb': {
      const on = getAttr(d,'switch') === 'on';
      const level = getAttr(d,'level');
      const levelStr = on && level != null ? `${level}%` : (on ? 'On' : 'Off');
      return `${iconSvg(tile.icon || 'lightbulb')}<span>${levelStr}</span>`;
    }
    case 'switch': {
      const on = getAttr(d,'switch') === 'on';
      const swIcon = (on ? tile.iconOn : tile.iconOff) || tile.icon || (on ? 'toggle-switch' : 'toggle-switch-off');
      return `${iconSvg(swIcon)}<span>${on ? 'On' : 'Off'}</span>`;
    }
    case 'lock': {
      const lk = getAttr(d,'lock');
      const locked = lk === 'locked';
      const text = locked ? 'Locked' : 'Unlocked';
      const lockIcon = (locked ? tile.iconOn : tile.iconOff) || tile.icon || (locked ? 'lock' : 'lock-open');
      return `${iconSvg(lockIcon)}<span>${text}</span>`;
    }
    case 'garage': {
      const door = getAttr(d,'door') || getAttr(d,'contact') || '';
      const isOpen = door === 'open' || door === 'opening';
      const garageIcon = (isOpen ? tile.iconOn : tile.iconOff) || tile.icon || (isOpen ? 'garage-open' : 'garage');
      return `${iconSvg(garageIcon)}<span>${door}</span>`;
    }
    case 'contact':  return getAttr(d,'contact')  || '';
    case 'presence': {
      const presenceVal = getAttr(d, 'presence');
      const isSleep = getAttr(d, 'sleeping') === 'sleeping';
      let icon, text;
      if (presenceVal === 'present' && isSleep) {
        icon = iconSvg(tile.icon || 'sleep');
        text = 'Sleep';
      } else if (presenceVal === 'present') {
        icon = iconSvg(tile.icon || 'home-account');
        text = 'Home';
      } else {
        icon = iconSvg(tile.icon || 'door-open');
        text = 'Away';
      }
      return `${icon}<span>${text}</span>`;
    }
    case 'shade': {
      const shadePos = getAttr(d, 'windowShade');
      const isClosed = shadePos === 'closed';
      const shadeIcon = (!isClosed ? tile.iconOn : tile.iconOff) || tile.icon || (isClosed ? 'window-closed' : 'window-shutter-open');
      return `${iconSvg(shadeIcon)}<span>${shadePos || '—'}</span>`;
    }
    case 'water': {
      const w = getAttr(d, 'water');
      return `${iconSvg(tile.icon || 'water-percent')}<span>${w || '—'}</span>`;
    }
    case 'valve': {
      const v = getAttr(d, 'valve');
      const isOpen = v === 'open';
      const valveIcon = (isOpen ? tile.iconOn : tile.iconOff) || tile.icon || (isOpen ? 'valve' : 'valve-closed');
      return `${iconSvg(valveIcon)}<span>${v || '—'}</span>`;
    }
    case 'thermostat': {
      const temp = getAttr(d, 'temperature');
      const mode = getAttr(d, 'thermostatMode');
      const opState = getAttr(d, 'thermostatOperatingState');
      const thermoIcon = tile.icon || thermostatModeIcon(mode, opState);
      return `${iconSvg(thermoIcon)}<span>${temp != null ? temp + '°' : '—'}</span>`;
    }
    case 'momentary':
      // Stateless — no attribute to reflect.
      return `${iconSvg(tile.icon || 'push-button')}<span>${escapeHtml(tile.command || 'Press')}</span>`;
    default: {
      const batt = getAttr(d,'battery');
      return batt != null ? `${batt}%` : '';
    }
  }
}

function dynIsActive(d, kind) {
  switch (kind) {
    case 'bulb':     return getAttr(d,'switch')   === 'on';
    case 'switch':   return getAttr(d,'switch')   === 'on';
    case 'lock':     return getAttr(d,'lock')     === 'locked';
    case 'garage':   return getAttr(d,'door')     === 'open' || getAttr(d,'door') === 'opening';
    case 'contact':  return getAttr(d,'contact')  === 'open';
    case 'presence': return getAttr(d,'presence') === 'present';
    case 'water':    return getAttr(d,'water')    === 'wet';
    case 'valve':    return getAttr(d,'valve')    === 'open';
    case 'shade':    return getAttr(d,'windowShade') === 'open';
    case 'thermostat': {
      const opState = (getAttr(d,'thermostatOperatingState') || '').toLowerCase();
      return opState === 'heating' || opState === 'cooling';
    }
    default: return false;
  }
}

async function onDynTileClick(deviceId, groupKey) {
  const d = findDevice(deviceId);
  if (!d) return;
  if (editMode) {
    showDynKindPicker(deviceId, d.label || d.name, groupKey);
    return;
  }
  const kind = dynKindForDevice(d);
  console.log('Dynamic tile clicked:', { deviceId, name: d.label || d.name, kind, hasValve: getAttr(d, 'valve') !== undefined });
  try {
    if (kind === 'bulb') {
      showBulbLevelPicker(deviceId, d.label || d.name);
      return;
    } else if (kind === 'switch') {
      const on = getAttr(d,'switch') === 'on';
      applyDeviceAttrUpdate(deviceId, 'switch', on ? 'off' : 'on');
      await sendCommand(deviceId, on ? 'off' : 'on');
    } else if (kind === 'lock') {
      const lk = getAttr(d,'lock');
      const lockAction = lk === 'locked' ? 'unlock' : 'lock';
      const ok = await showConfirm(`${lockAction === 'unlock' ? 'Unlock' : 'Lock'} ${d.label || d.name}?`);
      if (!ok) return;
      applyDeviceAttrUpdate(deviceId, 'lock', lockAction === 'lock' ? 'locked' : 'unlocked');
      await sendCommand(deviceId, lockAction);
    } else if (kind === 'garage') {
      const doorAttr = getAttr(d, 'door') !== undefined ? 'door' : 'contact';
      const isOpen = getAttr(d, doorAttr) === 'open' || getAttr(d, doorAttr) === 'opening';
      const ok = await showConfirm(`${isOpen ? 'Close' : 'Open'} ${d.label || d.name}?`);
      if (!ok) return;
      applyDeviceAttrUpdate(deviceId, doorAttr, isOpen ? 'closed' : 'open');
      await sendCommand(deviceId, isOpen ? 'close' : 'open');
    } else if (kind === 'shade') {
      const shadePos = getAttr(d, 'windowShade');
      showShadePositionPicker(deviceId, d.label || d.name, shadePos);
      return;
    } else if (kind === 'valve') {
      const v = getAttr(d, 'valve');
      const isOpen = v === 'open';
      // For dynamic dashboards, always show timer picker for valves
      showValveTimerPicker(deviceId, d.label || d.name, isOpen);
      return;
    } else if (kind === 'thermostat') {
      showThermostatPicker(deviceId, d.label || d.name);
      return;
    } else if (kind === 'momentary') {
      const tileEl = document.querySelector(`.tile[data-dyn-id="${deviceId}"]`);
      if (tileEl) flashPressed(tileEl); // only feedback available — there's no attribute to reflect
      await sendCommand(deviceId, 'push');
      return;
    }
    setTimeout(() => { refreshAll(); renderDynamicDashboard(groupKey); }, 400);
  } catch (err) {
    console.error('Dynamic tile command failed', err);
    setTimeout(() => { refreshAll(); renderDynamicDashboard(groupKey); }, 400);
  }
}

function bindDynDragEvents(grid, key, deviceIdOrder) {
  grid.querySelectorAll('.tile[data-dyn-id]').forEach(el => {
    el.setAttribute('draggable', 'true');

    el.addEventListener('dragstart', e => {
      if (!editMode) { e.preventDefault(); return; }
      dragDynId = el.dataset.dynId;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => el.classList.add('dragging'), 0);
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      grid.querySelectorAll('.drag-over').forEach(t => t.classList.remove('drag-over'));
      dragDynId = null;
    });
    el.addEventListener('dragover', e => {
      if (!editMode || !dragDynId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', e => {
      e.preventDefault();
      el.classList.remove('drag-over');
      const targetId = el.dataset.dynId;
      if (!dragDynId || dragDynId === targetId) return;

      // Build current order (use stored or rendered)
      const current = (dynamicOrder[key] && dynamicOrder[key].length)
        ? [...dynamicOrder[key]]
        : [...deviceIdOrder];

      // Ensure both IDs are in current (may have been added since last save)
      if (!current.includes(dragDynId))  current.push(dragDynId);
      if (!current.includes(targetId))   current.push(targetId);

      const fromIdx = current.indexOf(dragDynId);
      current.splice(fromIdx, 1);
      const toIdx = current.indexOf(targetId);
      if (toIdx === -1) current.push(dragDynId);
      else current.splice(toIdx, 0, dragDynId);

      dynamicOrder[key] = current;
      dragDynId = null;
      saveDynamicConfig();
      renderDynamicDashboard(key);
    });
  });
}

async function saveDynamicConfig() {
  try {
    await pushConfigToWorker({ dynamic: {
      hidden:    dynamicHidden,
      order:     Object.keys(dynamicOrder).length     ? dynamicOrder     : undefined,
      overrides: Object.keys(dynamicOverrides).length ? dynamicOverrides : undefined,
    }});
    saveConfigCache();
  } catch (e) { console.warn('Failed to save dynamic config', e); }
}

// ── Custom dashboards ─────────────────────────────────────────────────────────

function renderCustomDashboard(name, force) {
  const dash = customDashboards[name];
  const grid  = document.getElementById('custom-grid');
  if (!grid) return;

  document.getElementById('dash-title').textContent = dash ? (dash.title || name) : name;

  // Apply per-dashboard column count (or fall back to auto-fill)
  if (dash && dash.gridCols) {
    grid.style.gridTemplateColumns = `repeat(${dash.gridCols}, 1fr)`;
    grid.style.gridAutoRows = 'var(--row-h, 80px)';
  } else {
    grid.style.gridTemplateColumns = '';
    grid.style.gridAutoRows = '';
  }

  const addBtn = document.getElementById('custom-add-tile');
  if (addBtn) addBtn.style.display = editMode ? '' : 'none';

  if (!dash || !dash.tiles || !dash.tiles.length) {
    grid.innerHTML = '<div style="color:var(--text-dim);padding:20px;font-size:13px">No tiles yet — enter edit mode and click + Add Device.</div>';
    return;
  }

  grid.innerHTML = dash.tiles.map(tile => {
    const d      = findDevice(tile.deviceId);
    const kind   = tile.kind || dynKindForDevice(d || {});
    const colSpan = tile.colSpan || 1;
    const rowSpan = tile.rowSpan || 1;
    const colAttr = colSpan > 1 ? ` data-col="${colSpan}"` : '';
    const rowAttr = rowSpan > 1 ? ` data-row="${rowSpan}"` : '';

    // Image tiles get the same full-bleed structure as the main dashboard camera tiles
    if (kind === 'image') {
      const imgUrl = d ? getImageUrl(d) : (tile.url || '');
      const portrait = tile.imageOrientation === 'portrait' ? ' portrait' : '';

      // Rate-limit cache-busting so rebuilding the grid doesn't force a reload every poll.
      // Reuse the same _t timestamp (→ browser cache hit) until the device's own refreshRate
      // interval has elapsed. Default to 60 s when no rate is declared.
      let refreshMs = 60000;
      if (d) {
        const rateMin = getAttr(d, 'refreshRate');
        if (rateMin != null) {
          const parsed = parseFloat(rateMin);
          if (!isNaN(parsed) && parsed > 0) refreshMs = parsed * 1000; // seconds → ms
        } else {
          const rateSec = getAttr(d, 'refreshInterval') ?? getAttr(d, 'pollInterval');
          if (rateSec != null) {
            const parsed = parseFloat(rateSec);
            if (!isNaN(parsed) && parsed > 0) refreshMs = parsed * 1000;
          }
        }
      }
      const cacheKey = `custom/${name}/${tile.slotId}`;
      const now = Date.now();
      const last = imageLastRefreshed[cacheKey] || 0;
      if (force || (now - last) >= refreshMs) imageLastRefreshed[cacheKey] = now;
      const ts = imageLastRefreshed[cacheKey];
      const busted = imgUrl ? imgUrl + (imgUrl.includes('?') ? '&' : '?') + '_t=' + ts : '';
      const fit = tile.imageFit === 'contain' ? 'contain' : 'cover';
      return `<div class="image-tile${portrait}" data-custom-slot="${tile.slotId}" data-custom-name="${name}"${colAttr}${rowAttr}>
        <button class="tile-remove" data-custom-slot="${tile.slotId}" data-custom-name="${name}" title="Remove">×</button>
        ${busted ? `<img src="${escapeHtml(busted)}" alt="" style="object-fit:${fit}">` : '<span style="color:var(--text-dim);font-size:11px;padding:8px">No image URL</span>'}
        <span class="image-label">${escapeHtml(tile.label || (d && (d.label || d.name)) || tile.deviceId)}</span>
        <span class="image-edit" data-custom-edit="${tile.slotId}">⋮</span>
        <span class="tile-drag-handle" title="Drag to reorder">⠿</span>
        <div class="resize-handle" data-custom-resize="${tile.slotId}"></div>
      </div>`;
    }

    // Text tiles use a specific attribute — dynValueForDevice doesn't know about it
    let valTxt;
    let needsEscape = true;
    let isHtmlContent = false;
    if (kind === 'text' && tile.attribute && d) {
      const attrEntry = Array.isArray(d.attributes)
        ? d.attributes.find(a => a.name === tile.attribute) : null;
      const v = attrEntry ? attrEntry.currentValue
               : (d.attributes ? d.attributes[tile.attribute] : undefined);
      const rawUnit = (attrEntry && attrEntry.unit) ? attrEntry.unit : '';
      const unit = rawUnit ? (rawUnit.startsWith('°') ? rawUnit : ` ${rawUnit}`) : '';
      valTxt = v != null ? `${String(v)}${unit}` : `(${tile.attribute}?)`;
      if (tile.renderHtml && v != null) { valTxt = sanitizeHtml(valTxt); needsEscape = false; isHtmlContent = true; }
    } else if (kind === 'text' && !tile.attribute) {
      valTxt = d ? '(set attribute)' : '—';
    } else if (kind === 'dashboard-link') {
      // Link tiles have no device state — mirror the main dashboard's
      // rendering (info-styled, no value) instead of showing "—".
      valTxt = '';
    } else {
      valTxt = d ? dynValueForDevice(d, kind, tile) : '—';
      needsEscape = false; // dynValueForDevice returns HTML with SVG
    }

    const active = d ? dynIsActive(d, kind) : false;
    const stateClass = kind === 'dashboard-link' ? 'info'
      : kind === 'garage' ? (active ? 'alert' : 'active') : (active ? 'active' : '');
    const cls = 'tile' + (stateClass ? ' ' + stateClass : '');
    const battery = d ? getAttr(d,'battery') : null;
    return `<div class="${cls}" data-custom-slot="${tile.slotId}" data-custom-name="${name}"${colAttr}${rowAttr}>
      <button class="tile-remove" data-custom-slot="${tile.slotId}" data-custom-name="${name}" title="Remove">×</button>
      <span class="tile-edit" data-custom-edit="${tile.slotId}">⋮</span>
      ${battery != null ? `<span class="tile-battery">${battery}%</span>` : ''}
      <span class="tile-label">${escapeHtml(tile.label || (d && (d.label || d.name)) || tile.deviceId || (kind === 'dashboard-link' ? 'Link' : ''))}</span>
      <span class="tile-value${isHtmlContent ? ' html-content' : ''}">${needsEscape ? escapeHtml(valTxt) : valTxt}</span>
      <span class="tile-drag-handle" title="Drag to reorder">⠿</span>
      <div class="resize-handle" data-custom-resize="${tile.slotId}"></div>
    </div>`;
  }).join('');

  // Bind events
  grid.querySelectorAll('[data-custom-slot]').forEach(el => {
    if (el.classList.contains('tile-remove')) {
      el.addEventListener('click', e => {
        e.stopPropagation();
        removeCustomTile(name, e.currentTarget.dataset.customSlot);
      });
    } else {
      el.addEventListener('click', e => onCustomTileClick(e, name, el.dataset.customSlot));
    }
  });

  // Drag-to-reorder and resize handles in edit mode
  bindCustomDragEvents(grid, name);
  grid.querySelectorAll('.tile[data-custom-slot], .image-tile[data-custom-slot]').forEach(el => {
    bindCustomResizeHandle(el, name, el.dataset.customSlot);
  });
}

function removeCustomTile(dashName, slotId) {
  const dash = customDashboards[dashName];
  if (!dash) return;
  dash.tiles = dash.tiles.filter(t => t.slotId !== slotId);
  saveCustomDashboards();
  renderCustomDashboard(dashName);
}

async function onCustomTileClick(e, dashName, slotId) {
  // Captured now, not read later — e.currentTarget is nulled out once an
  // async handler crosses its first await (see the same gotcha in onTileClick).
  const tileEl = e ? e.currentTarget : null;
  // ⋮ edit button always opens editor
  if (e && e.target.closest('[data-custom-edit]')) {
    e.preventDefault(); e.stopPropagation();
    openCustomTileEditor(dashName, slotId);
    return;
  }
  // In edit mode, click anywhere on the tile opens editor
  if (editMode) {
    openCustomTileEditor(dashName, slotId);
    return;
  }
  const dash = customDashboards[dashName];
  if (!dash) return;
  const tile = dash.tiles.find(t => t.slotId === slotId);
  if (!tile) return;
  const d    = findDevice(tile.deviceId);
  const kind = tile.kind || dynKindForDevice(d || {});
  try {
    if (kind === 'image') {
      const imgUrl = d ? getImageUrl(d) : (tile.url || '');
      if (imgUrl) openLightbox(imgUrl, tile.label || (d && (d.label || d.name)) || '', tile.deviceId || null);
      return;
    } else if (kind === 'dashboard-link') {
      // Same behavior as the main dashboard's dashboard-link case: "#..."
      // navigates in-app, anything else is a URL (new tab if configured).
      if (tile.url) {
        if (tile.url.startsWith('#')) {
          navigate(tile.url.replace(/^#\/?/, '') || 'main');
        } else if (tile.urlNewTab) {
          window.open(tile.url, '_blank');
        } else {
          window.location.href = tile.url;
        }
      } else {
        openCustomTileEditor(dashName, slotId);
      }
      return;
    } else if (kind === 'bulb') {
      showBulbLevelPicker(tile.deviceId, tile.label || (d && (d.label || d.name)) || tile.deviceId);
      return;
    } else if (kind === 'switch') {
      const on = getAttr(d,'switch') === 'on';
      if (tile.requireConfirm) {
        const ok = await showConfirm(`Turn ${tile.label || 'switch'} ${on ? 'off' : 'on'}?`);
        if (!ok) return;
      }
      applyDeviceAttrUpdate(tile.deviceId, 'switch', on ? 'off' : 'on');
      await sendCommand(tile.deviceId, on ? 'off' : 'on');
    } else if (kind === 'lock') {
      const lk = getAttr(d,'lock');
      const lockAction = lk === 'locked' ? 'unlock' : 'lock';
      if (tile.requireConfirm !== false) {
        const ok = await showConfirm(`${lockAction === 'unlock' ? 'Unlock' : 'Lock'} ${tile.label || 'door'}?`);
        if (!ok) return;
      }
      applyDeviceAttrUpdate(tile.deviceId, 'lock', lockAction === 'lock' ? 'locked' : 'unlocked');
      await sendCommand(tile.deviceId, lockAction);
    } else if (kind === 'garage') {
      const doorAttr = getAttr(d, 'door') !== undefined ? 'door' : 'contact';
      const isOpen = getAttr(d, doorAttr) === 'open' || getAttr(d, doorAttr) === 'opening';
      if (tile.requireConfirm !== false) {
        const ok = await showConfirm(`${isOpen ? 'Close' : 'Open'} ${tile.label || 'garage'}?`);
        if (!ok) return;
      }
      applyDeviceAttrUpdate(tile.deviceId, doorAttr, isOpen ? 'closed' : 'open');
      await sendCommand(tile.deviceId, isOpen ? 'close' : 'open');
    } else if (kind === 'shade') {
      const shadePos = getAttr(d, 'windowShade');
      showShadePositionPicker(tile.deviceId, tile.label || (d && (d.label || d.name)) || tile.deviceId, shadePos);
      return;
    } else if (kind === 'valve') {
      const v = getAttr(d, 'valve');
      const isOpen = v === 'open';
      // For custom dashboards, always show timer picker for valves
      showValveTimerPicker(tile.deviceId, tile.label || (d && (d.label || d.name)) || tile.deviceId, isOpen, tile.openCommand, tile.closeCommand);
      return;
    } else if (kind === 'thermostat') {
      showThermostatPicker(tile.deviceId, tile.label || (d && (d.label || d.name)) || tile.deviceId);
      return;
    } else if (kind === 'momentary') {
      if (tile.requireConfirm) {
        const ok = await showConfirm(`Send "${tile.command || 'push'}" to ${tile.label || 'button'}?`);
        if (!ok) return;
      }
      if (tileEl) flashPressed(tileEl); // only feedback available — there's no attribute to reflect
      await sendCommand(tile.deviceId, tile.command || 'push', tile.commandArg || undefined);
      return;
    }
    setTimeout(() => { refreshAll(); renderCustomDashboard(dashName); }, 400);
  } catch (err) {
    console.error('Custom tile command failed', err);
    setTimeout(() => { refreshAll(); renderCustomDashboard(dashName); }, 400);
  }
}

async function saveCustomDashboards() {
  try {
    await pushConfigToWorker({ custom: customDashboards });
    updateNavChips();
    refreshCustomDashList();
  } catch (e) { console.warn('Failed to save custom dashboards', e); }
}

function bindCustomDragEvents(grid, dashName) {
  let dragCustomSlotId = null;

  grid.querySelectorAll('.tile[data-custom-slot], .image-tile[data-custom-slot]').forEach(el => {
    el.setAttribute('draggable', 'true');

    el.addEventListener('dragstart', e => {
      if (!editMode) { e.preventDefault(); return; }
      dragCustomSlotId = el.dataset.customSlot;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => el.classList.add('dragging'), 0);
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      grid.querySelectorAll('.drag-over').forEach(t => t.classList.remove('drag-over'));
      dragCustomSlotId = null;
    });
    el.addEventListener('dragover', e => {
      if (!editMode || !dragCustomSlotId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', e => {
      e.preventDefault();
      el.classList.remove('drag-over');
      const targetSlotId = el.dataset.customSlot;
      if (!dragCustomSlotId || dragCustomSlotId === targetSlotId) return;

      const dash = customDashboards[dashName];
      if (!dash) return;
      const fromIdx = dash.tiles.findIndex(t => t.slotId === dragCustomSlotId);
      if (fromIdx === -1) return;
      const [moved] = dash.tiles.splice(fromIdx, 1);
      const toIdx = dash.tiles.findIndex(t => t.slotId === targetSlotId);
      if (toIdx === -1) dash.tiles.push(moved);
      else dash.tiles.splice(toIdx, 0, moved);

      dragCustomSlotId = null;
      saveCustomDashboards();
      renderCustomDashboard(dashName);
    });
  });
}

function bindCustomResizeHandle(el, dashName, slotId) {
  const handle = el.querySelector('.resize-handle');
  if (!handle) return;

  handle.addEventListener('pointerdown', e => {
    if (!editMode) return;
    e.stopPropagation(); e.preventDefault();
    handle.setPointerCapture(e.pointerId);

    const dash = customDashboards[dashName];
    const gridEl = document.getElementById('custom-grid');
    const gridCols = (dash && dash.gridCols) || 3;
    const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gap')) || 6;
    const rowH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h')) || 80;
    const colW = gridEl ? (gridEl.offsetWidth - gap * (gridCols - 1)) / gridCols : 130;
    const colWithGap = colW + gap;

    const startX = e.clientX, startY = e.clientY;
    const startW = el.offsetWidth, startH = el.offsetHeight;

    const tile = dash && dash.tiles.find(t => t.slotId === slotId);
    let snapCol = (tile && tile.colSpan) || 1;
    let snapRow = (tile && tile.rowSpan) || 1;
    const validCols = [1, 2, 3].filter(c => c <= gridCols);

    function onMove(ev) {
      const dw = ev.clientX - startX;
      const dh = ev.clientY - startY;
      const rawCols = (startW + dw) / colWithGap;
      snapCol = validCols.reduce((p, c) => Math.abs(c - rawCols) < Math.abs(p - rawCols) ? c : p);
      snapRow = Math.max(1, Math.min(4, Math.round((startH + dh + gap / 2) / (rowH + gap))));
      el.style.gridColumn = snapCol > 1 ? `span ${snapCol}` : '';
      el.style.gridRow    = snapRow > 1 ? `span ${snapRow}` : '';
    }

    function onUp() {
      handle.removeEventListener('pointermove', onMove);
      el.style.gridColumn = '';
      el.style.gridRow = '';
      if (tile) {
        if (snapCol > 1) tile.colSpan = snapCol; else delete tile.colSpan;
        if (snapRow > 1) tile.rowSpan = snapRow; else delete tile.rowSpan;
      }
      saveCustomDashboards();
      renderCustomDashboard(dashName);
    }

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup',     onUp, { once: true });
    handle.addEventListener('pointercancel', onUp, { once: true });
  });
}

function openCustomTileEditor(dashName, slotId) {
  const dash = customDashboards[dashName];
  if (!dash) return;
  const tile = dash.tiles.find(t => t.slotId === slotId);
  if (!tile) return;

  editingCustom = { dashName, slotId };
  editingSlot   = null; // prevent te-save from touching cfg.slots

  document.getElementById('tile-editor-title').textContent = `Edit: ${tile.label || slotId}`;
  document.getElementById('te-label').value               = tile.label || '';
  document.getElementById('te-kind').value                = tile.kind  || 'switch';
  document.getElementById('te-url').value                 = tile.url   || '';
  document.getElementById('te-url-newtab').checked        = !!tile.urlNewTab;
  document.getElementById('te-style').value               = tile.style || 'auto';
  document.getElementById('te-require-confirm').checked   = !!tile.requireConfirm;
  document.getElementById('te-valve-timer').checked       = !!tile.valveTimer;
  document.getElementById('te-render-html').checked       = !!tile.renderHtml;
  document.getElementById('te-image-orient').value        = tile.imageOrientation || 'landscape';
  document.getElementById('te-image-fit').value            = tile.imageFit || 'cover';
  document.getElementById('te-command-arg').value          = tile.commandArg || '';
  document.getElementById('te-col-span').value            = String(tile.colSpan ?? 1);
  document.getElementById('te-row-span').value            = String(tile.rowSpan || 1);
  document.getElementById('te-icon').value                = tile.icon    || '';
  document.getElementById('te-icon-on').value              = tile.iconOn  || '';
  document.getElementById('te-icon-off').value             = tile.iconOff || '';
  updateIconPreview('te-icon',     tile.icon);
  updateIconPreview('te-icon-on',  tile.iconOn);
  updateIconPreview('te-icon-off', tile.iconOff);
  populateDeviceDropdown(tile.kind, tile.deviceId);
  syncTileEditorVisibility();
  if (tile.kind === 'text') populateAttrDropdown(tile.attribute || '');
  if (tile.kind === 'momentary') populateCommandDropdown(tile.command || '');
  if (tile.kind === 'valve') populateValveCommandDropdowns(tile.openCommand || '', tile.closeCommand || '');
  tileEditor.classList.add('open');
}

// ── Custom dashboard creation ─────────────────────────────────────────────────

const newDashModal = document.getElementById('new-dash-modal');
document.getElementById('new-custom-dashboard').addEventListener('click', () => {
  document.getElementById('new-dash-name').value  = '';
  document.getElementById('new-dash-title').value = '';
  document.getElementById('new-dash-status').textContent = '';
  newDashModal.classList.add('open');
});
document.getElementById('new-dash-cancel').addEventListener('click', () => {
  newDashModal.classList.remove('open');
});
document.getElementById('new-dash-create').addEventListener('click', () => {
  const nameRaw = document.getElementById('new-dash-name').value.trim();
  const title   = document.getElementById('new-dash-title').value.trim() || nameRaw;
  const statusEl = document.getElementById('new-dash-status');

  // Sanitize name for URL hash
  const name = nameRaw.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/^-+|-+$/g,'');
  if (!name) { statusEl.textContent = 'Name required.'; return; }
  if (customDashboards[name]) { statusEl.textContent = `"${name}" already exists.`; return; }

  customDashboards[name] = { title, tiles: [] };
  saveCustomDashboards();
  newDashModal.classList.remove('open');
  navigate(`custom/${name}`);
});

function refreshCustomDashList() {
  const list = document.getElementById('custom-dash-list');
  if (!list) return;
  const colOptions = [2,3,4,5,6].map(n =>
    `<option value="${n}">${n} cols</option>`
  ).join('');

  list.innerHTML = Object.entries(customDashboards).map(([name, dash]) => {
    const selected = dash.gridCols || '';
    return `<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:var(--tile-bg);border:1px solid var(--tile-border);border-radius:4px;flex-wrap:wrap">
      <input class="dash-title-input" data-dash-title="${name}" value="${escapeHtml(dash.title || name)}"
        style="flex:1;min-width:80px;font-size:13px;background:var(--surface-2);border:1px solid var(--border-soft);color:var(--tile-text);padding:3px 6px;border-radius:3px" />
      <span style="font-size:11px;color:var(--tile-label)">#custom/${escapeHtml(name)}</span>
      <select class="dash-cols-sel" data-dash-cols="${name}"
        style="background:var(--surface-2);border:1px solid var(--border-soft);color:var(--tile-text);padding:3px 6px;border-radius:3px;font-size:12px">
        <option value="">Auto cols</option>${colOptions}
      </select>
      <button class="btn sm secondary" data-dash-name="${name}">Open</button>
      <button class="btn sm danger" data-dash-delete="${name}">Delete</button>
    </div>`;
  }).join('') || '<div style="color:var(--text-dim);font-size:12px;padding:4px 0">No custom dashboards yet.</div>';

  list.querySelectorAll('.dash-title-input').forEach(input => {
    const commit = () => {
      const n = input.dataset.dashTitle;
      const val = input.value.trim() || n;
      if (customDashboards[n].title === val) return;
      customDashboards[n].title = val;
      saveCustomDashboards();
      if (currentView === `custom/${n}`) renderCustomDashboard(n);
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { input.blur(); }
    });
  });

  // Set current gridCols selection
  list.querySelectorAll('.dash-cols-sel').forEach(sel => {
    const name = sel.dataset.dashCols;
    sel.value = String(customDashboards[name]?.gridCols || '');
    sel.addEventListener('change', () => {
      const n = sel.dataset.dashCols;
      const val = parseInt(sel.value, 10);
      if (val >= 2) customDashboards[n].gridCols = val;
      else delete customDashboards[n].gridCols;
      saveCustomDashboards();
      if (currentView === `custom/${n}`) renderCustomDashboard(n);
    });
  });

  list.querySelectorAll('[data-dash-name]').forEach(btn => {
    btn.addEventListener('click', () => {
      closeSettings();
      navigate(`custom/${btn.dataset.dashName}`);
    });
  });
  list.querySelectorAll('[data-dash-delete]').forEach(btn => {
    btn.addEventListener('click', () => {
      const n = btn.dataset.dashDelete;
      if (!confirm(`Delete dashboard "${n}"? This cannot be undone.`)) return;
      delete customDashboards[n];
      saveCustomDashboards();
    });
  });
}

// ── Device picker modal ───────────────────────────────────────────────────────

const devicePickerModal = document.getElementById('device-picker-modal');

function openDevicePicker(title, callback) {
  devicePickerCallback = callback;
  selectedDeviceIds.clear();
  document.getElementById('device-picker-title').textContent = title || 'Add Device';
  document.getElementById('device-search').value = '';
  updatePickerAddBtn();
  renderDeviceList('');
  devicePickerModal.classList.add('open');
}

function updatePickerAddBtn() {
  const btn = document.getElementById('device-picker-add');
  const cnt = document.getElementById('device-picker-count');
  if (selectedDeviceIds.size > 0) {
    btn.style.display = '';
    if (cnt) cnt.textContent = selectedDeviceIds.size;
  } else {
    btn.style.display = 'none';
  }
}

function renderDeviceList(filter) {
  const list = document.getElementById('device-list');
  const q = filter.toLowerCase();
  const filtered = devices
    .filter(d => !q || (d.label || d.name || '').toLowerCase().includes(q))
    .sort((a,b) => (a.label||a.name||'').localeCompare(b.label||b.name||''));

  if (!filtered.length) {
    list.innerHTML = '<div style="color:var(--text-dim);font-size:13px;padding:8px">No matching devices.</div>';
    return;
  }
  list.innerHTML = filtered.map(d =>
    `<div class="device-row" data-dev-id="${d.id}" style="gap:8px">
      <input type="checkbox" class="dev-check" data-dev-id="${d.id}"
        ${selectedDeviceIds.has(String(d.id)) ? 'checked' : ''}
        style="flex-shrink:0;width:16px;height:16px;accent-color:var(--info)" />
      <span class="dev-name">${escapeHtml(d.label || d.name)}</span>
      <span class="dev-id">${d.id}</span>
    </div>`
  ).join('');

  // Row click toggles checkbox
  list.querySelectorAll('.device-row').forEach(row => {
    row.addEventListener('click', e => {
      const cb = row.querySelector('.dev-check');
      if (!cb || e.target === cb) return; // let native checkbox handle direct clicks
      cb.checked = !cb.checked;
      cb.checked ? selectedDeviceIds.add(cb.dataset.devId)
                 : selectedDeviceIds.delete(cb.dataset.devId);
      updatePickerAddBtn();
    });
  });
  list.querySelectorAll('.dev-check').forEach(cb => {
    cb.addEventListener('change', () => {
      cb.checked ? selectedDeviceIds.add(cb.dataset.devId)
                 : selectedDeviceIds.delete(cb.dataset.devId);
      updatePickerAddBtn();
    });
  });
}

document.getElementById('device-search').addEventListener('input', e => {
  renderDeviceList(e.target.value);
});
document.getElementById('device-picker-cancel').addEventListener('click', () => {
  selectedDeviceIds.clear();
  devicePickerModal.classList.remove('open');
});
document.getElementById('device-picker-add').addEventListener('click', () => {
  const selected = [...selectedDeviceIds].map(id => findDevice(id)).filter(Boolean);
  if (selected.length && devicePickerCallback) devicePickerCallback(selected);
  selectedDeviceIds.clear();
  devicePickerModal.classList.remove('open');
});

// Wire up "Add Device" button in custom dashboard view
document.getElementById('custom-add-tile').addEventListener('click', () => {
  const name = currentView.replace('custom/', '');
  if (!customDashboards[name]) return;

  openDevicePicker(`Add to "${customDashboards[name].title || name}"`, selectedDevs => {
    const dash = customDashboards[name];
    for (const d of selectedDevs) {
      // Generate a unique slotId for this custom tile
      const existingIds = new Set(dash.tiles.map(t => t.slotId));
      let n = 1;
      while (existingIds.has(`cd${n}`)) n++;
      const slotId = `cd${n}`;
      dash.tiles.push({
        slotId,
        deviceId: String(d.id),
        kind: dynKindForDevice(d),
        label: d.label || d.name || String(d.id),
      });
    }
    saveCustomDashboards();
    renderCustomDashboard(name);
  });
});

// ── Tile editor ───────────────────────────────────────────────────────────────

let editingSlot = null;
const tileEditor = document.getElementById('tile-editor');

function openTileEditor(slotId) {
  editingCustom = null; // not editing a custom tile
  editingSlot = slotId;
  const s = cfg.slots[slotId] || {};
  document.getElementById('tile-editor-title').textContent = `Edit: ${s.label || slotId}`;
  document.getElementById('te-label').value              = s.label    || '';
  document.getElementById('te-kind').value               = s.kind     || 'switch';
  document.getElementById('te-url').value                = s.url      || '';
  document.getElementById('te-url-newtab').checked       = !!s.urlNewTab;
  document.getElementById('te-style').value              = s.style    || 'auto';
  document.getElementById('te-require-confirm').checked  = !!s.requireConfirm;
  document.getElementById('te-valve-timer').checked      = !!s.valveTimer;
  document.getElementById('te-render-html').checked      = !!s.renderHtml;
  document.getElementById('te-image-orient').value       = s.imageOrientation || 'landscape';
  document.getElementById('te-image-fit').value           = s.imageFit || 'cover';
  document.getElementById('te-command-arg').value         = s.commandArg || '';
  document.getElementById('te-col-span').value           = String(s.colSpan ?? 1);
  document.getElementById('te-row-span').value           = String(s.rowSpan || 1);
  document.getElementById('te-icon').value               = s.icon    || '';
  document.getElementById('te-icon-on').value             = s.iconOn  || '';
  document.getElementById('te-icon-off').value            = s.iconOff || '';
  updateIconPreview('te-icon',     s.icon);
  updateIconPreview('te-icon-on',  s.iconOn);
  updateIconPreview('te-icon-off', s.iconOff);
  populateDeviceDropdown(s.kind, s.deviceId);
  syncTileEditorVisibility();
  if (s.kind === 'text') populateAttrDropdown(s.attribute || '');
  if (s.kind === 'momentary') populateCommandDropdown(s.command || '');
  if (s.kind === 'valve') populateValveCommandDropdowns(s.openCommand || '', s.closeCommand || '');
  tileEditor.classList.add('open');
}

function populateDeviceDropdown(kind, currentId) {
  const sel = document.getElementById('te-device');
  const filters = {
    switch:   d => hasCapability(d,'Switch')          || getAttr(d,'switch')    !== undefined,
    bulb:     d => (hasCapability(d,'SwitchLevel')    || getAttr(d,'level')     !== undefined) &&
                   (hasCapability(d,'Switch')         || getAttr(d,'switch')    !== undefined),
    lock:     d => hasCapability(d,'Lock')            || getAttr(d,'lock')      !== undefined,
    garage:   d => hasCapability(d,'GarageDoorControl')|| getAttr(d,'door')     !== undefined,
    contact:  d => hasCapability(d,'ContactSensor')   || getAttr(d,'contact')   !== undefined,
    presence: d => hasCapability(d,'PresenceSensor')  || getAttr(d,'presence')  !== undefined,
    thermostat: d => hasCapability(d,'Thermostat')    || getAttr(d,'thermostatMode') !== undefined,
    momentary: d => hasCapability(d,'Momentary'),
    image:    isImageDevice,
  };
  const allSorted = [...devices].sort((a,b) => (a.label||a.name||'').localeCompare(b.label||b.name||''));
  const filtered  = filters[kind] ? allSorted.filter(filters[kind]) : allSorted;
  const rest      = allSorted.filter(d => !filtered.includes(d));

  sel.innerHTML = '<option value="">— none —</option>' +
    filtered.map(d => `<option value="${d.id}">${escapeHtml(d.label || d.name)} (${d.id})</option>`).join('') +
    (rest.length ? `<optgroup label="All other devices">${
      rest.map(d => `<option value="${d.id}">${escapeHtml(d.label || d.name)} (${d.id})</option>`).join('')
    }</optgroup>` : '');
  sel.value = currentId || '';
}

/**
 * Populate the attribute autocomplete list from the currently-selected device's
 * attributes, then set the input value.  Works even if devices aren't loaded yet
 * (list will just be empty and the user can still type manually).
 */
function populateAttrDropdown(initialValue = '') {
  const input    = document.getElementById('te-attr');
  const datalist = document.getElementById('te-attr-list');
  const hint     = document.getElementById('te-attr-hint');
  if (!input || !datalist) return;

  datalist.innerHTML = '';
  const device = findDevice(document.getElementById('te-device').value);
  if (device && device.attributes) {
    const attrs = Array.isArray(device.attributes)
      ? device.attributes
      : Object.entries(device.attributes).map(([name, currentValue]) => ({ name, currentValue }));
    attrs.sort((a, b) => a.name.localeCompare(b.name)).forEach(attr => {
      const opt = document.createElement('option');
      opt.value = attr.name;
      // Show current value as the label so the user knows which attribute to pick
      opt.label = attr.currentValue != null ? `${attr.name}  →  ${attr.currentValue}` : attr.name;
      datalist.appendChild(opt);
    });
    if (hint) hint.textContent = `(${attrs.length} attributes available)`;
  } else {
    if (hint) hint.textContent = devices.length ? '(device not found)' : '(load devices first)';
  }

  input.value = initialValue;
}

/**
 * Populate the command autocomplete list from the currently-selected device's
 * available commands (Maker API lists names only, no argument metadata), then
 * set the input value. Works even if devices aren't loaded yet — the field
 * stays free-text either way, since a device may accept a command Maker API
 * doesn't happen to list, or the driver's command list may be stale.
 */
function populateCommandDropdown(initialValue = '') {
  const input    = document.getElementById('te-command');
  const datalist = document.getElementById('te-command-list');
  const hint     = document.getElementById('te-command-hint');
  if (!input || !datalist) return;

  datalist.innerHTML = '';
  const device = findDevice(document.getElementById('te-device').value);
  const cmds = deviceCommands(device);
  cmds.slice().sort().forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    datalist.appendChild(opt);
  });
  if (device) {
    hint.textContent = cmds.length ? `(${cmds.length} commands available)` : '(device reports no commands — type one manually)';
  } else {
    hint.textContent = devices.length ? '(device not found)' : '(load devices first)';
  }

  input.value = initialValue;
}

/**
 * Same idea as populateCommandDropdown(), for the valve tile's open/close
 * command overrides. Both inputs share one datalist since they draw from the
 * same device. Defaults are the Valve capability's own open/close; overriding
 * exists because some drivers can't dispatch a *timed* open — the Valve
 * capability already defines a no-argument open(), so declaring
 * `command 'open', ['number']` alongside it collides and the hub returns a
 * generic "An unexpected error occurred." for /devices/{id}/open/{minutes}.
 * Pointing the tile at a distinctly-named command (e.g. openFor) sidesteps
 * that without the dashboard having to guess at driver internals.
 */
function populateValveCommandDropdowns(openValue = '', closeValue = '') {
  const openInput  = document.getElementById('te-valve-open-cmd');
  const closeInput = document.getElementById('te-valve-close-cmd');
  const datalist   = document.getElementById('te-valve-cmd-list');
  const hint       = document.getElementById('te-valve-open-hint');
  if (!openInput || !closeInput || !datalist) return;

  datalist.innerHTML = '';
  const device = findDevice(document.getElementById('te-device').value);
  const cmds = deviceCommands(device);
  cmds.slice().sort().forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    datalist.appendChild(opt);
  });
  if (hint) {
    if (device) {
      hint.textContent = cmds.length ? `(${cmds.length} commands available)` : '(device reports no commands — type one manually)';
    } else {
      hint.textContent = devices.length ? '(device not found)' : '(load devices first)';
    }
  }

  openInput.value  = openValue;
  closeInput.value = closeValue;
}

// Kinds whose tiles render an icon (and so support a per-tile icon override)
const ICON_ELIGIBLE_KINDS = ['switch','bulb','presence','lock','garage','water','valve','shade','thermostat','momentary'];

// Binary-state kinds get separate "on"/"off" icon overrides instead of one fallback icon.
// Labels describe what each state actually means for that kind.
const ICON_STATE_LABELS = {
  switch: ['On icon', 'Off icon'],
  lock:   ['Locked icon', 'Unlocked icon'],
  garage: ['Open icon', 'Closed icon'],
  valve:  ['Open icon', 'Closed icon'],
  shade:  ['Open icon', 'Closed icon'],
};

function syncTileEditorVisibility() {
  const kind = document.getElementById('te-kind').value;
  const isSpacer = kind === 'spacer';
  document.getElementById('te-device-row').style.display   = ['dashboard-link','hsm','mode','hidden','spacer'].includes(kind) ? 'none' : '';
  document.getElementById('te-url-row').style.display      = kind === 'dashboard-link' ? '' : 'none';
  document.getElementById('te-attr-row').style.display     = kind === 'text'           ? '' : 'none';
  document.getElementById('te-command-row').style.display  = kind === 'momentary'      ? '' : 'none';
  // Confirmation available for switch, lock, and garage
  document.getElementById('te-confirm-row').style.display  = ['switch','lock','garage','momentary'].includes(kind) ? '' : 'none';
  // Valve timer available for valve kind
  document.getElementById('te-valve-timer-row').style.display = kind === 'valve' ? '' : 'none';
  document.getElementById('te-valve-cmd-row').style.display   = kind === 'valve' ? '' : 'none';
  document.getElementById('te-orient-row').style.display   = kind === 'image'          ? '' : 'none';
  document.getElementById('te-fit-row').style.display      = kind === 'image'          ? '' : 'none';
  document.getElementById('te-row-span-row').style.display = kind !== 'image'          ? '' : 'none';

  const iconEligible = ICON_ELIGIBLE_KINDS.includes(kind);
  const stateLabels = ICON_STATE_LABELS[kind];
  document.getElementById('te-icon-row').style.display    = iconEligible ? '' : 'none';
  document.getElementById('te-icon-single').style.display  = (iconEligible && !stateLabels) ? 'flex' : 'none';
  document.getElementById('te-icon-dual').style.display     = stateLabels ? 'flex' : 'none';
  if (stateLabels) {
    document.getElementById('te-icon-on-label').textContent  = stateLabels[0];
    document.getElementById('te-icon-off-label').textContent = stateLabels[1];
  }

  // Spacer: hide label and style — only size matters
  document.querySelector('.form-row:has(#te-label)').style.display  = isSpacer ? 'none' : '';
  document.querySelector('.form-row:has(#te-style)').style.display  = isSpacer ? 'none' : '';
}

function updateIconPreview(prefix, name) {
  const preview = document.getElementById(`${prefix}-preview`);
  const nameEl  = document.getElementById(`${prefix}-name`);
  if (preview) preview.innerHTML = name ? iconSvg(name) : '';
  if (nameEl)  nameEl.textContent = name || 'Default';
}

let iconPickerCallback = null;
let iconPickerCurrentValue = '';

function openIconPicker(currentValue, onSelect) {
  iconPickerCallback = onSelect;
  iconPickerCurrentValue = currentValue;
  document.getElementById('icon-picker-search').value = '';
  renderIconPickerGrid('', currentValue);
  document.getElementById('icon-picker-modal').classList.add('open');
}

function renderIconPickerGrid(filterText, selectedName) {
  const grid = document.getElementById('icon-picker-grid');
  const q = filterText.trim().toLowerCase().replace(/-/g, ' ');
  const names = Object.keys(MDI_ICONS).sort();
  const matches = q ? names.filter(n => n.replace(/-/g, ' ').includes(q)) : names;
  grid.innerHTML = matches.map(n => `
    <div class="icon-picker-item${n === selectedName ? ' selected' : ''}" data-icon-name="${n}" title="${n}">
      ${iconSvg(n)}
      <span>${n}</span>
    </div>`).join('') || '<div style="grid-column:1/-1;color:var(--text-dim);font-size:12px;padding:12px;text-align:center">No icons match</div>';
}

function wireIconField(prefix) {
  document.getElementById(`${prefix}-btn`).addEventListener('click', () => {
    const input = document.getElementById(prefix);
    openIconPicker(input.value, name => {
      input.value = name;
      updateIconPreview(prefix, name);
    });
  });
  document.getElementById(`${prefix}-clear`).addEventListener('click', () => {
    document.getElementById(prefix).value = '';
    updateIconPreview(prefix, '');
  });
}

wireIconField('te-icon');
wireIconField('te-icon-on');
wireIconField('te-icon-off');

document.getElementById('icon-picker-search').addEventListener('input', e => {
  renderIconPickerGrid(e.target.value, iconPickerCurrentValue);
});

document.getElementById('icon-picker-grid').addEventListener('click', e => {
  const item = e.target.closest('[data-icon-name]');
  if (!item) return;
  document.getElementById('icon-picker-modal').classList.remove('open');
  if (iconPickerCallback) iconPickerCallback(item.dataset.iconName);
});

document.getElementById('icon-picker-cancel').addEventListener('click', () => {
  document.getElementById('icon-picker-modal').classList.remove('open');
});

document.getElementById('te-kind').addEventListener('change', () => {
  const kind = document.getElementById('te-kind').value;
  // Preserve the current device selection across kind changes
  const currentDeviceId = document.getElementById('te-device').value;
  populateDeviceDropdown(kind, currentDeviceId);
  syncTileEditorVisibility();
  if (kind === 'text') populateAttrDropdown('');
  if (kind === 'momentary') populateCommandDropdown('');
  if (kind === 'valve') populateValveCommandDropdowns('', '');

  // Auto-set confirm for safety-critical kinds; never auto-clear it
  const confirmCb = document.getElementById('te-require-confirm');
  if (kind === 'lock' || kind === 'garage') confirmCb.checked = true;
});

// When device changes while kind=text/momentary/valve, refresh the suggestion list
document.getElementById('te-device').addEventListener('change', () => {
  const kind = document.getElementById('te-kind').value;
  if (kind === 'text') {
    populateAttrDropdown(document.getElementById('te-attr').value);
  } else if (kind === 'momentary') {
    populateCommandDropdown(document.getElementById('te-command').value);
  } else if (kind === 'valve') {
    populateValveCommandDropdowns(
      document.getElementById('te-valve-open-cmd').value,
      document.getElementById('te-valve-close-cmd').value,
    );
  }
});

document.getElementById('te-save').addEventListener('click', () => {
  // ── Custom dashboard tile save ───────────────────────────────────────────────
  if (editingCustom) {
    const { dashName, slotId } = editingCustom;
    const dash = customDashboards[dashName];
    if (dash) {
      const tile = dash.tiles.find(t => t.slotId === slotId);
      if (tile) {
        tile.label    = document.getElementById('te-label').value.trim() || tile.label || slotId;
        tile.kind     = document.getElementById('te-kind').value;
        const devVal  = document.getElementById('te-device').value;
        if (devVal) tile.deviceId = devVal;
        if (tile.kind === 'text') {
          tile.attribute = document.getElementById('te-attr').value.trim();
          const rh = document.getElementById('te-render-html').checked;
          if (rh) tile.renderHtml = true; else delete tile.renderHtml;
        } else {
          delete tile.attribute;
          delete tile.renderHtml;
        }
        tile.style      = document.getElementById('te-style').value || 'auto';
        const rc = document.getElementById('te-require-confirm').checked;
        if (rc) tile.requireConfirm = true; else delete tile.requireConfirm;
        const vt = document.getElementById('te-valve-timer').checked;
        if (vt) tile.valveTimer = true; else delete tile.valveTimer;
        tile.url        = document.getElementById('te-url').value.trim() || undefined;
        tile.urlNewTab  = document.getElementById('te-url-newtab').checked || undefined;
        const io = document.getElementById('te-image-orient').value;
        tile.imageOrientation = io === 'portrait' ? 'portrait' : undefined;
        const ifit = document.getElementById('te-image-fit').value;
        tile.imageFit = ifit === 'contain' ? 'contain' : undefined;
        const cmd = document.getElementById('te-command').value.trim();
        tile.command = cmd || undefined;
        const cmdArg = document.getElementById('te-command-arg').value.trim();
        tile.commandArg = cmdArg || undefined;
        const vOpen  = document.getElementById('te-valve-open-cmd').value.trim();
        const vClose = document.getElementById('te-valve-close-cmd').value.trim();
        tile.openCommand  = vOpen  || undefined;
        tile.closeCommand = vClose || undefined;
        const cs = parseFloat(document.getElementById('te-col-span').value) || 1;
        const rs = parseInt(document.getElementById('te-row-span').value, 10) || 1;
        if (cs > 1) tile.colSpan = cs; else delete tile.colSpan;
        if (rs > 1) tile.rowSpan = rs; else delete tile.rowSpan;
        const icon = document.getElementById('te-icon').value;
        if (icon) tile.icon = icon; else delete tile.icon;
        const iconOn = document.getElementById('te-icon-on').value;
        if (iconOn) tile.iconOn = iconOn; else delete tile.iconOn;
        const iconOff = document.getElementById('te-icon-off').value;
        if (iconOff) tile.iconOff = iconOff; else delete tile.iconOff;
      }
    }
    editingCustom = null;
    tileEditor.classList.remove('open');
    saveCustomDashboards();
    renderCustomDashboard(dashName);
    return;
  }

  // ── Main dashboard slot save ─────────────────────────────────────────────────
  const s = cfg.slots[editingSlot] || {};
  s.label            = document.getElementById('te-label').value.trim() || s.label || editingSlot;
  s.kind             = document.getElementById('te-kind').value;
  s.deviceId         = document.getElementById('te-device').value || '';
  if (s.kind === 'text') {
    s.attribute = document.getElementById('te-attr').value.trim();
    s.renderHtml = document.getElementById('te-render-html').checked || undefined;
  } else {
    delete s.attribute;
    delete s.renderHtml;
  }
  s.url              = document.getElementById('te-url').value.trim() || '';
  s.urlNewTab        = document.getElementById('te-url-newtab').checked;
  s.style            = document.getElementById('te-style').value;
  s.requireConfirm   = document.getElementById('te-require-confirm').checked || undefined;
  s.valveTimer       = document.getElementById('te-valve-timer').checked || undefined;
  s.imageOrientation = document.getElementById('te-image-orient').value === 'portrait' ? 'portrait' : undefined;
  s.imageFit         = document.getElementById('te-image-fit').value === 'contain' ? 'contain' : undefined;
  s.command          = document.getElementById('te-command').value.trim() || undefined;
  s.commandArg       = document.getElementById('te-command-arg').value.trim() || undefined;
  s.openCommand      = document.getElementById('te-valve-open-cmd').value.trim() || undefined;
  s.closeCommand     = document.getElementById('te-valve-close-cmd').value.trim() || undefined;
  s.colSpan          = parseFloat(document.getElementById('te-col-span').value) || 1;
  s.rowSpan          = parseInt(document.getElementById('te-row-span').value, 10) || 1;
  if (s.colSpan === 1) delete s.colSpan;
  if (s.rowSpan === 1) delete s.rowSpan;
  if (!s.requireConfirm) delete s.requireConfirm;
  if (!s.imageOrientation) delete s.imageOrientation;
  if (!s.imageFit) delete s.imageFit;
  if (!s.command) delete s.command;
  if (!s.commandArg) delete s.commandArg;
  if (!s.openCommand) delete s.openCommand;
  if (!s.closeCommand) delete s.closeCommand;
  const icon = document.getElementById('te-icon').value;
  if (icon) s.icon = icon; else delete s.icon;
  const iconOn = document.getElementById('te-icon-on').value;
  if (iconOn) s.iconOn = iconOn; else delete s.iconOn;
  const iconOff = document.getElementById('te-icon-off').value;
  if (iconOff) s.iconOff = iconOff; else delete s.iconOff;
  delete imageLastRefreshed[editingSlot]; // force immediate re-fetch with new config
  cfg.slots[editingSlot] = s;
  saveConfigCache();
  markDirty();
  buildLayout(); renderAll();
  tileEditor.classList.remove('open');
});

document.getElementById('te-cancel').addEventListener('click', () => {
  editingCustom = null;
  tileEditor.classList.remove('open');
});

document.getElementById('te-duplicate').addEventListener('click', () => {
  // ── Duplicate a custom dashboard tile ─────────────────────────────────────
  if (editingCustom) {
    const { dashName, slotId } = editingCustom;
    const dash = customDashboards[dashName];
    if (!dash) return;
    const tile = dash.tiles.find(t => t.slotId === slotId);
    if (!tile) return;

    const existingIds = new Set(dash.tiles.map(t => t.slotId));
    let n = 1;
    while (existingIds.has(`cd${n}`)) n++;
    const newSlotId = `cd${n}`;

    const copy = { ...tile, slotId: newSlotId, label: (tile.label || slotId) + ' (copy)' };
    const insertIdx = dash.tiles.findIndex(t => t.slotId === slotId);
    dash.tiles.splice(insertIdx + 1, 0, copy);

    tileEditor.classList.remove('open');
    editingCustom = null;
    saveCustomDashboards();
    renderCustomDashboard(dashName);
    return;
  }

  // ── Duplicate a main dashboard slot ──────────────────────────────────────
  if (!editingSlot) return;
  const newId = generateSlotId();
  const src = cfg.slots[editingSlot] || {};
  cfg.slots[newId] = { ...src, label: (src.label || editingSlot) + ' (copy)' };

  // Insert after the current slot in the same section
  const layout = cfg.layout || JSON.parse(JSON.stringify(LAYOUT_DEFAULTS));
  let inserted = false;
  for (const ids of Object.values(layout)) {
    const idx = ids.indexOf(editingSlot);
    if (idx !== -1) { ids.splice(idx + 1, 0, newId); inserted = true; break; }
  }
  if (!inserted) {
    // Fallback: add to row1
    if (!layout.row1) layout.row1 = [];
    layout.row1.push(newId);
  }
  cfg.layout = layout;
  saveConfigCache();
  markDirty();
  tileEditor.classList.remove('open');
  editingSlot = null;
  buildLayout();
  renderAll();
});

document.getElementById('te-clear').addEventListener('click', () => {
  if (editingCustom) { editingCustom = null; tileEditor.classList.remove('open'); return; }
  if (!confirm('Reset this slot to its default?')) return;
  cfg.slots[editingSlot] = { ...(DEFAULT_SLOTS[editingSlot] || { label: editingSlot, kind: 'hidden' }) };
  saveConfigCache();
  markDirty();
  buildLayout(); renderAll();
  tileEditor.classList.remove('open');
});

document.getElementById('te-delete').addEventListener('click', () => {
  if (editingCustom) {
    const { dashName, slotId } = editingCustom;
    if (!confirm('Remove this tile from the dashboard?')) return;
    editingCustom = null;
    tileEditor.classList.remove('open');
    removeCustomTile(dashName, slotId);
    return;
  }
  const isUserAdded = editingSlot.startsWith('u');
  if (!confirm(isUserAdded
    ? 'Remove this tile from the layout?'
    : 'Hide this tile? (It will be invisible outside edit mode. Use × in edit mode to restore.)')) return;

  if (isUserAdded) {
    // User-added tile: remove from layout and delete the slot
    const layout = cfg.layout || JSON.parse(JSON.stringify(LAYOUT_DEFAULTS));
    for (const ids of Object.values(layout)) {
      const idx = ids.indexOf(editingSlot);
      if (idx !== -1) { ids.splice(idx, 1); break; }
    }
    cfg.layout = layout;
    delete cfg.slots[editingSlot];
  } else {
    // Fixed slot: just hide it
    cfg.slots[editingSlot] = { ...(cfg.slots[editingSlot] || {}), kind: 'hidden' };
  }
  saveConfigCache();
  markDirty();
  buildLayout(); renderAll();
  tileEditor.classList.remove('open');
});

// ── Polling and device refresh ────────────────────────────────────────────────

async function refreshDevices() {
  if (!cfg.hubBaseUrl || !cfg.hubAppId) {
    return { ok: false, error: 'Hub not configured — enter your Base URL and App ID in settings.' };
  }
  if (!cfg.hubToken && !cfg.hubHasToken) {
    return { ok: false, error: 'Access token not set — paste your Maker API token in the Token field above.' };
  }
  try {
    devices = await api('/devices/all');
    if (!Array.isArray(devices)) devices = [];

    try {
      hubModes = await api('/modes') || [];
      const active = hubModes.find(m => m.active);
      if (active) window.__currentMode = active.name;
    } catch {}

    try {
      const hsm = await api('/hsm');
      if (hsm && hsm.hsm) window.__hsmState = hsm.hsm;
    } catch {}

    setConnDot(true);
    return { ok: true };
  } catch (e) {
    setConnDot(false);
    return { ok: false, error: e.message || String(e) };
  }
}

async function refreshAll(force) {
  const r = await refreshDevices();
  if (r && r.ok) lastDataAt = Date.now();
  renderAll(force);
  updateWsDotTitle();
}

function setConnDot(ok) {
  document.getElementById('conn-dot').classList.toggle('ok', !!ok);
}

// Polling is the baseline that always runs, at the configured rate, whether or
// not the WebSocket is connected. The socket is an accelerant on top of it,
// never a replacement — see connectWebSocket() for why trusting the socket
// alone silently freezes the dashboard.
//
// The poll deliberately does NOT slow down while the socket is live. The
// socket only exists for LAN/tunnel hubs, and the "don't poll faster than 5s"
// rule (see CLAUDE.md gotchas) is a Hubitat *Cloud* rate limit that doesn't
// apply there — so a full-rate poll costs nothing a cloud-connected setup
// isn't already paying, and it caps worst-case staleness at cfg.pollSec
// instead of however long a dead-but-open socket goes unnoticed.
const WS_RECONNECT_MS = 30000;

let currentPollMs   = null;
let pollInFlight    = false;
let lastDataAt      = 0;   // last time device state actually arrived (poll or event)
let lastWsEventAt   = 0;   // last time the socket delivered anything
let lastWsAttemptAt = 0;   // throttles reconnects driven from pollTick

function wsIsLive() {
  return !!ws && ws.readyState === WebSocket.OPEN;
}

function desiredPollMs() {
  return Math.max(2, cfg.pollSec) * 1000;
}

async function pollTick() {
  // A socket proxied through a plain Worker can stop delivering without ever
  // firing 'close' — readyState stays OPEN while nothing arrives. Re-check
  // health every tick instead of trusting the last 'open' event we saw.
  if (ws && !wsIsLive()) {
    try { ws.close(); } catch { /* already gone */ }
    ws = null;
    setWsDot(false);
  }
  // Retry the socket from here too (the close handler's own 30s timer never
  // fires for a socket that died without closing), but no faster than that
  // same backoff — otherwise a hub that refuses the eventsocket would get
  // hammered once per poll tick.
  if (!ws && !HND_VIA_CLOUD && Date.now() - lastWsAttemptAt >= WS_RECONNECT_MS) {
    connectWebSocket();
  }

  // Re-rate if WebSocket health changed since the interval was created.
  const want = desiredPollMs();
  if (want !== currentPollMs) startPolling();

  // A slow hub shouldn't let ticks pile up into overlapping /devices/all calls.
  if (pollInFlight) return;
  pollInFlight = true;
  try { await refreshAll(); }
  finally { pollInFlight = false; }
}

function startPolling() {
  stopPolling();
  currentPollMs = desiredPollMs();
  pollTimer = setInterval(pollTick, currentPollMs);
  updateWsDotTitle();
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  currentPollMs = null;
}
// iOS throttles (and can fully suspend) setInterval/setTimeout timers for a
// backgrounded PWA — a locked screen, switching apps, or just leaving it idle
// — with no error or event of its own. The periodic poll above can silently
// stop firing for minutes; tapping a tile right before that happens is
// exactly the "why didn't this update" complaint (a manual pull-to-refresh
// always "fixes" it because it's a fresh user-triggered fetch, not because
// polling was actually working). Catch up immediately whenever the page is
// looked at again rather than waiting for the next tick that may not come.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshAll(true);
});

// WebSocket mode only patches attribute values on devices already known at
// connect time (see handleHubEvent) — it never adds newly-created devices to
// the `devices` array, and connecting successfully calls stopPolling(), which
// would otherwise have picked up new devices on its next full-list refresh.
// A long-lived session (e.g. an iOS PWA that's never force-quit) can end up
// stuck for hours/days without seeing devices added on the hub after connect.
// This timer runs independently of polling/WebSocket state so new devices
// still show up within a few minutes either way.
const DEVICE_LIST_SYNC_MS = 5 * 60 * 1000;
let deviceListSyncTimer = null;
function startDeviceListSync() {
  if (deviceListSyncTimer) return;
  // Routed through pollTick (not refreshAll) so it shares the in-flight guard
  // and the socket health check rather than racing the regular poll.
  deviceListSyncTimer = setInterval(pollTick, DEVICE_LIST_SYNC_MS);
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
//
// For LAN/tunnel hub URLs, the Worker proxies the hub's eventsocket so we
// receive real-time device events instead of polling every N seconds.
// For cloud URLs the Worker returns 501 and we fall back to polling.

function connectWebSocket() {
  if (ws) return; // already connected
  // Cloud Maker API has no WebSocket event stream — skip and use polling.
  if (HND_VIA_CLOUD) { startPolling(); return; }
  lastWsAttemptAt = Date.now();
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const hubId = extractHubId();
  const params = new URLSearchParams();
  if (hubId) params.set('hubId', hubId);
  // Pass hub base URL as a query param so the Worker can proxy the eventsocket
  // even in browser-only mode (no KV).  The eventsocket itself is unauthenticated
  // so no token is exposed here.
  if (cfg.hubBaseUrl) params.set('hubBaseUrl', cfg.hubBaseUrl);
  const query = params.size ? `?${params}` : '';
  const url   = `${proto}//${location.host}/eventsocket`;

  try {
    ws = new WebSocket(url);
  } catch (e) {
    console.warn('WebSocket construction failed, using polling', e);
    startPolling();
    return;
  }

  ws.addEventListener('open', () => {
    console.log('Hub WebSocket connected — real-time mode');
    setWsDot(true);
    lastWsEventAt = Date.now();
    // Deliberately does NOT stop polling. The Worker proxies this socket from a
    // plain fetch handler — no Durable Object, no ctx.waitUntil — so the proxy
    // can be torn down (Worker eviction, tunnel idle timeout, CF Access session
    // expiry) without a 'close' frame ever reaching the browser. readyState
    // stays OPEN, no events arrive, and nothing ever restarts the poll: the
    // dashboard then freezes until a manual pull-to-refresh, which is exactly
    // the "locks/presence don't update until I refresh" symptom. The poll
    // keeps running at full rate underneath; the socket just makes updates
    // land sooner than the next tick.
    updateWsDotTitle();
  });

  ws.addEventListener('message', e => {
    lastWsEventAt = Date.now();
    try {
      const evt = JSON.parse(e.data);
      handleHubEvent(evt);
    } catch {}
  });

  ws.addEventListener('close', e => {
    const reason = e.reason ? ` — ${e.reason}` : '';
    console.warn(`Hub WebSocket closed (code ${e.code})${reason} — falling back to polling`);
    ws = null;
    setWsDot(false);
    startPolling(); // back to the fast cadence now that push is gone
    // Try to reconnect after 30s
    if (wsReconnTimer) clearTimeout(wsReconnTimer);
    wsReconnTimer = setTimeout(() => {
      if (!ws) connectWebSocket();
    }, 30000);
  });

  ws.addEventListener('error', e => {
    console.warn('Hub WebSocket error:', e);
  });
}

function setWsDot(live) {
  document.getElementById('ws-dot').classList.toggle('live', !!live);
  updateWsDotTitle();
}

// The dot alone can't distinguish "socket open and delivering" from "socket
// open but silently dead" — the failure mode this whole path guards against.
// Put the real state in the tooltip so a stale dashboard can be diagnosed by
// hovering/long-pressing instead of opening a console.
function updateWsDotTitle() {
  const el = document.getElementById('ws-dot');
  if (!el) return;
  const ago = ms => {
    if (!ms) return 'never';
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
  };
  const mode = wsIsLive() ? 'WebSocket (live)' : (HND_VIA_CLOUD ? 'Polling (cloud — no WebSocket)' : 'Polling');
  const every = currentPollMs ? `${Math.round(currentPollMs / 1000)}s` : 'off';
  el.title = `${mode}\nPolling every ${every}\nLast data: ${ago(lastDataAt)}` +