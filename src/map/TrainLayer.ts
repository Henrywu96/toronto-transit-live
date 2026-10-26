import type { CustomLayerInterface, CustomRenderMethodInput, Map as MlMap } from 'maplibre-gl';
import {
  Camera,
  Color,
  DirectionalLight,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { LocalFrame, PathPoint } from '../lib/geo';
import type { Network } from '../lib/network';
import type { TrainState } from '../lib/schedule';
import { consistFor, makeFleet, makeMaterials, MODELS, PARTS, type Consist, type Fleet, type FleetMaterials, type ModelKey, type PartName, type SectionSpec } from './trainModels';

export interface TrainPose {
  state: TrainState;
  /** centre of the train in local metres (after the right-hand-running offset) */
  x: number;
  y: number;
  /** nose and tail, for placing labels clear of the model */
  fx: number;
  fy: number;
  rx: number;
  ry: number;
  /** drawn height in metres */
  h: number;
  ug: boolean;
}

/**
 * A MapLibre custom layer that draws the trains with three.js into the map's own WebGL context,
 * sharing its depth buffer. Positions are computed in double precision in local metres and the
 * projection is offset to the frame's origin, so the models stay steady at any zoom.
 */
export class TrainLayer implements CustomLayerInterface {
  readonly id = 'tt-trains';
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;

  /** filled every render: where each visible train is drawn (used for labels and picking) */
  readonly poses: TrainPose[] = [];
  selectedKey: string | null = null;
  night = false;
  /** smaller minimum on-screen size on phones */
  pixelScale = 1;

  private map: MlMap | null = null;
  private renderer: WebGLRenderer | null = null;
  private readonly scene = new Scene();
  private readonly camera = new Camera();
  private mats: FleetMaterials | null = null;
  private fleets: Partial<Record<ModelKey, Fleet>> = {};
  private readonly lineColor = new Color();
  private readonly roofColor = new Color();
  private readonly ghostColor = new Color();
  private readonly realRoof = new Color('#e4e7ea');
  private halo: Mesh | null = null;
  private readonly base = new Matrix4();
  private readonly tmp = new Matrix4();
  private readonly pm = new Matrix4();
  private readonly bm = new Matrix4();
  private readonly sv = new Vector3();
  private readonly pa: PathPoint = { x: 0, y: 0, tx: 0, ty: 0 };
  private readonly pb: PathPoint = { x: 0, y: 0, tx: 0, ty: 0 };

  constructor(
    private readonly net: Network,
    private readonly frame: LocalFrame,
    /** the trains to draw this frame */
    private readonly source: () => TrainState[],
    /** called after each render with the poses (for DOM labels) */
    private readonly afterRender: () => void,
  ) {}

  onAdd(map: MlMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.teardown(); // MapLibre does not call onRemove when the whole style is swapped
    this.map = map;
    this.renderer = new WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
    this.mats = makeMaterials();
    this.scene.clear();
    // world frame is x east, y north, z up: light from the north-west, above
    const hemi = new HemisphereLight('#ffffff', '#b9bec7', 2.3);
    hemi.position.set(0, 0, 1);
    const sun = new DirectionalLight('#ffffff', 1.1);
    sun.position.set(-0.5, 0.45, 0.75);
    this.scene.add(hemi, sun);
    for (const key of Object.keys(MODELS) as ModelKey[]) {
      const f = makeFleet(key, this.mats);
      this.fleets[key] = f;
      for (const name of PARTS) this.scene.add(f.parts[name]);
    }
    const ring = new RingGeometry(0.9, 1, 64);
    this.halo = new Mesh(ring, new MeshBasicMaterial({ color: '#ffb627', transparent: true, opacity: 0.9, depthWrite: false }));
    this.halo.matrixAutoUpdate = false;
    this.halo.frustumCulled = false;
    this.halo.renderOrder = 3;
    this.halo.visible = false;
    this.scene.add(this.halo);
  }

  onRemove() {
    this.teardown();
  }

  private teardown() {
    if (!this.renderer) return;
    this.scene.traverse((o) => {
      if (o instanceof InstancedMesh) o.dispose();
      if (o instanceof Mesh) o.geometry.dispose();
    });
    if (this.halo) (this.halo.material as MeshBasicMaterial).dispose();
    if (this.mats) {
      const { sides, shadows, ...rest } = this.mats;
      for (const m of [...Object.values(rest), ...sides, ...shadows]) {
        m.map?.dispose();
        if ('emissiveMap' in m) m.emissiveMap?.dispose();
        m.dispose();
      }
    }
    this.renderer?.dispose();
    this.renderer = null;
    this.map = null;
    this.fleets = {};
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput) {
    const map = this.map;
    const renderer = this.renderer;
    if (!map || !renderer || !this.mats) return;
    const fr = this.frame;
    // Mercator (0…1) → clip space, then local metres → Mercator
    this.base.fromArray(options.defaultProjectionData.mainMatrix as ArrayLike<number> as number[]);
    this.tmp.makeTranslation(fr.mx0, fr.my0, 0).scale(this.sv.set(fr.k, -fr.k, fr.k));
    this.camera.projectionMatrix.multiplyMatrices(this.base, this.tmp);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();

    this.buildInstances(map.getZoom(), performance.now());
    // at night the windows light up and the white paint dims a little
    const glow = this.night ? 0.95 : 0;
    this.mats.glass.emissiveIntensity = glow * 0.6;
    for (const m of this.mats.sides) {
      m.emissiveIntensity = glow;
      m.color.set(this.night ? '#cfd5dc' : '#ffffff');
    }
    this.mats.shell.color.set(this.night ? '#c6ccd3' : '#eef0ee');

    renderer.resetState();
    renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    renderer.render(this.scene, this.camera);
    this.afterRender();
  }

  /**
   * Size multipliers so trains stay legible when zoomed out: never narrower than ~11 px or shorter
   * than their consist's minimum on screen, true scale once you zoom in past street level.
   */
  scales(zoom: number, c: Consist) {
    const mpp = this.frame.metersPerPixel(zoom);
    // hundreds of trains: the further out, the smaller the tokens get, so the network does not drown in them
    const px = mpp * this.pixelScale * Math.min(1, Math.max(0.42, (zoom - 9.4) / 3.6));
    const sw = Math.max(1, (c.minW * px) / c.model.w);
    const sl = Math.max(1, Math.min(sw * 0.8, (c.minPx * px) / c.length));
    const sh = Math.max(1, Math.min(sw, (sl + sw) / 2));
    return { sw, sl, sh };
  }

  private buildInstances(zoom: number, now: number) {
    for (const f of Object.values(this.fleets)) for (const name of PARTS) f!.parts[name].count = 0;
    this.poses.length = 0;
    let haloSet = false;
    const states = this.source();
    for (const st of states) {
      const line = st.trip.pattern.line;
      const c = consistFor(line, st.trip.pattern.dir);
      const fleet = this.fleets[c.model.key]!;
      const m = c.model;
      const { sw, sl, sh } = this.scales(zoom, c);
      const shape = st.trip.pattern.shape;
      const path = shape.path;
      const total = c.length * sl;
      const side = (m.w * sw) / 2 + 0.6 * sw; // right-hand running: keep to the right of the track centre
      const front = st.dist + total / 2;
      // roofs keep their real colour close up and take on the line colour as the trains grow into tokens
      this.lineColor.set(line.color);
      const toy = Math.min(1, Math.max(0, (sw - 1.4) / 2.5));
      this.roofColor.copy(this.realRoof).lerp(this.lineColor, 0.85 * toy);
      // trains in tunnel: faint line colour close up, stronger when zoomed out so the line stays readable
      this.ghostColor.setRGB(1, 1, 1).lerp(this.lineColor, 0.4 + 0.4 * toy);
      let cx = 0;
      let cy = 0;
      let nx = 0;
      let ny = 0;
      let tx = 0;
      let ty = 0;
      let ugAll = true;
      c.sections.forEach((sec, b) => {
        const centre = front - sec.off * sl;
        const half = (sec.len / 2) * sl;
        path.at(centre + half - 0.5 * sl, this.pa);
        path.at(centre - half + 0.5 * sl, this.pb);
        const ax = this.pa.x + this.pa.ty * side;
        const ay = this.pa.y - this.pa.tx * side;
        const bx = this.pb.x + this.pb.ty * side;
        const by = this.pb.y - this.pb.tx * side;
        let fx = ax - bx;
        let fy = ay - by;
        const l = Math.hypot(fx, fy) || 1;
        fx /= l;
        fy /= l;
        const x = (ax + bx) / 2;
        const y = (ay + by) / 2;
        cx += x;
        cy += y;
        if (b === 0) {
          nx = ax;
          ny = ay;
        }
        tx = bx;
        ty = by;
        // section frame: X forward, Y up, Z right (= forward × up)
        const e = this.bm.elements;
        e[0] = fx * sl;
        e[1] = fy * sl;
        e[2] = 0;
        e[3] = 0;
        e[4] = 0;
        e[5] = 0;
        e[6] = sh;
        e[7] = 0;
        e[8] = fy * sw;
        e[9] = -fx * sw;
        e[10] = 0;
        e[11] = 0;
        e[12] = x;
        e[13] = y;
        e[14] = 0;
        e[15] = 1;
        const ug = this.net.isUnderground(shape, centre);
        if (!ug) ugAll = false;
        this.addSection(fleet, sec, ug);
      });
      const n = c.sections.length;
      cx /= n;
      cy /= n;
      this.poses.push({ state: st, x: cx, y: cy, fx: nx, fy: ny, rx: tx, ry: ty, h: (m.bottom + m.h + 0.5) * sh, ug: ugAll });
      if (st.v.key === this.selectedKey && this.halo) {
        const r = total / 2 + 5 * sw;
        const pulse = 1 + 0.06 * Math.sin(now / 260);
        this.halo.matrix.makeScale(r * pulse, r * pulse, 1).setPosition(cx, cy, 0.15 * sw);
        const hm = this.halo.material as MeshBasicMaterial;
        hm.opacity = ugAll ? 0.5 : 0.9;
        hm.color.set(this.night ? '#ffffff' : '#000000');
        haloSet = true;
      }
    }
    if (this.halo) this.halo.visible = haloSet;
    for (const f of Object.values(this.fleets)) {
      for (const name of PARTS) {
        const im = f!.parts[name];
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
      }
    }
  }

  private add(fleet: Fleet, name: PartName, local: string, tint?: Color) {
    const im = fleet.parts[name];
    if (im.count >= fleet.m.cap) return;
    this.pm.multiplyMatrices(this.bm, fleet.local[local]);
    const i = im.count++;
    im.setMatrixAt(i, this.pm);
    if (tint) im.setColorAt(i, tint);
  }

  private addSection(fleet: Fleet, sec: SectionSpec, ug: boolean) {
    const cab = sec.role === 'cabF' || sec.role === 'cabR';
    const front = sec.role === 'cabF';
    if (ug) {
      // in tunnel: only the see-through body, faintly tinted with the line colour
      if (cab) this.add(fleet, front ? 'ghostCab' : 'ghostCabR', sec.flip ? 'cabFlip' : 'cab', this.ghostColor);
      else this.add(fleet, sec.role === 'midA' ? 'ghostMidA' : 'ghostMidB', 'mid', this.ghostColor);
      return;
    }
    this.add(fleet, 'blob', 'blob');
    this.add(fleet, 'under', 'under');
    if (cab) {
      this.add(fleet, front ? 'cabBody' : 'cabBodyR', sec.flip ? 'cabFlip' : 'cab');
      this.add(fleet, 'roof', sec.flip ? 'roofR' : 'roofF', this.roofColor);
    } else {
      this.add(fleet, sec.role === 'midA' ? 'midA' : 'midB', 'mid');
      this.add(fleet, 'roof', 'roofMid', this.roofColor);
    }
    this.add(fleet, 'equip', 'equip');
    if (sec.panto) this.add(fleet, 'panto', 'panto');
  }
}
