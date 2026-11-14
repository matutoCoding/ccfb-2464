// 全局应用状态: 单例 store + 发布订阅, 不依赖框架
import type {
  CaseRecord,
  ClipPlaneState,
  ContactPoint,
  DistanceField,
  Jaw,
  JawModel,
  LegendConfig,
  ViewerSettings,
} from './types';
import {
  deleteCase,
  listCases,
  loadJawMesh,
  makeJawModel,
  putCase,
  saveJawMesh,
} from './storage';
import { m4 } from './math';

export interface AppState {
  cases: CaseRecord[];
  activeCaseId: string | null;
  models: Map<Jaw, JawModel>;
  /** 当前距离场 (下颌采样) */
  distanceField: DistanceField | null;
  sampleIndices: Uint32Array | null;
  contacts: ContactPoint[];
  legend: LegendConfig;
  settings: ViewerSettings;
  clip: ClipPlaneState;
  heatVisible: boolean;
  busy: boolean;
  busyText: string;
}

type Listener = (state: AppState) => void;

const defaultClip: ClipPlaneState = {
  enabled: false,
  point: [0, 0, 0],
  normal: [0, 0, 1],
  fillCap: true,
  measures: [],
};

class Store {
  state: AppState = {
    cases: [],
    activeCaseId: null,
    models: new Map(),
    distanceField: null,
    sampleIndices: null,
    contacts: [],
    legend: { maxRange: 2, bands: 8, contactThreshold: 0.05 },
    settings: {
      ssaoEnabled: true,
      ssaoRadius: 3.2,
      ssaoStrength: 2.2,
      edgeEnabled: true,
      edgeStrength: 1.6,
      lightAzimuth: 35,
      lightElevation: 45,
    },
    clip: structuredClone(defaultClip),
    heatVisible: false,
    busy: false,
    busyText: '',
  };

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.listeners.forEach((fn) => fn(this.state));
  }

  /** 局部更新后触发通知 */
  update(mutator: (s: AppState) => void): void {
    mutator(this.state);
    this.emit();
  }

  setBusy(busy: boolean, text = ''): void {
    this.update((s) => { s.busy = busy; s.busyText = text; });
  }

  async refreshCases(): Promise<void> {
    const cases = await listCases();
    this.update((s) => { s.cases = cases; });
  }

  async createCase(name: string): Promise<string> {
    const now = Date.now();
    const rec: CaseRecord = {
      id: `case_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      createdAt: now,
      updatedAt: now,
    };
    await putCase(rec);
    await this.refreshCases();
    return rec.id;
  }

  async removeCase(id: string): Promise<void> {
    await deleteCase(id);
    if (this.state.activeCaseId === id) {
      this.update((s) => {
        s.activeCaseId = null;
        s.models.clear();
        s.distanceField = null;
        s.sampleIndices = null;
        s.contacts = [];
        s.heatVisible = false;
        s.clip = structuredClone(defaultClip);
      });
    }
    await this.refreshCases();
  }

  async openCase(id: string): Promise<void> {
    const [upperMesh, lowerMesh] = await Promise.all([
      loadJawMesh(id, 'upper'),
      loadJawMesh(id, 'lower'),
    ]);
    this.update((s) => {
      s.activeCaseId = id;
      s.models.clear();
      if (upperMesh) s.models.set('upper', makeJawModel(upperMesh));
      if (lowerMesh) s.models.set('lower', makeJawModel(lowerMesh));
      s.distanceField = null;
      s.sampleIndices = null;
      s.contacts = [];
      s.heatVisible = false;
      s.clip = structuredClone(defaultClip);
    });
  }

  closeCase(): void {
    this.update((s) => {
      s.activeCaseId = null;
      s.models.clear();
      s.distanceField = null;
      s.sampleIndices = null;
      s.contacts = [];
      s.heatVisible = false;
      s.clip = structuredClone(defaultClip);
    });
  }

  async setJawMesh(jaw: Jaw, mesh: JawModel['mesh']): Promise<void> {
    if (!this.state.activeCaseId) throw new Error('没有打开的病例');
    await saveJawMesh(this.state.activeCaseId, jaw, mesh);
    const rec = this.state.cases.find((c) => c.id === this.state.activeCaseId);
    if (rec) {
      rec.updatedAt = Date.now();
      if (jaw === 'upper') {
        rec.upperFileName = mesh.sourceName;
        rec.upperVertexCount = mesh.vertexCount;
        rec.upperTriangleCount = mesh.triangleCount;
      } else {
        rec.lowerFileName = mesh.sourceName;
        rec.lowerVertexCount = mesh.vertexCount;
        rec.lowerTriangleCount = mesh.triangleCount;
      }
      await putCase(rec);
    }
    this.update((s) => {
      const existing = s.models.get(jaw);
      s.models.set(jaw, {
        mesh,
        transform: existing?.transform ?? m4.identity(),
        visible: existing?.visible ?? true,
        opacity: existing?.opacity ?? 1,
      });
      s.distanceField = null;
      s.sampleIndices = null;
      s.contacts = [];
      s.heatVisible = false;
    });
    await this.refreshCases();
  }

  updateJaw(jaw: Jaw, patch: Partial<JawModel>): void {
    this.update((s) => {
      const m = s.models.get(jaw);
      if (m) Object.assign(m, patch);
    });
  }

  setTransform(jaw: Jaw, transform: Float32Array): void {
    this.update((s) => {
      const m = s.models.get(jaw);
      if (m) m.transform = transform;
    });
  }

  setDistanceResult(field: DistanceField, sampleIndices: Uint32Array): void {
    this.update((s) => {
      s.distanceField = field;
      s.sampleIndices = sampleIndices;
      s.heatVisible = true;
    });
  }

  setContacts(contacts: ContactPoint[]): void {
    this.update((s) => { s.contacts = contacts; });
  }

  clearHeat(): void {
    this.update((s) => {
      s.distanceField = null;
      s.sampleIndices = null;
      s.contacts = [];
      s.heatVisible = false;
    });
  }

  updateLegend(patch: Partial<LegendConfig>): void {
    this.update((s) => Object.assign(s.legend, patch));
  }

  updateSettings(patch: Partial<ViewerSettings>): void {
    this.update((s) => Object.assign(s.settings, patch));
  }

  updateClip(patch: Partial<ClipPlaneState>): void {
    this.update((s) => Object.assign(s.clip, patch));
  }

  resetClip(): void {
    this.update((s) => { s.clip = structuredClone(defaultClip); });
  }
}

export const store = new Store();
if (import.meta.env.DEV) {
  (window as unknown as { __store?: Store }).__store = store;
}
