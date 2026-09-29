(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const W = 1280, H = 720, COLS = 32, ROWS = 18;
  const { clamp, Tracker } = IceGesture;
  const stage = $('stage'), ctx = stage.getContext('2d');
  const video = $('cameraVideo'), preview = $('cameraPreview'), previewCtx = preview.getContext('2d');
  const tracker = new Tracker();
  const makeCanvas = () => Object.assign(document.createElement('canvas'), { width: W, height: H });
  const layers = Array.from({ length: 3 }, () => ({ texture: makeCanvas(), mask: makeCanvas(), surface: makeCanvas(), edges: [], coverage: 0 }));
  const bones = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[0,17],[17,18],[18,19],[19,20]];
  let interaction = null, dirty = true, imageRevision = 0, noticeTimer;
  let currentPage = 0, transition = null;
  const handOverlay = $('handOverlay'), handCtx = handOverlay.getContext('2d');
  handOverlay.width = W; handOverlay.height = H;
  const particleOverlay = $('particleOverlay'), particleCtx = particleOverlay.getContext('2d');
  particleOverlay.width = W; particleOverlay.height = H;
  const particles = [];
  let tearSerial = 0, effectWasActive = false;
  const FIXED_STEP = 1 / 60;
  let physicsAccumulator = 0;
  let cameraEpoch = 0, cameraOn = false, stream = null, model = null, pendingSend = null;
  let scriptPromise = null, lastResultAt = 0;

  function notice(message) {
    clearTimeout(noticeTimer);
    $('toast').textContent = message;
    $('toast').hidden = false;
    noticeTimer = setTimeout(() => { $('toast').hidden = true; }, 6000);
  }
  function cover(canvas, image) {
    const c = canvas.getContext('2d');
    const scale = Math.max(W / image.width, H / image.height);
    c.clearRect(0, 0, W, H);
    c.fillStyle = '#173d4b'; c.fillRect(0,0,W,H);
    c.drawImage(image, (W - image.width * scale) / 2, (H - image.height * scale) / 2, image.width * scale, image.height * scale);
  }
  function procedural(canvas, index) {
    const c = canvas.getContext('2d');
    const gradient = c.createLinearGradient(0, 0, W, H);
    gradient.addColorStop(0, ['#dceff0','#80b7c7','#163843'][index]);
    gradient.addColorStop(1, ['#70a0b7','#285769','#071c26'][index]);
    c.fillStyle = gradient; c.fillRect(0, 0, W, H);
    let seed = 711 + index;
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 180; i++) {
      let x = random() * W, y = random() * H;
      c.beginPath(); c.moveTo(x, y);
      for (let j = 0; j < 8; j++) { x += (random() - .45) * 160; y += (random() - .5) * 110; c.lineTo(x, y); }
      c.strokeStyle = `rgba(237,255,255,${.04 + random() * .22})`; c.lineWidth = .5 + random() * 2; c.stroke();
    }
  }
  function reset() {
    interaction = null; transition = null; currentPage = 0; tracker.reset(true);
    particles.length = 0; particleCtx.clearRect(0,0,W,H); effectWasActive = false; physicsAccumulator = 0;
    for (const layer of layers) { layer.mask.getContext('2d').clearRect(0, 0, W, H); layer.edges = []; layer.coverage=0; }
    setProgress(0); dirty = true;
  }
  function loadImage(src) {
    return new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = src; });
  }
  layers.forEach((layer, i) => procedural(layer.texture, i));
  const initialRevision = imageRevision;
  Promise.allSettled([1,2,3].map(i => loadImage(`assets/白色冰层-${i}.png`))).then(results => {
    if (imageRevision !== initialRevision) return;
    results.forEach((result, i) => { if (result.status === 'fulfilled') cover(layers[i].texture, result.value); });
    dirty = true;
  });
  $('uploadButton').onclick = () => $('fileInput').click();
  $('fileInput').onchange = async event => {
    const files = Array.from(event.target.files).slice(0, 3);
    if (!files.length) return;
    const revision = ++imageRevision;
    const urls = files.map(file => URL.createObjectURL(file));
    try {
      const results = await Promise.allSettled(urls.map(loadImage));
      if (revision !== imageRevision) return;
      const images = results.filter(r => r.status === 'fulfilled').map(r => r.value);
      if (!images.length) throw new Error('没有可读取的图片');
      layers.forEach((layer, i) => cover(layer.texture, images[Math.min(i, images.length - 1)]));
      reset();
      if (images.length !== files.length) notice('部分图片无法读取，已使用其余图片。');
    } catch (error) { notice(error.message); }
    finally { urls.forEach(url => URL.revokeObjectURL(url)); event.target.value = ''; }
  };
  $('resetButton').onclick = reset;

  function newMesh(seed) {
    const points = [], links = [];
    for (let y = 0; y <= ROWS; y++) for (let x = 0; x <= COLS; x++) {
      const ox = x * W / COLS + (x>0&&x<COLS ? roughNoise(x*.67+y*1.39,seed+22)*4.5 : 0);
      const oy = y * H / ROWS + (y>0&&y<ROWS ? roughNoise(x*1.61+y*.83,seed+41)*3.4 : 0);
      points.push({ ox, oy, x: ox, y: oy, px: ox, py: oy, fixed: !x || !y || x === COLS || y === ROWS });
    }
    const link = (a, b, shear = false) => links.push({ a, b, length: Math.hypot(points[a].x - points[b].x, points[a].y - points[b].y), broken: false, shear, fractureAt:1.5+((roughNoise(a*.71+b*.29,seed+77)+1)/2)*.42 });
    for (let y = 0; y <= ROWS; y++) for (let x = 0; x <= COLS; x++) {
      const a = y * (COLS + 1) + x;
      if (x < COLS) link(a, a + 1);
      if (y < ROWS) link(a, a + COLS + 1);
      if (x < COLS && y < ROWS) { link(a, a + COLS + 2, true); link(a + 1, a + COLS + 1, true); }
    }
    return { points, links, broken: 0 };
  }
  function begin(type, anchors, direction = { x: 1, y: 0 }) {
    if (transition) return;
    finish();
    if (transition) return;
    const center = { x: anchors.reduce((sum, p) => sum + p.x, 0) / anchors.length, y: anchors.reduce((sum, p) => sum + p.y, 0) / anchors.length };
    const seed=++tearSerial*137.31;
    interaction = { type, anchors, center, direction, layer: currentPage, mesh: newMesh(seed), target: 0, progress: 0, peak: 0, path: null, released: false, delta: { x: 0, y: 0 }, pull: { x:0, y:0 }, seed, rimPoints: [], releaseTime: 0 };
    physicsAccumulator = 0;
    dirty = true;
  }
  function finish() {
    if (!interaction || interaction.released) return;
    const s = interaction;
    if (s.path) {
      const layer=layers[s.layer], mask=layer.mask.getContext('2d');
      renderCracks(mask,s,true);
      layer.coverage=measureCoverage(layer.mask);
      if(layer.coverage>=.5) transition = { elapsed: 0, from: Math.max(0, (s.peak - .24) / .76) };
      tracker.reset(true);
    }
    s.released = true; s.target = 0; dirty = true;
  }
  function roughNoise(x, seed) {
    const hash = n => { const h = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453; return (h - Math.floor(h)) * 2 - 1; };
    const n = Math.floor(x), t = x - n, ease = t * t * (3 - 2 * t);
    return hash(n) * (1 - ease) + hash(n + 1) * ease;
  }
  function tearPath(s, amount) {
    const path = new Path2D(), fibers = new Path2D(), normal = { x: -s.direction.y, y: s.direction.x };
    const length = 45 + Math.pow(amount, .65) * H * .57;
    const width = 2 + Math.pow(amount, 1.35) * W * .31;
    const rimPoints = [], samples = 280;
    for (let side = -1; side <= 1; side += 2) {
      for (let j = 0; j <= samples; j++) {
        const t = side === -1 ? -1 + j * 2 / samples : 1 - j * 2 / samples;
        const seed = s.seed + side * 47;
        const taper = Math.pow(Math.max(0, 1 - t * t), .62);
        const large = roughNoise(t * 7, seed), medium = roughNoise(t * 29, seed + 3), fine = roughNoise(t * 113, seed + 8);
        const wander = roughNoise(t * 3.8, s.seed) * Math.min(80, length * .24) * taper;
        const roughness = (large * 22 + medium * 12 + fine * 6) * taper;
        const edgeWidth = Math.max(.45 * taper, width * taper * (1 + large * .24) + roughness);
        const across = wander + side * edgeWidth;
        const along = t * length + medium * 6 * taper;
        const x = s.center.x + normal.x * along + s.direction.x * across;
        const y = s.center.y + normal.y * along + s.direction.y * across;
        if (side === -1 && j === 0) path.moveTo(x, y); else path.lineTo(x, y);
        if (j % 2 === 0 && taper > .08) {
          const strand = (4 + (fine + 1) * 6) * taper;
          const lean = medium * 7;
          fibers.moveTo(x + side * s.direction.x, y + side * s.direction.y);
          fibers.lineTo(x - side * s.direction.x * strand + normal.x * lean, y - side * s.direction.y * strand + normal.y * lean);
          rimPoints.push({ x,y,nx:side*s.direction.x,ny:side*s.direction.y });
        }
      }
    }
    s.fibers = fibers; s.rimPoints = rimPoints; path.closePath(); return path;
  }
  function emitPaper(x,y,nx,ny,count=4,energy=1) {
    if (x < -20 || x > W+20 || y < -20 || y > H+20) return;
    for (let i=0;i<count && particles.length<360;i++) {
      const angle = Math.random()*Math.PI*2, speed = (25+Math.random()*110)*energy;
      const life = .48+Math.random()*.8, fiber = Math.random()>.38;
      particles.push({x,y,vx:nx*speed+Math.cos(angle)*55,vy:ny*speed+Math.sin(angle)*65-25,life,maxLife:life,size:fiber?2+Math.random()*5.5:.8+Math.random()*1.5,fiber,angle,spin:(Math.random()-.5)*14});
    }
  }
  function emitRim(s,count) {
    if (!s.rimPoints.length) return;
    for (let i=0;i<count;i++) {
      const p=s.rimPoints[Math.floor(Math.random()*s.rimPoints.length)];
      emitPaper(p.x,p.y,p.nx,p.ny,1,.65+s.progress);
    }
  }
  function updateParticles(dt) {
    if (!particles.length && !effectWasActive) return;
    particleCtx.clearRect(0,0,W,H);
    for (let i=particles.length-1;i>=0;i--) {
      const p=particles[i]; p.life-=dt;
      if(p.life<=0){particles.splice(i,1);continue;}
      p.vx*=Math.exp(-dt*1.9); p.vy+=75*dt; p.x+=p.vx*dt; p.y+=p.vy*dt; p.angle+=p.spin*dt;
      particleCtx.save(); particleCtx.translate(p.x,p.y); particleCtx.rotate(p.angle);
      particleCtx.globalAlpha=clamp(p.life/p.maxLife*2)*.9;
      particleCtx.shadowColor='rgba(9,49,66,.5)'; particleCtx.shadowBlur=2; particleCtx.shadowOffsetY=1;
      particleCtx.fillStyle='#fff'; particleCtx.strokeStyle='#f1ffff';
      if(p.fiber){
        particleCtx.lineWidth=1.1+Math.abs(Math.sin(p.angle))*.9;
        particleCtx.beginPath(); particleCtx.moveTo(-p.size,0); particleCtx.quadraticCurveTo(0,-p.size*.65,p.size,.5); particleCtx.stroke();
      } else {particleCtx.beginPath();particleCtx.arc(0,0,p.size,0,Math.PI*2);particleCtx.fill();}
      particleCtx.restore();
    }
    effectWasActive=particles.length>0;
    if (!effectWasActive) particleCtx.clearRect(0,0,W,H);
  }
  function physics(s, dt) {
    s.progress += (s.target - s.progress) * (1 - Math.exp(-dt / .085));
    const follow = 1 - Math.exp(-dt / .06);
    s.pull.x += (s.delta.x-s.pull.x)*follow; s.pull.y += (s.delta.y-s.pull.y)*follow;
    if(s.released)s.releaseTime+=dt;
    const { points, links } = s.mesh;
    for (const p of points) {
      if (p.fixed) continue;
      const vx = (p.x - p.px) * .9, vy = (p.y - p.py) * .9;
      p.px = p.x; p.py = p.y;
      p.x += vx + (p.ox - p.x) * .018;
      p.y += vy + (p.oy - p.y) * .018;
    }
    const grip = () => {
      if (s.released) return;
      s.anchors.forEach((anchor, i) => {
        const sign = i === 0 ? -1 : 1;
        const dx = s.type === 'mouse' ? s.pull.x : sign * s.direction.x * W * .23 * s.progress;
        const dy = s.type === 'mouse' ? s.pull.y : sign * s.direction.y * W * .23 * s.progress;
        for (const p of points) {
          if (p.fixed) continue;
          const distance = Math.hypot(p.ox - anchor.x, p.oy - anchor.y);
          if (distance > 140) continue;
          const weight = Math.pow(1 - distance / 140, 2) * .72;
          p.x += (p.ox + dx - p.x) * weight; p.y += (p.oy + dy - p.y) * weight;
        }
      });
    };
    grip();
    let burstCount = 0;
    for (let iteration = 0; iteration < 4; iteration++) {
      for (const link of links) {
        if (link.broken) continue;
        const a = points[link.a], b = points[link.b], dx = b.x - a.x, dy = b.y - a.y;
        const length = Math.hypot(dx, dy) || .001;
        if (!s.released && s.progress > .24 && length / link.length > link.fractureAt) {
          link.broken = true; s.mesh.broken++;
          if (burstCount++<8) emitPaper((a.x+b.x)/2,(a.y+b.y)/2,dx/length,dy/length,4,s.progress+.5);
          continue;
        }
        const correction = (length - link.length) / length * (link.shear ? .18 : .4);
        if (!a.fixed) { a.x += dx * correction; a.y += dy * correction; }
        if (!b.fixed) { b.x -= dx * correction; b.y -= dy * correction; }
      }
      grip();
    }
    if (!s.released && s.mesh.broken && s.progress > .24 && s.progress > s.peak) {
      const growth = s.progress-s.peak;
      s.peak = s.progress; s.path = tearPath(s, (s.peak - .24) / .76);
      emitRim(s,Math.min(30,Math.ceil(growth*500)));
    }
    setProgress(s.progress);
  }
  function triangle(c, texture, a, b, d) {
    const sx = b.ox - a.ox, sy = b.oy - a.oy, tx = d.ox - a.ox, ty = d.oy - a.oy;
    const det = sx * ty - sy * tx;
    const A = ((b.x - a.x) * ty - (d.x - a.x) * sy) / det;
    const B = ((b.y - a.y) * ty - (d.y - a.y) * sy) / det;
    const C = ((d.x - a.x) * sx - (b.x - a.x) * tx) / det;
    const D = ((d.y - a.y) * sx - (b.y - a.y) * tx) / det;
    const cx = (a.x + b.x + d.x) / 3, cy = (a.y + b.y + d.y) / 3;
    c.save(); c.beginPath();
    [a,b,d].forEach((p, i) => { const r = Math.hypot(p.x - cx, p.y - cy) || 1; const x = p.x + (p.x - cx) / r * .65, y = p.y + (p.y - cy) / r * .65; if (!i) c.moveTo(x,y); else c.lineTo(x,y); });
    c.closePath(); c.clip();
    c.transform(A, B, C, D, a.x - A * a.ox - C * a.oy, a.y - B * a.ox - D * a.oy);
    const x = Math.max(0, Math.min(a.ox,b.ox,d.ox) - 1), y = Math.max(0,Math.min(a.oy,b.oy,d.oy) - 1);
    const width = Math.min(W - x, W / COLS + 2), height = Math.min(H - y, H / ROWS + 2);
    c.drawImage(texture, x, y, width, height, x, y, width, height); c.restore();
  }
  function expandFracture(s, progress) {
    if (!progress) return;
    const maxReach = Math.max(
      Math.hypot(s.center.x,s.center.y), Math.hypot(W-s.center.x,s.center.y),
      Math.hypot(s.center.x,H-s.center.y), Math.hypot(W-s.center.x,H-s.center.y)
    );
    const points = s.mesh.points;
    for (const link of s.mesh.links) {
      if (link.broken) continue;
      const a=points[link.a], b=points[link.b];
      const mx=(a.ox+b.ox)/2, my=(a.oy+b.oy)/2;
      const wave=roughNoise(link.a*.13+link.b*.07,s.seed)*70;
      if (Math.hypot(mx-s.center.x,my-s.center.y) < progress*maxReach+wave) {
        link.broken=true; s.mesh.broken++;
        if (Math.random()<.09) emitPaper((a.x+b.x)/2,(a.y+b.y)/2,0,-1,2,.9);
      }
    }
  }
  function measureCoverage(canvas) {
    const pixels=canvas.getContext('2d').getImageData(0,0,W,H).data;
    let exposed=0;
    for(let i=3;i<pixels.length;i+=4)if(pixels[i]>18)exposed++;
    return exposed/(W*H);
  }
  function renderCracks(c,s,persist=false) {
    const points=s.mesh.points;
    const severity=transition ? clamp(transition.elapsed/.95) : clamp((s.peak-.24)/.76);
    const gap=.55 + Math.pow(severity,1.4)*19;
    c.save(); c.globalCompositeOperation=persist?'source-over':'destination-out'; c.strokeStyle='#fff'; c.fillStyle='#fff';
    c.lineJoin='round'; c.lineCap='round';
    for (const link of s.mesh.links) {
      if (!link.broken || (link.shear && (link.a*13+link.b*7)%5<2)) continue;
      const a=points[link.a], b=points[link.b], dx=b.x-a.x,dy=b.y-a.y;
      const length=Math.hypot(dx,dy)||1,nx=-dy/length,ny=dx/length;
      const seed=link.a*.37+link.b*.19+s.seed;
      c.beginPath(); c.moveTo(a.x,a.y);
      for(let step=1;step<6;step++){
        const t=step/6, jitter=roughNoise(step*.89,seed)*(2+severity*9);
        c.lineTo(a.x+dx*t+nx*jitter,a.y+dy*t+ny*jitter);
      }
      c.lineTo(b.x,b.y);
      c.lineWidth=gap*(.65+.35*(roughNoise(2.4,seed)+1)); c.stroke();
      if (!persist) {
        c.save();
        c.globalCompositeOperation='source-over';
        c.strokeStyle='rgba(241,255,255,.23)'; c.lineWidth=.7;
        c.translate(-nx*(gap*.4+1),-ny*(gap*.4+1)); c.stroke();
        c.restore();
      }
      if ((link.a*3+link.b*5)%7<2) {
        const t=.25+.5*((roughNoise(4.1,seed)+1)/2);
        const x=a.x+dx*t,y=a.y+dy*t,side=roughNoise(8.2,seed)>0?1:-1;
        c.beginPath(); c.moveTo(x,y);
        c.lineTo(x+nx*side*(10+severity*24)+dx*.12,y+ny*side*(10+severity*24)+dy*.12);
        c.lineWidth=Math.max(.6,gap*.26); c.stroke();
      }
    }
    c.restore();
  }
  function drawTension(c,s) {
    s.anchors.forEach((anchor,i)=>{
      const sign=i===0?-1:1;
      const dx=s.type==='mouse'?s.pull.x:sign*s.direction.x*W*.23*s.progress;
      const dy=s.type==='mouse'?s.pull.y:sign*s.direction.y*W*.23*s.progress;
      const tension=clamp(Math.hypot(dx,dy)/210)*(s.released?Math.exp(-s.releaseTime*6):1);
      if(tension<.01)return;
      c.save();c.translate(anchor.x+dx*.24,anchor.y+dy*.24);c.rotate(Math.atan2(dy,dx));
      // Paired broad shade / narrow highlights read as soft raised paper folds.
      const fade=c.createLinearGradient(-240,0,155,0);
      fade.addColorStop(0,'rgba(255,255,255,0)');fade.addColorStop(.65,`rgba(255,255,255,${tension*.48})`);fade.addColorStop(1,'rgba(255,255,255,0)');
      for(let fold=-3;fold<=3;fold++){
        if(!fold)continue;
        const spread=fold*39;
        c.beginPath();c.moveTo(-240,spread*1.6);
        c.bezierCurveTo(-100,spread*1.2,-25,spread*.25,150,spread*.4);
        c.lineWidth=9;c.strokeStyle=`rgba(12,44,60,${tension*.055})`;c.stroke();
        c.translate(0,-2);c.lineWidth=2.6;c.strokeStyle=fade;c.stroke();c.translate(0,2);
      }
      c.restore();
    });
  }
  function draw() {
    ctx.clearRect(0, 0, W, H);
    for (let depth = 2; depth >= 0; depth--) {
      const i = (currentPage + depth) % layers.length;
      const layer = layers[i], c = layer.surface.getContext('2d');
      c.clearRect(0, 0, W, H);
      if (interaction && interaction.layer === i) {
        const points = interaction.mesh.points;
        for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
          const n = y * (COLS + 1) + x;
          triangle(c, layer.texture, points[n], points[n + 1], points[n + COLS + 1]);
          triangle(c, layer.texture, points[n + 1], points[n + COLS + 2], points[n + COLS + 1]);
        }
        drawTension(c,interaction);
        if (!interaction.released) {
          const s = interaction, shade = c.createRadialGradient(s.center.x,s.center.y,10,s.center.x,s.center.y, W * .4);
          shade.addColorStop(0,`rgba(8,35,48,${s.progress*.23})`); shade.addColorStop(.52,`rgba(231,255,255,${s.progress*.12})`); shade.addColorStop(1,'rgba(231,255,255,0)');
          c.fillStyle = shade; c.fillRect(0,0,W,H);
        }
      } else c.drawImage(layer.texture, 0, 0);
      const active = interaction?.layer === i ? interaction : null;
      if (active?.mesh.broken) renderCracks(c,active);
      c.save(); c.globalCompositeOperation = 'destination-out'; c.drawImage(layer.mask, 0, 0);
      c.restore();
      ctx.save();
      if (depth < 2) { ctx.shadowColor = 'rgba(0,15,23,.7)'; ctx.shadowBlur = 14; ctx.shadowOffsetY = 5; }
      ctx.drawImage(layer.surface, 0, 0); ctx.restore();
    }
    dirty = false;
  }
  stage.width = W; stage.height = H;
  function pointer(event) { const r = stage.getBoundingClientRect(); return { x: (event.clientX - r.left) / r.width * W, y: (event.clientY - r.top) / r.height * H }; }
  let pointerId = null;
  stage.onpointerdown = event => {
    if (transition || pointerId !== null || (event.pointerType === 'mouse' && event.button !== 0)) return;
    tracker.reset(true); pointerId = event.pointerId; stage.setPointerCapture(pointerId); stage.classList.add('grabbing'); begin('mouse', [pointer(event)]);
  };
  stage.onpointermove = event => {
    if (event.pointerId !== pointerId || interaction?.type !== 'mouse' || interaction.released) return;
    const p = pointer(event), s = interaction;
    s.delta = { x: p.x - s.anchors[0].x, y: p.y - s.anchors[0].y };
    const distance = Math.hypot(s.delta.x, s.delta.y);
    s.target = clamp(distance / (W * .32));
    if (distance > 5) s.direction = { x: s.delta.x / distance, y: s.delta.y / distance };
  };
  const releasePointer = event => { if (event.pointerId === pointerId) { pointerId = null; stage.classList.remove('grabbing'); finish(); } };
  stage.onpointerup = releasePointer; stage.onpointercancel = releasePointer; stage.onlostpointercapture = releasePointer;

  function setProgress(progress) {
    $('gestureProgress').style.transform = `scaleX(${clamp(progress)})`;
    $('gestureProgress').setAttribute('aria-valuenow', Math.round(clamp(progress) * 100));
  }
  function drawPreview(results) {
    const c = previewCtx, width = preview.width, height = preview.height;
    c.save(); c.clearRect(0,0,width,height); c.translate(width,0); c.scale(-1,1); c.drawImage(results.image,0,0,width,height); c.restore();
    const hands = results.multiHandLandmarks || [];
    hands.forEach((points, i) => {
      if (points.length !== 21) return;
      const screen = points.map(p => ({ x: (1 - p.x) * width, y: p.y * height }));
      c.strokeStyle = i ? '#bddfff' : '#b6ffe8'; c.fillStyle = i ? '#d3eaff' : '#dafff3'; c.lineWidth = 2.4;
      c.beginPath(); bones.forEach(([a,b]) => { c.moveTo(screen[a].x,screen[a].y); c.lineTo(screen[b].x,screen[b].y); }); c.stroke();
      const x = Math.max(2,Math.min(...screen.map(p=>p.x))-16), y = Math.max(2,Math.min(...screen.map(p=>p.y))-16);
      const right = Math.min(width-2,Math.max(...screen.map(p=>p.x))+16), bottom = Math.min(height-2,Math.max(...screen.map(p=>p.y))+16);
      c.lineWidth = 1.2; c.strokeRect(x,y,right-x,bottom-y);
      for (const p of screen) { c.beginPath(); c.arc(p.x,p.y,4,0,Math.PI*2); c.fill(); }
    });
    $('cameraBox').classList.toggle('tracked', hands.length === 2);
  }
  function onResults(results, epoch) {
    if (!cameraOn || epoch !== cameraEpoch) return;
    lastResultAt = performance.now(); drawPreview(results); drawHands(results.multiHandLandmarks || []);
    if (pointerId !== null || transition) return;
    const event = tracker.update(results.multiHandLandmarks || [], video.videoWidth || 640, video.videoHeight || 480, lastResultAt);
    if (event.type === 'start') {
      const anchors = event.hands.map(hand => ({ x: clamp(hand.grip.x,.12,.88) * W, y: clamp(hand.grip.y / event.aspect,.15,.85) * H }));
      const dx = anchors[1].x - anchors[0].x, dy = anchors[1].y - anchors[0].y, length = Math.hypot(dx,dy) || 1;
      begin('gesture', anchors, { x: dx / length, y: dy / length });
    } else if (event.type === 'move' && interaction?.type === 'gesture' && !interaction.released) interaction.target = event.progress;
    else if (event.type === 'end' && interaction?.type === 'gesture') finish();
  }
  function drawHands(hands) {
    handCtx.clearRect(0,0,W,H);
    hands.slice(0,2).forEach((landmarks,index) => {
      if (landmarks.length !== 21) return;
      const points = landmarks.map(p => ({ x:(1-p.x)*W, y:p.y*H }));
      const color = index ? '#cbe5ff' : '#dafff6';
      handCtx.save(); handCtx.lineCap = 'round'; handCtx.lineJoin = 'round';
      handCtx.shadowColor = color; handCtx.shadowBlur = 10;
      handCtx.strokeStyle = color; handCtx.lineWidth = 2; handCtx.globalAlpha = .8;
      handCtx.beginPath();
      bones.forEach(([a,b]) => { handCtx.moveTo(points[a].x,points[a].y); handCtx.lineTo(points[b].x,points[b].y); });
      handCtx.stroke(); handCtx.globalAlpha = 1;
      for (const p of points) {
        handCtx.beginPath(); handCtx.arc(p.x,p.y,5,0,Math.PI*2);
        handCtx.fillStyle = 'rgba(14,49,62,.65)'; handCtx.fill(); handCtx.stroke();
        handCtx.beginPath(); handCtx.arc(p.x,p.y,1.8,0,Math.PI*2); handCtx.fillStyle = '#fff'; handCtx.fill();
      }
      handCtx.restore();
    });
  }
  function loadHands() {
    if (window.Hands) return Promise.resolve();
    if (scriptPromise) return scriptPromise;
    const sources = [
      { script:'vendor/mediapipe-hands/hands.js', base:new URL('vendor/mediapipe-hands/', location.href).href },
      { script:'https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js', base:'https://cdn.jsdelivr.net/npm/@mediapipe/hands/' }
    ];
    scriptPromise = new Promise((resolve,reject) => {
      let index = 0;
      const tryNext = () => {
        const source = sources[index++];
        if (!source) { reject(new Error('MediaPipe Hands 脚本无法加载')); return; }
        const script = document.createElement('script'); script.src = source.script;
        script.onload = () => {
          if (window.Hands) { window.__handsAssetBase = source.base; resolve(); }
          else tryNext();
        };
        script.onerror = () => { script.remove(); tryNext(); };
        document.head.appendChild(script);
      };
      tryNext();
    }).catch(error => { scriptPromise = null; throw error; });
    return scriptPromise;
  }
  async function stopCamera() {
    cameraOn = false; ++cameraEpoch;
    if (interaction?.type === 'gesture') finish();
    tracker.reset(); drawHands([]);
    if (stream) stream.getTracks().forEach(track => track.stop());
    stream = null; video.srcObject = null;
    $('cameraBox').hidden = true; $('cameraBox').classList.remove('tracked');
    $('cameraButton').classList.remove('active'); $('cameraButton').setAttribute('aria-pressed','false');
    const closing = model; model = null;
    try { if (pendingSend) await pendingSend; } catch (_) { /* The original inference error is reported by the pump. */ }
    if (closing) { try { await closing.close(); } catch (error) { console.warn('Hands cleanup',error); } }
  }
  async function startCamera() {
    if (location.protocol === 'file:') throw new Error('请通过 http://127.0.0.1:8765 打开页面');
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持摄像头，请使用 localhost 或 HTTPS');
    const epoch = ++cameraEpoch;
    await loadHands();
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode:'user', width:{ideal:640}, height:{ideal:480} }, audio:false });
    video.srcObject = stream; await video.play();
    preview.width = video.videoWidth || 640; preview.height = video.videoHeight || 480;
    $('cameraBox').style.aspectRatio = `${preview.width} / ${preview.height}`;
    const instance = new Hands({ locateFile: file => new URL(file, window.__handsAssetBase || new URL('vendor/mediapipe-hands/', location.href).href).href });
    model = instance;
    instance.setOptions({ maxNumHands:2, modelComplexity:0, minDetectionConfidence:.6, minTrackingConfidence:.6, selfieMode:false });
    instance.onResults(results => onResults(results,epoch));
    await instance.initialize();
    cameraOn = true; lastResultAt = performance.now(); tracker.reset();
    $('cameraBox').hidden = false; $('cameraButton').classList.add('active'); $('cameraButton').setAttribute('aria-pressed','true');
    let lastFrame = -1, lastSend = 0;
    const pump = async now => {
      if (!cameraOn || epoch !== cameraEpoch) return;
      if (video.readyState >= 2 && video.currentTime !== lastFrame && now-lastSend >= 40) {
        lastFrame = video.currentTime; lastSend = now;
        try { pendingSend = instance.send({ image:video }); await pendingSend; }
        catch (error) {
          if (epoch === cameraEpoch) { console.error('MediaPipe Hands inference',error); notice('手部识别中断，请重新开启摄像头。'); $('cameraButton').disabled = true; await stopCamera(); $('cameraButton').disabled = false; }
          return;
        } finally { pendingSend = null; }
      }
      if (cameraOn && epoch === cameraEpoch) requestAnimationFrame(pump);
    };
    requestAnimationFrame(pump);
  }
  $('cameraButton').onclick = async () => {
    if (location.protocol === 'file:') {
      location.replace('http://127.0.0.1:8765/');
      return;
    }
    $('cameraButton').disabled = true; $('toast').hidden = true;
    try { if (cameraOn) await stopCamera(); else await startCamera(); }
    catch (error) {
      console.error('MediaPipe Hands startup',error); await stopCamera();
      const messages = { NotAllowedError:'请允许浏览器使用摄像头，然后重试。', NotFoundError:'未找到可用摄像头。', NotReadableError:'摄像头被其他应用占用，请关闭后重试。' };
      notice(messages[error.name] || `手部识别：${error.message || '初始化失败'}`);
    } finally { $('cameraButton').disabled = false; }
  };
  window.addEventListener('pagehide', () => { cameraOn = false; cameraEpoch++; stream?.getTracks().forEach(track => track.stop()); });
  let previous = performance.now();
  function frame(now) {
    const dt = Math.min((now-previous)/1000,.05); previous = now;
    if (cameraOn && now-lastResultAt > 650) {
      drawHands([]);
      if (interaction?.type === 'gesture' && !interaction.released) { finish(); tracker.reset(true); }
    }
    if (transition && interaction) {
      physicsAccumulator += dt;
      while (physicsAccumulator >= FIXED_STEP) { physics(interaction,FIXED_STEP); physicsAccumulator -= FIXED_STEP; }
      transition.elapsed += dt;
      const t = clamp(transition.elapsed / .95), ease = t*t*(3-2*t);
      expandFracture(interaction,ease);
      emitRim(interaction,Math.ceil(dt*210));
      dirty = true;
      if (t >= 1) {
        currentPage = (currentPage + 1) % layers.length;
        // A completed turn removes the entire old page, including its shadow and mask.
        for (const layer of layers) { layer.mask.getContext('2d').clearRect(0,0,W,H); layer.edges = []; layer.coverage=0; }
        interaction = null; transition = null; tracker.reset(true); setProgress(0);
      }
    } else if (interaction) {
      physicsAccumulator += dt;
      while (physicsAccumulator >= FIXED_STEP) { physics(interaction,FIXED_STEP); physicsAccumulator -= FIXED_STEP; }
      dirty = true;
      if (!interaction.released && interaction.path && interaction.progress > .92) finish();
      if (!transition && interaction.released && interaction.releaseTime > .75 && interaction.progress < .001) { interaction = null; setProgress(0); }
    }
    if (dirty) draw();
    updateParticles(dt);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
