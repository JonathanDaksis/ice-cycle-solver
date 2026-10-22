/* 3D four-stroke engine: cutaway model, free rotation, part selection and stroke animation.
   Needs THREE (r128) and THREE.TrackballControls loaded first. Mounts into #eng-view. */
(function () {
  const T = THREE;
  const host = document.getElementById('eng-view');
  host.querySelector('.eng-loading')?.remove();

  // ---------- renderer / camera / controls ----------
  const renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.domElement.className = 'eng-canvas';
  host.prepend(renderer.domElement);

  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(35, 1, 0.1, 500);
  const HOME = { pos: new T.Vector3(21, 8, 47), target: new T.Vector3(0, 0.3, 0) };
  camera.position.copy(HOME.pos);

  const controls = new T.TrackballControls(camera, renderer.domElement);
  controls.rotateSpeed = 3.2; controls.zoomSpeed = 1.2; controls.panSpeed = 0.9;
  controls.dynamicDampingFactor = 0.15; controls.minDistance = 4; controls.maxDistance = 140;
  controls.target.copy(HOME.target);

  scene.add(new T.HemisphereLight(0xffffff, 0x404a55, 0.85));
  const key = new T.DirectionalLight(0xffffff, 0.85); key.position.set(12, 22, 28); scene.add(key);
  const rim = new T.DirectionalLight(0xffffff, 0.45); rim.position.set(-18, -6, -14); scene.add(rim);
  const fill = new T.DirectionalLight(0xffffff, 0.25); fill.position.set(-10, 8, 20); scene.add(fill);

  // ---------- engine geometry constants (model units, bore radius ≈ 4) ----------
  const RC = 2.2;          // crank radius (stroke = 2·RC)
  const LROD = 7.5;        // connecting-rod length
  const YC = -9;           // crankshaft axis height
  const DECK = 3.2;        // top of the cylinder block
  const PISTON_R = 3.95;
  const DEG = Math.PI / 180;
  const VALVE_TILT = 23 * DEG;
  const VALVE_LEN = 7.6, CAM_BASE = 0.8, CAM_LIFT = 0.8;

  // ---------- component registry ----------
  const COMP = {
    camE:   { letter: 'E', name: 'Exhaust camshaft', color: 0xd9443a,
      info: 'Turns at half crankshaft speed and pushes the exhaust valve open once every two revolutions, during the exhaust stroke. Half speed is why a four-stroke engine completes one cycle per two revolutions, the <b>n/120</b> in Ẇ = W<sub>cycle</sub>·N·n/120.' },
    camI:   { letter: 'I', name: 'Intake camshaft', color: 0x3f8fe0,
      info: 'Turns at half crankshaft speed and opens the intake valve during the intake stroke so fresh air (or air–fuel mixture) fills the cylinder.' },
    spark:  { letter: 'S', name: 'Spark plug', color: 0xe9e4da,
      info: 'Fires near top dead centre at the end of compression. Combustion is so fast that the ideal Otto cycle models it as <b>constant-volume heat addition, 2–3</b>: q<sub>in</sub> = c<sub>v</sub>(T<sub>3</sub> − T<sub>2</sub>). A diesel engine has a fuel injector here instead, and its slower burn is modelled as constant-pressure heat addition.' },
    valveI: { letter: 'V', name: 'Intake valve', color: 0x3f8fe0,
      info: 'Opens during the intake stroke to let the charge in, then seals the chamber for compression and power. The spring closes it again. Intake and exhaust are not part of the closed air-standard cycle: the model replaces them with heat rejection 4–1.' },
    valveE: { letter: 'V', name: 'Exhaust valve', color: 0xd9443a,
      info: 'Opens near the end of the power stroke and stays open while the piston pushes the burnt gas out. In the ideal cycle this exhaust process is replaced by <b>constant-volume heat rejection 4–1</b>: q<sub>out</sub> = c<sub>v</sub>(T<sub>4</sub> − T<sub>1</sub>).' },
    water:  { letter: 'W', name: 'Water jacket', color: 0x3fae5a,
      info: 'Coolant passages around the cylinder and in the head. They carry heat away from the metal. This heat loss is one reason a real engine’s efficiency is well below the ideal η = 1 − 1/r<sup>k−1</sup>.' },
    piston: { letter: 'P', name: 'Piston', color: 0xe6cf45,
      info: 'Slides between top dead centre (TDC) and bottom dead centre (BDC). The volume it sweeps is the displacement <b>V<sub>d</sub> = (π/4)·D²·L</b>, with D the bore and L the stroke. Its rings seal the gas, and the gas pressure on its crown produces the work.' },
    rod:    { letter: 'R', name: 'Connecting rod', color: 0xc9973f,
      info: 'Links the piston pin to the crank pin and turns the piston’s up-and-down motion into rotation of the crankshaft.' },
    crank:  { letter: 'C', name: 'Crankshaft', color: 0x9b5fd0,
      info: 'Converts the reciprocating motion into rotation. The crank radius is half the stroke (L = 2 × crank radius). Its counterweights balance the rotating mass.' },
    head:   { letter: '', name: 'Cylinder head', color: 0xa9b0b7,
      info: 'Closes the top of the cylinder and holds the valves, camshafts and spark plug. The small space above the piston at TDC is the <b>clearance volume V<sub>2</sub></b>, which sets the compression ratio r = V<sub>1</sub>/V<sub>2</sub>.' },
    block:  { letter: '', name: 'Cylinder block', color: 0xb9c0c6,
      info: 'Holds the cylinder (bore diameter D) in which the piston moves, and the crankcase below. At BDC the cylinder holds the maximum volume <b>V<sub>1</sub> = V<sub>d</sub> + V<sub>2</sub></b>.' },
  };
  const ORDER = ['camE', 'camI', 'spark', 'valveE', 'valveI', 'water', 'piston', 'rod', 'crank', 'head', 'block'];
  const root = new T.Group(); scene.add(root);
  for (const k of ORDER) { const c = COMP[k]; c.group = new T.Group(); c.group.name = k; c.mats = new Map(); root.add(c.group); }

  function material(compKey, color, opts) {
    const c = COMP[compKey], id = color + JSON.stringify(opts || {});
    if (!c.mats.has(id)) {
      const m = new T.MeshStandardMaterial(Object.assign({ color, metalness: 0.25, roughness: 0.55, side: T.DoubleSide }, opts || {}));
      m.userData.base = { opacity: m.opacity, transparent: m.transparent, emissive: m.emissive.getHex() };
      c.mats.set(id, m);
    }
    return c.mats.get(id);
  }
  function add(compKey, geom, color, parent, opts, front) {
    const mesh = new T.Mesh(geom, material(compKey, color, opts));
    mesh.userData.comp = compKey;
    if (front) mesh.userData.front = true;
    (parent || COMP[compKey].group).add(mesh);
    return mesh;
  }

  // half annulus extruded upward; back half (z ≤ 0) or front half (z ≥ 0)
  function halfRing(ri, ro, y0, h, front) {
    const s = new T.Shape();
    if (!front) { s.moveTo(ro, 0); s.absarc(0, 0, ro, 0, Math.PI, false); s.lineTo(-ri, 0); s.absarc(0, 0, ri, Math.PI, 0, true); }
    else { s.moveTo(-ro, 0); s.absarc(0, 0, ro, Math.PI, 2 * Math.PI, false); s.lineTo(ri, 0); s.absarc(0, 0, ri, 2 * Math.PI, Math.PI, true); }
    const g = new T.ExtrudeGeometry(s, { depth: h, bevelEnabled: false, curveSegments: 40 });
    g.rotateX(-Math.PI / 2); g.translate(0, y0, 0);
    return g;
  }
  const along = (s, a, p) => [p[0] + a[0] * s, p[1] + a[1] * s];

  // ---------- cylinder block, crankcase, water jacket ----------
  const GREY = COMP.block.color;
  for (const front of [false, true]) {
    add('block', halfRing(4.02, 4.5, -6, 9.2, front), GREY, null, null, front);   // liner
    add('block', halfRing(5.2, 5.9, -6, 9.2, front), GREY, null, null, front);    // outer wall
    add('block', halfRing(4.02, 5.9, 2.4, 0.8, front), GREY, null, null, front);  // deck
    add('block', halfRing(4.5, 5.2, -4.9, 0.7, front), GREY, null, null, front);  // jacket floor
    add('block', halfRing(4.02, 6.6, -6.6, 0.6, front), GREY, null, null, front); // shoulder
    add('block', halfRing(5.9, 6.6, -13, 6.4, front), GREY, null, null, front);   // crankcase wall
    add('block', halfRing(6.6, 7.8, -13, 0.6, front), GREY, null, null, front);   // base flange
    add('water', halfRing(4.5, 5.2, -4.2, 6.6, front), COMP.water.color, null, { roughness: 0.4, metalness: 0 }, front);
  }

  // ---------- cylinder head (section profile extruded through the engine) ----------
  const aI = [Math.sin(VALVE_TILT), Math.cos(VALVE_TILT)];   // intake valve axis (up and to +x)
  const aE = [-aI[0], aI[1]];                                // exhaust valve axis (mirror)
  const seatI = [2.35, 3.9], seatE = [-2.35, 3.9];
  function headProfile() {
    const s = new T.Shape();
    s.moveTo(-7.2, DECK); s.lineTo(-4.0, DECK); s.lineTo(-0.7, 4.6); s.lineTo(0.7, 4.6); s.lineTo(4.0, DECK); s.lineTo(7.2, DECK);
    s.lineTo(7.2, 9.8); s.lineTo(0.55, 9.8); s.lineTo(0.55, 5.0); s.lineTo(-0.55, 5.0); s.lineTo(-0.55, 9.8); s.lineTo(-7.2, 9.8); s.lineTo(-7.2, DECK);
    // valve stem guide + spring pocket, for each valve
    for (const [a, p] of [[aI, seatI], [aE, seatE]]) {
      const n = [a[1], -a[0]];
      const pt = (sv, w) => { const c = along(sv, a, p); return new T.Vector2(c[0] + n[0] * w, c[1] + n[1] * w); };
      s.holes.push(new T.Path([pt(0.5, 0.32), pt(4.4, 0.32), pt(4.4, 0.95), pt(5.9, 0.95), pt(5.9, -0.95), pt(4.4, -0.95), pt(4.4, -0.32), pt(0.5, -0.32)]));
    }
    for (const b of WATER_BLOBS) { const h = new T.Path(); h.absellipse(b[0], b[1], b[2], b[3], 0, 2 * Math.PI, true); s.holes.push(h); }
    return s;
  }
  const WATER_BLOBS = [[5.9, 5.4, 0.7, 1.1], [-5.9, 5.4, 0.7, 1.1], [1.9, 7.6, 0.6, 0.8], [-1.9, 7.6, 0.6, 0.8]];
  const HEAD_D = 6.5;
  for (const front of [false, true]) {
    const g = new T.ExtrudeGeometry(headProfile(), { depth: HEAD_D, bevelEnabled: false, curveSegments: 24 });
    g.translate(0, 0, front ? 0 : -HEAD_D);
    add('head', g, COMP.head.color, null, null, front);
    for (const b of WATER_BLOBS) {
      const ws = new T.Shape(); ws.absellipse(b[0], b[1], b[2], b[3], 0, 2 * Math.PI, false);
      const wg = new T.ExtrudeGeometry(ws, { depth: HEAD_D, bevelEnabled: false, curveSegments: 24 });
      wg.translate(0, 0, front ? 0 : -HEAD_D);
      add('water', wg, COMP.water.color, null, { roughness: 0.4, metalness: 0 }, front);
    }
  }

  // ---------- spark plug ----------
  const plug = COMP.spark.group;
  const cyl = (rt, rb, h, seg) => new T.CylinderGeometry(rt, rb, h, seg || 24);
  let m = add('spark', cyl(0.42, 0.42, 4.6), 0xf1ede4, plug, { roughness: 0.35, metalness: 0 }); m.position.y = 7.6;      // insulator
  m = add('spark', cyl(0.78, 0.78, 0.7, 6), 0x8d949b, plug, { metalness: 0.7, roughness: 0.35 }); m.position.y = 10.15;     // hex
  m = add('spark', cyl(0.5, 0.5, 4.3), 0x8d949b, plug, { metalness: 0.7, roughness: 0.35 }); m.position.y = 7.15;            // threaded body
  m = add('spark', cyl(0.18, 0.18, 0.9), 0x6d7378, plug, { metalness: 0.8 }); m.position.y = 12.3;                           // terminal
  m = add('spark', cyl(0.3, 0.3, 1.5), 0xf1ede4, plug, { roughness: 0.35, metalness: 0 }); m.position.y = 11.2;
  m = add('spark', cyl(0.07, 0.07, 0.5), 0x5c6166, plug, { metalness: 0.9 }); m.position.y = 4.75;                           // electrode
  const sparkGlow = new T.Mesh(new T.SphereGeometry(0.42, 16, 12), new T.MeshBasicMaterial({ color: 0xffc46b, transparent: true, opacity: 0 }));
  sparkGlow.position.set(0, 4.45, 0); scene.add(sparkGlow);
  const sparkLight = new T.PointLight(0xff9a3c, 0, 14); sparkLight.position.set(0, 4.2, 0); scene.add(sparkLight);

  // ---------- valves + springs ----------
  function buildValve(compKey, seat, axis) {
    const g = COMP[compKey].group, color = COMP[compKey].color;
    const frame = new T.Group(); frame.position.set(seat[0], seat[1], 0);
    frame.rotation.z = -Math.atan2(axis[0], axis[1]);
    g.add(frame);
    const mover = new T.Group(); frame.add(mover);
    let v = add(compKey, cyl(0.17, 0.17, VALVE_LEN), color, mover, { metalness: 0.6, roughness: 0.35 }); v.position.y = VALVE_LEN / 2;
    v = add(compKey, cyl(0.3, 1.25, 0.42, 40), color, mover, { metalness: 0.6, roughness: 0.35 }); v.position.y = 0.02;     // head
    v = add(compKey, cyl(0.65, 0.65, 0.16), color, mover, { metalness: 0.6, roughness: 0.35 }); v.position.y = 7.3;        // retainer
    const pts = []; for (let i = 0; i <= 240; i++) { const t = i / 240, ang = t * Math.PI * 2 * 6; pts.push(new T.Vector3(0.55 * Math.cos(ang), t * 2.7, 0.55 * Math.sin(ang))); }
    const spring = add(compKey, new T.TubeGeometry(new T.CatmullRomCurve3(pts), 480, 0.08, 6, false), 0x6f777e, frame, { metalness: 0.7, roughness: 0.3 });
    spring.position.y = 4.6;
    return { mover, spring, axis };
  }
  const VALVE = { I: buildValve('valveI', seatI, aI), E: buildValve('valveE', seatE, aE) };

  // ---------- camshafts ----------
  function camRadius(phi) { // phi = angle from the nose
    const d = Math.atan2(Math.sin(phi), Math.cos(phi));
    return CAM_BASE + (Math.abs(d) < Math.PI / 4 ? CAM_LIFT * Math.pow(Math.cos(2 * d), 2) : 0);
  }
  function buildCam(compKey, seat, axis) {
    const g = COMP[compKey].group, color = COMP[compKey].color;
    const c = along(VALVE_LEN + CAM_BASE, axis, seat);
    const shaft = new T.Group(); shaft.position.set(c[0], c[1], 0); g.add(shaft);
    let s = add(compKey, cyl(0.42, 0.42, 9.5), 0x7a8288, shaft, { metalness: 0.75, roughness: 0.3 }); s.rotation.x = Math.PI / 2; s.position.z = -1.6;
    const lobe = new T.Shape();
    for (let i = 0; i <= 96; i++) { const p = i / 96 * Math.PI * 2, r = camRadius(p); i ? lobe.lineTo(r * Math.cos(p), r * Math.sin(p)) : lobe.moveTo(r, 0); }
    const lg = new T.ExtrudeGeometry(lobe, { depth: 0.9, bevelEnabled: false }); lg.translate(0, 0, -0.45);
    add(compKey, lg, color, shaft, { metalness: 0.5, roughness: 0.35 });
    s = add(compKey, cyl(0.95, 0.95, 0.9, 32), color, shaft, { metalness: 0.4, roughness: 0.4 }); s.rotation.x = Math.PI / 2; s.position.z = 2.4;   // front cap
    s = add(compKey, cyl(0.95, 0.95, 0.9, 32), color, shaft, { metalness: 0.4, roughness: 0.4 }); s.rotation.x = Math.PI / 2; s.position.z = -4.2;
    return { shaft, toValve: Math.atan2(-axis[1], -axis[0]) };
  }
  const CAM = { I: buildCam('camI', seatI, aI), E: buildCam('camE', seatE, aE) };

  // ---------- piston ----------
  const piston = new T.Group(); COMP.piston.group.add(piston);
  m = add('piston', cyl(PISTON_R, PISTON_R, 4.6, 56), COMP.piston.color, piston, { metalness: 0.45, roughness: 0.4 }); m.position.y = -0.1;
  for (const y of [1.85, 1.45, 1.05]) {
    const r = add('piston', new T.TorusGeometry(PISTON_R + 0.02, 0.1, 8, 64), 0xb59a22, piston, { metalness: 0.6, roughness: 0.3 });
    r.rotation.x = Math.PI / 2; r.position.y = y;
  }
  m = add('piston', cyl(0.55, 0.55, 7.9), 0x8d949b, piston, { metalness: 0.8, roughness: 0.25 }); m.rotation.x = Math.PI / 2;   // gudgeon pin

  // ---------- connecting rod ----------
  const rod = new T.Group(); COMP.rod.group.add(rod);
  const RODC = COMP.rod.color, rodOpt = { metalness: 0.55, roughness: 0.4 };
  m = add('rod', cyl(1.1, 1.1, 1.2, 32), RODC, rod, rodOpt); m.rotation.x = Math.PI / 2;
  m = add('rod', new T.BoxGeometry(0.8, LROD - 1.6, 0.6), RODC, rod, rodOpt); m.position.y = LROD / 2;
  m = add('rod', cyl(0.75, 0.75, 1.0, 28), RODC, rod, rodOpt); m.rotation.x = Math.PI / 2; m.position.y = LROD;
  m = add('rod', new T.BoxGeometry(2.6, 0.35, 1.1), RODC, rod, rodOpt); m.position.y = -0.95;   // big-end cap

  // ---------- crankshaft ----------
  const crank = new T.Group(); crank.position.set(0, YC, 0); COMP.crank.group.add(crank);
  const CR = COMP.crank.color, crOpt = { metalness: 0.5, roughness: 0.35 };
  for (const z of [-0.95, 0.95]) {
    m = add('crank', new T.BoxGeometry(2.2, 3.6, 0.5), CR, crank, crOpt); m.position.set(0, 1.0, z);
    const cw = new T.CylinderGeometry(2.6, 2.6, 0.5, 40, 1, false, -Math.PI / 2, Math.PI); cw.rotateX(Math.PI / 2);
    m = add('crank', cw, CR, crank, crOpt); m.position.z = z;
  }
  m = add('crank', cyl(0.8, 0.8, 2.4, 28), CR, crank, crOpt); m.rotation.x = Math.PI / 2; m.position.y = RC;          // crank pin
  m = add('crank', cyl(1.05, 1.05, 4.0, 32), CR, crank, crOpt); m.rotation.x = Math.PI / 2; m.position.z = 3.2;       // front journal
  m = add('crank', cyl(1.05, 1.05, 4.0, 32), CR, crank, crOpt); m.rotation.x = Math.PI / 2; m.position.z = -3.2;      // rear journal
  m = add('crank', cyl(2.0, 2.0, 1.2, 40), CR, crank, crOpt); m.rotation.x = Math.PI / 2; m.position.z = 5.6;         // front pulley

  // ---------- gas charge (visual only) ----------
  const gas = new T.Mesh(new T.CylinderGeometry(3.9, 3.9, 1, 48), new T.MeshBasicMaterial({ color: 0x6fb6ff, transparent: true, opacity: 0.25, depthWrite: false }));
  scene.add(gas);

  // ---------- kinematics ----------
  const STROKES = [
    { name: 'Intake', from: 0, sub: 'Intake valve open · piston moves down and draws in air', ideal: 'Not part of the closed air-standard cycle' },
    { name: 'Compression', from: 180, sub: 'Both valves closed · piston moves up', ideal: 'Ideal process <b>1–2</b>: isentropic compression' },
    { name: 'Power', from: 360, sub: 'Spark at TDC · gas pushes the piston down', ideal: 'Ideal <b>2–3</b>: heat addition, then <b>3–4</b>: isentropic expansion' },
    { name: 'Exhaust', from: 540, sub: 'Exhaust valve open · piston pushes gas out', ideal: 'Ideal <b>4–1</b>: constant-volume heat rejection' },
  ];
  const GASCOL = [0x6fb6ff, 0x5a8fe8, 0xff8a3d, 0x9aa3ab];
  const wrapPI = a => Math.atan2(Math.sin(a), Math.cos(a));
  function valveLift(thetaDeg, midDeg) { const d = wrapPI((thetaDeg - midDeg) * DEG / 2); return camRadius(d) - CAM_BASE; }
  const state = { theta: 0, playing: true, speed: 90, sel: null, mode: 'all', cutaway: true, labels: true };

  function pose(thetaDeg) {
    const th = thetaDeg * DEG, sn = Math.sin(th), cs = Math.cos(th);
    const pinY = YC + RC * cs + Math.sqrt(LROD * LROD - RC * RC * sn * sn);
    piston.position.set(0, pinY, 0);
    crank.rotation.z = -th;
    const bx = RC * sn, by = YC + RC * cs;
    rod.position.set(bx, by, 0);
    rod.rotation.z = -Math.atan2(0 - bx, pinY - by);
    for (const [k, mid] of [['I', 90], ['E', 630]]) {
      const lift = valveLift(thetaDeg, mid);
      VALVE[k].mover.position.y = -lift;
      VALVE[k].spring.scale.y = (2.7 - lift) / 2.7;
      CAM[k].shaft.rotation.z = CAM[k].toValve - wrapPI((thetaDeg - mid) * DEG / 2);
    }
    const top = pinY + 2.2, h = DECK - top;
    gas.visible = h > 0.05 && COMP.block.group.visible && state.mode !== 'alone';
    gas.scale.y = Math.max(h, 0.01); gas.position.y = top + h / 2;
    const si = Math.floor((((thetaDeg % 720) + 720) % 720) / 180);
    gas.material.color.setHex(GASCOL[si]);
    const sinceSpark = (((thetaDeg - 352) % 720) + 720) % 720;
    const glow = sinceSpark < 40 ? 1 - sinceSpark / 40 : 0;
    sparkGlow.material.opacity = glow; sparkLight.intensity = glow * 3;
    if (si === 2) gas.material.opacity = 0.18 + 0.4 * Math.max(0, 1 - sinceSpark / 160); else gas.material.opacity = 0.22;
    return si;
  }

  // ---------- UI: stroke readout, slider, play ----------
  const $ = id => document.getElementById(id);
  const strokeEl = $('eng-stroke'), slider = $('eng-angle'), angleOut = $('eng-angle-out'), playBtn = $('eng-play');
  let lastStroke = -1;
  function showStroke(si) {
    const t = state.theta % 720;
    angleOut.textContent = `${Math.round(t)}°`;
    slider.value = Math.round(t);
    if (si === lastStroke) return; lastStroke = si;
    const s = STROKES[si];
    strokeEl.innerHTML = `<span class="eng-sn">${si + 1}/4</span><b>${s.name} stroke</b><span>${s.sub}</span><em>${s.ideal}</em>`;
  }
  playBtn.addEventListener('click', () => { state.playing = !state.playing; playBtn.textContent = state.playing ? 'Pause' : 'Play'; playBtn.setAttribute('aria-pressed', state.playing); });
  slider.addEventListener('input', () => { state.theta = +slider.value; state.playing = false; playBtn.textContent = 'Play'; playBtn.setAttribute('aria-pressed', 'false'); });
  document.querySelectorAll('#eng-speed [data-speed]').forEach(b => b.addEventListener('click', () => {
    state.speed = +b.dataset.speed;
    document.querySelectorAll('#eng-speed [data-speed]').forEach(x => x.setAttribute('aria-pressed', x === b));
  }));

  // ---------- parts list + info ----------
  const hex = c => '#' + c.toString(16).padStart(6, '0');
  const list = $('eng-parts');
  list.innerHTML = ORDER.map(k => `<button type="button" class="part" data-part="${k}" aria-pressed="false"><span class="sw" style="background:${hex(COMP[k].color)}"></span><span class="pl">${COMP[k].letter || '·'}</span><span class="pn">${COMP[k].name}</span></button>`).join('');
  list.addEventListener('click', e => { const b = e.target.closest('[data-part]'); if (b) select(b.dataset.part, state.sel === b.dataset.part && state.mode === 'focus' ? 'alone' : 'focus'); });
  const info = $('eng-info');
  function renderInfo() {
    list.querySelectorAll('[data-part]').forEach(b => b.setAttribute('aria-pressed', b.dataset.part === state.sel));
    if (!state.sel) {
      info.innerHTML = '<p class="note">Click a part on the model or in the list to see what it does. Double-click a part to view it on its own.</p>';
      return;
    }
    const c = COMP[state.sel];
    info.innerHTML = `<div class="ihead"><span class="sw" style="background:${hex(c.color)}"></span>${c.letter ? `<span class="pl">${c.letter}</span>` : ''}<b>${c.name}</b></div><p>${c.info}</p>
      <div class="toolbar">${state.mode === 'alone' ? '<button class="btn" type="button" data-act="focus">Back to engine</button>' : '<button class="btn primary" type="button" data-act="alone">View alone</button>'}<button class="btn" type="button" data-act="all">Show all parts</button></div>`;
  }
  info.addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (!b) return; const a = b.dataset.act; if (a === 'all') select(null); else select(state.sel, a); });

  // ---------- visibility / highlighting ----------
  function applyVis() {
    for (const k of ORDER) {
      const c = COMP[k];
      c.group.visible = state.mode !== 'alone' || k === state.sel;
      const dim = state.mode === 'focus' && state.sel && k !== state.sel;
      const hi = state.sel === k && state.mode === 'focus';
      for (const mat of c.mats.values()) {
        const b = mat.userData.base;
        mat.transparent = dim ? true : b.transparent; mat.opacity = dim ? 0.13 : b.opacity; mat.depthWrite = !dim;
        mat.emissive.setHex(hi ? 0x3a1a05 : (k === hoverKey && !dim ? 0x1e1e1e : b.emissive));
        mat.needsUpdate = true;
      }
      c.group.traverse(o => { if (o.userData.front) o.visible = !state.cutaway; });
    }
    renderLabelsVisibility();
  }
  function select(k, mode) {
    state.sel = k; state.mode = k ? (mode || 'focus') : 'all';
    applyVis(); renderInfo();
    if (k && state.mode === 'alone') frame(COMP[k].group); else if (!k) flyTo(HOME.pos.clone(), HOME.target.clone());
  }

  // ---------- camera moves ----------
  let fly = null;
  function flyTo(pos, target) { fly = { p0: camera.position.clone(), t0: controls.target.clone(), p1: pos, t1: target, start: performance.now(), dur: 650 }; }
  function frame(obj) {
    const box = new T.Box3();
    obj.traverse(o => { if (o.isMesh && (!o.userData.front || !state.cutaway)) box.expandByObject(o); });
    if (box.isEmpty()) return;
    const c = box.getCenter(new T.Vector3()), size = box.getSize(new T.Vector3()).length();
    const dist = Math.max(size / (2 * Math.tan(camera.fov * DEG / 2)) * 1.15, 6);
    const dir = camera.position.clone().sub(controls.target).normalize();
    flyTo(c.clone().add(dir.multiplyScalar(dist)), c);
  }
  $('eng-reset').addEventListener('click', () => { camera.up.set(0, 1, 0); flyTo(HOME.pos.clone(), HOME.target.clone()); });

  // ---------- toggles ----------
  const tCut = $('eng-cutaway'), tLab = $('eng-labels-t');
  tCut.addEventListener('change', () => { state.cutaway = tCut.checked; applyVis(); });
  tLab.addEventListener('change', () => { state.labels = tLab.checked; renderLabelsVisibility(); });

  // ---------- labels (letters like the reference diagram) ----------
  const labelHost = $('eng-labels');
  const tmp = new T.Vector3();
  const ANCH = {
    camE: () => CAM.E.shaft.localToWorld(tmp.set(0, 0, 2.9)),
    camI: () => CAM.I.shaft.localToWorld(tmp.set(0, 0, 2.9)),
    spark: () => tmp.set(0, 12.9, 0),
    valveE: () => VALVE.E.mover.localToWorld(tmp.set(0, 2.2, 0)),
    valveI: () => VALVE.I.mover.localToWorld(tmp.set(0, 2.2, 0)),
    water: () => tmp.set(-4.85, -0.5, 0.05),
    piston: () => piston.localToWorld(tmp.set(PISTON_R, -0.6, 0)),
    rod: () => rod.localToWorld(tmp.set(0.4, LROD * 0.45, 0.3)),
    crank: () => tmp.set(0, YC, 6.2),
  };
  const LBL = {};
  for (const k in ANCH) { const el = document.createElement('span'); el.className = 'elab'; el.textContent = COMP[k].letter; labelHost.appendChild(el); LBL[k] = el; }
  function renderLabelsVisibility() { for (const k in LBL) LBL[k].hidden = !state.labels || !COMP[k].group.visible; }
  function placeLabels() {
    if (!state.labels) return;
    const w = host.clientWidth, h = host.clientHeight;
    for (const k in ANCH) {
      const el = LBL[k]; if (el.hidden) continue;
      const v = ANCH[k]().clone().project(camera);
      const off = v.z > 1 || v.z < -1;
      el.style.visibility = off ? 'hidden' : 'visible';
      el.style.transform = `translate(${(v.x * 0.5 + 0.5) * w}px, ${(-v.y * 0.5 + 0.5) * h}px) translate(-50%,-50%)`;
    }
  }

  // ---------- picking ----------
  const ray = new T.Raycaster(), ndc = new T.Vector2();
  function visibleChain(o) { for (; o; o = o.parent) if (!o.visible) return false; return true; }
  function pick(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObject(root, true).filter(h => visibleChain(h.object) && !(state.mode === 'focus' && h.object.userData.comp !== state.sel && h.object.material.opacity < 0.5));
    return hits.length ? hits[0].object.userData.comp : null;
  }
  let down = null, hoverKey = null, hoverReq = false, lastMove = null;
  const cvs = renderer.domElement;
  cvs.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
  cvs.addEventListener('pointerup', e => {
    if (!down) return; const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y); down = null;
    if (moved > 5) return;
    const k = pick(e);
    if (k) select(k, state.mode === 'alone' && k === state.sel ? 'alone' : 'focus'); else if (state.mode !== 'alone') select(null);
  });
  cvs.addEventListener('dblclick', e => { const k = pick(e); if (k) select(k, 'alone'); });
  cvs.addEventListener('pointermove', e => { if (e.buttons) return; lastMove = e; if (!hoverReq) { hoverReq = true; requestAnimationFrame(doHover); } });
  cvs.addEventListener('pointerleave', () => { if (hoverKey) { hoverKey = null; applyVis(); } cvs.style.cursor = ''; });
  function doHover() {
    hoverReq = false; if (!lastMove) return;
    const k = pick(lastMove);
    cvs.style.cursor = k ? 'pointer' : 'grab';
    if (k !== hoverKey) { hoverKey = k; applyVis(); }
  }
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && host.offsetParent && state.sel) select(null); });

  // ---------- resize + loop ----------
  function resize() {
    const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); controls.handleResize();
  }
  new ResizeObserver(resize).observe(host); resize();
  const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  let last = performance.now();
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { state.playing = false; playBtn.textContent = 'Play'; playBtn.setAttribute('aria-pressed', 'false'); state.theta = 200; }
  function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min((now - last) / 1000, 0.1); last = now;
    if (!host.offsetParent) return;          // tab hidden: skip work
    if (state.playing) state.theta = (state.theta + state.speed * dt) % 720;
    const si = pose(state.theta); showStroke(si);
    if (fly) {
      const t = Math.min(Math.max((performance.now() - fly.start) / fly.dur, 0), 1), e = ease(t);
      camera.position.lerpVectors(fly.p0, fly.p1, e); controls.target.lerpVectors(fly.t0, fly.t1, e);
      if (t >= 1) fly = null;
    }
    controls.update();
    renderer.render(scene, camera);
    placeLabels();
  }
  applyVis(); renderInfo(); requestAnimationFrame(loop);
})();
