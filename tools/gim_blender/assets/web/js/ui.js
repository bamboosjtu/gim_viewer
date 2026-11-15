// HUD, minimap, compass and mission flow.
export class HUD {
  constructor(sceneData, nav) {
    this.sceneData = sceneData;
    this.nav = nav;
    this.el = {
      hud: document.getElementById('hud'),
      intro: document.getElementById('intro'),
      loading: document.getElementById('loading'),
      progressBar: document.getElementById('progress-bar'),
      progressText: document.getElementById('progress-text'),
      loaderStatus: document.getElementById('loader-status'),
      startBtn: document.getElementById('start-btn'),
      statTriangles: document.getElementById('stat-triangles'),
      statDoors: document.getElementById('stat-doors'),
      statPlacements: document.getElementById('stat-placements'),
      buildBadge: document.getElementById('build-badge'),
      missionTitle: document.getElementById('mission-title'),
      missionDesc: document.getElementById('mission-desc'),
      missionSteps: document.getElementById('mission-steps'),
      wpArrow: document.getElementById('wp-arrow'),
      wpDistance: document.getElementById('wp-distance'),
      zoneLabel: document.getElementById('zone-label'),
      coords: document.getElementById('coords'),
      fps: document.getElementById('fps'),
      prompt: document.getElementById('prompt'),
      promptText: document.getElementById('prompt-text'),
      toast: document.getElementById('toast'),
      locationTag: document.getElementById('location-tag'),
      minimap: document.getElementById('minimap'),
      compass: document.getElementById('compass-canvas'),
      pause: document.getElementById('pause'),
      help: document.getElementById('help'),
      mapOverlay: document.getElementById('map-overlay'),
      stationMap: document.getElementById('station-map'),
    };
    this.minimapCtx = this.el.minimap.getContext('2d');
    this.compassCtx = this.el.compass.getContext('2d');
    this.mapBg = null;
    this.step = 0;
    this.toastTimer = null;
    this.fpsFrames = 0;
    this.fpsTime = performance.now();
    this.fpsValue = 0;
    this.lastMapUpdate = 0;
    this.mission = [
      { title: '进入变电站', desc: '沿入口走向整站大门，按 E 开启大门。' },
      { title: '前往建筑入口', desc: '按地图指引前往建筑入口。' },
      { title: '打开大门，走进室内', desc: '走近主控楼入口，按 E 打开大门并进入。' },
      { title: '自由探索', desc: '查看主变与 220kV/110kV 设备区；主控楼内可沿楼梯上二层。' },
    ];
    if (this.sceneData.title) document.title = this.sceneData.title;
    this.setIntroStats();
    this.renderMissionList();
    this.setMission(0);
    this.buildMinimapBackground();
  }

  setFreeRoam() {
    this.freeRoam = true;
    this.mission = [{ title: '自由探索', desc: '探索本站设施，空格跳跃，M 打开地图，R 返回整站大门。' }];
    this.renderMissionList();
    this.setMission(0);
    const steps = document.querySelector('.mission-steps');
    const waypoint = document.querySelector('.mission-waypoint');
    if (steps) steps.style.display = 'none';
    if (waypoint) waypoint.style.display = 'none';
    const brand = document.querySelector('.brand-sub');
    if (brand) brand.textContent = this.sceneData.title || '变电站 · 自由漫游';
    const eyebrow = document.getElementById('intro-eyebrow');
    const title = document.getElementById('intro-title');
    const lead = document.getElementById('intro-lead');
    const voltage = document.getElementById('stat-voltage');
    const id = String(this.sceneData.source || 'GIM').replace(/\.gim$/i, '').toUpperCase();
    if (eyebrow) eyebrow.textContent = `${id} · FREE ROAM`;
    if (title) title.innerHTML = '走进一座<br><em>变电站</em>';
    if (lead) lead.textContent = '从整站入口出发，自由探索本站设施。';
    if (voltage) { voltage.querySelector('b').textContent = 'GIM'; voltage.querySelector('span').textContent = '来源'; }
  }

  setIntroStats() {
    const c = this.sceneData.counts || {};
    const source=String(this.sceneData.source||'GIM').replace(/\.gim$/i,'').toUpperCase();
    const eyebrow=document.getElementById('intro-eyebrow');if(eyebrow)eyebrow.textContent=`${source} · FIRST PERSON WALKTHROUGH`;
    const brand=document.querySelector('.brand-sub');if(brand){brand.textContent=this.sceneData.title||'变电站 · 第一人称漫游';brand.title=brand.textContent;}
    const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);
    if (this.el.statTriangles) this.el.statTriangles.textContent = fmt((c.ifcTriangles || 0) + (c.gimTriangles || 0));
    if (this.el.statDoors) this.el.statDoors.textContent = String(c.doors || 0);
    if (this.el.statPlacements) this.el.statPlacements.textContent = fmt(c.gimPlacements || 0);
    if (this.el.buildBadge) {
      const roots = c.gimRoots || 0;
      const tris = fmt((c.ifcTriangles || 0) + (c.gimTriangles || 0));
      const build = this.sceneData.buildVersion || '2026.11.15-composite-nav-v6';
      this.el.buildBadge.textContent = `BUILD ${build} · ${roots} ROOTS · ${tris} TRI`;
      this.el.buildBadge.title = 'gim_viewer 源几何 occurrence 根；用于确认已加载修正版资产';
    }
  }

  setLoading(progress, status) {
    const p = Math.max(0, Math.min(1, progress));
    this.el.progressBar.style.width = `${(p * 100).toFixed(1)}%`;
    this.el.progressText.textContent = `${Math.round(p * 100)}%`;
    if (status) this.el.loaderStatus.textContent = status;
  }

  showIntro() {
    this.el.loading.classList.add('hidden');
    this.el.intro?.classList.remove('hidden');
    if(this.el.startBtn)this.el.startBtn.disabled = false;
  }

  enterTour() {
    this.el.loading.classList.add('hidden');
    this.el.intro?.classList.add('hidden');
    this.el.hud.classList.remove('hidden');
  }

  showPause(show) {
    this.el.pause.classList.toggle('hidden', !show);
  }

  showHelp(show) {
    this.el.help.classList.toggle('hidden', !show);
  }
  showMap(show) { this.el.mapOverlay.classList.toggle('hidden', !show); }

  renderMissionList() {
    this.el.missionSteps.innerHTML = '';
    this.mission.forEach((m, i) => {
      const li = document.createElement('li');
      li.textContent = m.title;
      li.dataset.step = String(i);
      this.el.missionSteps.appendChild(li);
    });
  }

  setMission(index) {
    this.step = Math.max(0, Math.min(this.mission.length - 1, index));
    const m = this.mission[this.step];
    this.el.missionTitle.textContent = m.title;
    this.el.missionDesc.textContent = m.desc;
    [...this.el.missionSteps.children].forEach((li, i) => {
      li.classList.toggle('done', i < this.step);
      li.classList.toggle('active', i === this.step);
    });
  }

  advanceMission(index) {
    if (index > this.step) {
      this.setMission(index);
      this.toast([
        '已进入变电站',
        '已到达主控楼入口',
        '已到达入口，按 E 打开大门',
        '已进入主控楼室内，开始自由探索',
      ][index] || '任务更新');
    }
  }

  setWaypoint(target, px, py, fx, fy) {
    if (!target) {
      this.el.wpArrow.style.opacity = '0.35';
      this.el.wpDistance.textContent = '自由探索';
      return;
    }
    this.el.wpArrow.style.opacity = '1';
    const dx = target[0] - px;
    const dy = target[1] - py;
    const dist = Math.hypot(dx, dy);
    this.el.wpDistance.textContent = `${dist.toFixed(1)} m`;
    const bearing = Math.atan2(dx, dy);
    const heading = Math.atan2(fx, fy);
    let rel = bearing - heading;
    while (rel > Math.PI) rel -= Math.PI * 2;
    while (rel < -Math.PI) rel += Math.PI * 2;
    this.el.wpArrow.style.transform = `rotate(${rel * 180 / Math.PI - 90}deg)`;
  }

  setPrompt(text) {
    if (!text) {
      this.el.prompt.classList.add('hidden');
      this.el.promptText.textContent = '';
      return;
    }
    this.el.promptText.textContent = text;
    this.el.prompt.classList.remove('hidden');
  }

  toast(text) {
    this.el.toast.textContent = text;
    this.el.toast.classList.remove('hidden');
    requestAnimationFrame(() => this.el.toast.classList.add('show'));
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.el.toast.classList.remove('show');
      setTimeout(() => this.el.toast.classList.add('hidden'), 300);
    }, 2200);
  }

  zoneAt(x, y, feet) {
    const legacy = this.sceneData.interiors || [];
    const areas = this.sceneData.sourceInteriors
      ? [...this.sceneData.sourceInteriors, ...legacy.filter(z => z.label !== '警卫室')]
      : legacy;
    for (const z of areas) {
      if(feet!==undefined && z.floor!==undefined && (feet<z.floor-.2 || feet>z.floor+2))continue;
      const [x0, y0, x1, y1] = z.rect;
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return { indoor: true, label: z.label };
    }
    return { indoor: false, label: '室外 · 变电站园区' };
  }

  buildMinimapBackground() {
    const b = this.nav.bounds;
    const w = this.nav.w, h = this.nav.h;
    const img = new ImageData(w, h);
    for (let iy = 0; iy < h; iy++) {
      const row = (h - 1 - iy) * w;
      for (let ix = 0; ix < w; ix++) {
        const idx = iy * w + ix;
        if (!this.nav.collision[idx]) continue;
        const p = (row + ix) * 4;
        img.data[p] = 104;
        img.data[p + 1] = 154;
        img.data[p + 2] = 174;
        img.data[p + 3] = 190;
      }
    }
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    tmp.getContext('2d').putImageData(img, 0, 0);
    const bg = document.createElement('canvas');
    bg.width = w; bg.height = h;
    const ctx = bg.getContext('2d');
    ctx.fillStyle = '#07131c';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tmp, 0, 0, w, h);
    // Buildings as subtle translucent blocks.
    const [x0, y0, x1, y1] = [b.x0, b.y0, b.x1, b.y1];
    const sx = w / (x1 - x0), sy = h / (y1 - y0);
    for (const bd of this.sceneData.buildings || []) {
      const r = bd.rect;
      ctx.fillStyle = 'rgba(116,220,255,0.055)';
      ctx.fillRect((r[0] - x0) * sx, (y1 - r[3]) * sy, (r[2] - r[0]) * sx, (r[3] - r[1]) * sy);
      ctx.strokeStyle = 'rgba(116,220,255,0.22)';
      ctx.lineWidth = 1.4;
      ctx.strokeRect((r[0] - x0) * sx, (y1 - r[3]) * sy, (r[2] - r[0]) * sx, (r[3] - r[1]) * sy);
    }
    this.mapBg = bg;
  }

  drawMinimap(px, py, fx, fy, doors, now, targetCanvas = this.el.minimap) {
    if (!this.mapBg) return;
    const c = targetCanvas;
    const ctx = c.getContext('2d');
    const W = c.width, H = c.height;
    const pad = 8;
    const b = this.nav.bounds;
    const scale = Math.min((W - pad * 2) / (b.x1 - b.x0), (H - pad * 2) / (b.y1 - b.y0));
    const ox = pad + ((W - pad * 2) - (b.x1 - b.x0) * scale) / 2;
    const oy = pad + ((H - pad * 2) - (b.y1 - b.y0) * scale) / 2;
    const mapX = (x) => ox + (x - b.x0) * scale;
    const mapY = (y) => oy + (b.y1 - y) * scale;

    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(this.mapBg, ox, oy, (b.x1-b.x0)*scale, (b.y1-b.y0)*scale);
    if (W > 400) {
      ctx.font = '14px "Microsoft YaHei",sans-serif';
      for (const l of this.sceneData.landmarks || []) {
        const x=mapX(l.pos[0]),y=mapY(l.pos[1]);
        ctx.fillStyle=l.kind==='gate'?'#ffae57':'#d2e9f1';
        ctx.beginPath();ctx.arc(x,y,4,0,Math.PI*2);ctx.fill();
        ctx.fillText(l.label,x+7,y-5);
      }
    }

    // Doors / gates.
    for (const d of doors) {
      const x = mapX(d.center[0]);
      const y = mapY(d.center[1]);
      if (x < 0 || y < 0 || x > W || y > H) continue;
      ctx.beginPath();
      if (d.isGate) {
        ctx.fillStyle = d.open ? 'rgba(122,240,180,0.95)' : 'rgba(255,174,87,0.95)';
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.65)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      } else {
        ctx.fillStyle = d.open ? 'rgba(122,240,180,0.9)' : 'rgba(255,174,87,0.75)';
        ctx.arc(x, y, 2.1, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Main entrance marker.
    const me = this.sceneData.map.mainEntrance;
    if (me) {
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(255,174,87,0.95)';
      ctx.lineWidth = 1.8;
      ctx.arc(mapX(me[0]), mapY(me[1]), 7, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Player.
    const x = mapX(px);
    const y = mapY(py);
    const ang = Math.atan2(fx, fy);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(6, 6);
    ctx.lineTo(0, 3.5);
    ctx.lineTo(-6, 6);
    ctx.closePath();
    ctx.fillStyle = '#74dcff';
    ctx.shadowColor = 'rgba(116,220,255,.9)';
    ctx.shadowBlur = 10;
    ctx.fill();
    ctx.restore();

    // North.
    ctx.fillStyle = 'rgba(232,246,255,0.7)';
    ctx.font = '10px Consolas, monospace';
    ctx.fillText('N', W - 18, 16);
    ctx.beginPath();
    ctx.moveTo(W - 13, 20);
    ctx.lineTo(W - 9, 28);
    ctx.lineTo(W - 17, 28);
    ctx.closePath();
    ctx.fill();
  }

  drawCompass(yawDeg, px, py, target) {
    const ctx = this.compassCtx;
    const W = this.el.compass.width, H = this.el.compass.height;
    ctx.clearRect(0, 0, W, H);
    const heading = ((360 - yawDeg) % 360 + 360) % 360;
    const pxPerDeg = 3.0;
    const cx = W / 2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let off = -90; off <= 90; off += 5) {
      const deg = ((heading + off) % 360 + 360) % 360;
      const x = cx + off * pxPerDeg;
      const major = deg % 90 === 0;
      const mid = deg % 30 === 0;
      ctx.strokeStyle = major ? 'rgba(232,246,255,0.9)' : mid ? 'rgba(232,246,255,0.45)' : 'rgba(232,246,255,0.18)';
      ctx.lineWidth = major ? 1.4 : 1;
      ctx.beginPath();
      ctx.moveTo(x, H - (major ? 20 : mid ? 12 : 8));
      ctx.lineTo(x, H - 3);
      ctx.stroke();
      if (major) {
        const names = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
        ctx.fillStyle = 'rgba(232,246,255,0.9)';
        ctx.font = '11px Consolas, monospace';
        ctx.fillText(names[deg], x, 8);
      }
    }
    if (target) {
      const dx = target[0] - px, dy = target[1] - py;
      const bearing = ((Math.atan2(dx, dy) * 180 / Math.PI) % 360 + 360) % 360;
      let off = bearing - heading;
      while (off > 180) off -= 360;
      while (off < -180) off += 360;
      const clamped = Math.max(-88, Math.min(88, off));
      const x = cx + clamped * pxPerDeg;
      ctx.beginPath();
      ctx.moveTo(x, H - 2);
      ctx.lineTo(x - 5, H - 11);
      ctx.lineTo(x + 5, H - 11);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,174,87,0.98)';
      ctx.shadowColor = 'rgba(255,174,87,.9)';
      ctx.shadowBlur = 8;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    ctx.fillStyle = 'rgba(255,174,87,0.95)';
    ctx.font = '11px Consolas, monospace';
    ctx.fillText(`${Math.round(heading).toString().padStart(3, '0')}°`, cx, 22);
  }

  update(state) {
    const { px, py, feet, yawDeg, fx, fy, doors, waypoint } = state;
    this.setWaypoint(waypoint, px, py, fx, fy);
    this.drawCompass(yawDeg, px, py, waypoint);
    const zone = this.zoneAt(px, py, feet);
    this.el.zoneLabel.textContent = zone.indoor ? '室内' : '室外';
    this.el.locationTag.textContent = zone.label;
    this.el.locationTag.classList.remove('hidden');
    this.el.coords.textContent = `X ${px.toFixed(1)} · Y ${py.toFixed(1)}`;
    const now = performance.now();
    if (now - this.lastMapUpdate > 100) {
      this.lastMapUpdate = now;
      this.drawMinimap(px, py, fx, fy, doors, now);
      if (!this.el.mapOverlay.classList.contains('hidden')) this.drawMinimap(px, py, fx, fy, doors, now, this.el.stationMap);
    }
    this.fpsFrames++;
    if (now - this.fpsTime > 500) {
      this.fpsValue = this.fpsFrames * 1000 / (now - this.fpsTime);
      this.fpsFrames = 0;
      this.fpsTime = now;
      this.el.fps.textContent = `${this.fpsValue.toFixed(0)} FPS`;
    }
  }

  setFps(fps) {
    this.el.fps.textContent = `${fps.toFixed(0)} FPS`;
  }
}
