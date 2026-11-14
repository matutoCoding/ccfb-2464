// IndexedDB 持久化: 病例元数据 + 网格二进制 (ArrayBuffer 原生支持)

import type { CaseRecord, Jaw, JawModel, MeshData } from './types';

const DB_NAME = 'dental-occlusion-studio';
const DB_VERSION = 1;
const STORE_CASES = 'cases';
const STORE_GEOM = 'geometry';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_CASES)) {
        const s = db.createObjectStore(STORE_CASES, { keyPath: 'id' });
        s.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains(STORE_GEOM)) {
        db.createObjectStore(STORE_GEOM);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function listCases(): Promise<CaseRecord[]> {
  const all = await tx<CaseRecord[]>(STORE_CASES, 'readonly', (s) => s.getAll() as IDBRequest<CaseRecord[]>);
  return (all || []).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function putCase(rec: CaseRecord): Promise<void> {
  await tx(STORE_CASES, 'readwrite', (s) => s.put(rec));
}

export async function deleteCase(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction([STORE_CASES, STORE_GEOM], 'readwrite');
    t.objectStore(STORE_CASES).delete(id);
    const g = t.objectStore(STORE_GEOM);
    g.delete(`${id}:upper`);
    g.delete(`${id}:lower`);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

interface StoredMesh {
  positions: ArrayBuffer;
  normals: ArrayBuffer;
  indices: ArrayBuffer;
  triangleCount: number;
  vertexCount: number;
  sourceName: string;
}

function meshToStored(mesh: MeshData): StoredMesh {
  return {
    positions: mesh.positions.buffer.slice(0) as ArrayBuffer,
    normals: mesh.normals.buffer.slice(0) as ArrayBuffer,
    indices: mesh.indices.buffer.slice(0) as ArrayBuffer,
    triangleCount: mesh.triangleCount,
    vertexCount: mesh.vertexCount,
    sourceName: mesh.sourceName,
  };
}

function storedToMesh(s: StoredMesh): MeshData {
  return {
    positions: new Float32Array(s.positions),
    normals: new Float32Array(s.normals),
    indices: new Uint32Array(s.indices),
    triangleCount: s.triangleCount,
    vertexCount: s.vertexCount,
    sourceName: s.sourceName,
  };
}

export async function saveJawMesh(caseId: string, jaw: Jaw, mesh: MeshData): Promise<void> {
  await tx(STORE_GEOM, 'readwrite', (s) => s.put(meshToStored(mesh), `${caseId}:${jaw}`));
}

export async function loadJawMesh(caseId: string, jaw: Jaw): Promise<MeshData | null> {
  const s = await tx<StoredMesh | undefined>(STORE_GEOM, 'readonly', (store) =>
    store.get(`${caseId}:${jaw}`) as IDBRequest<StoredMesh | undefined>,
  );
  return s ? storedToMesh(s) : null;
}

export async function estimateStorage(): Promise<{ cases: number; bytes: number }> {
  if (navigator.storage && navigator.storage.estimate) {
    const e = await navigator.storage.estimate();
    return { cases: (await listCases()).length, bytes: e.usage ?? 0 };
  }
  return { cases: (await listCases()).length, bytes: 0 };
}

/** 构造一个默认的颌模型状态 (居中变换) */
export function makeJawModel(mesh: MeshData): JawModel {
  return {
    mesh,
    transform: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    visible: true,
    opacity: 1,
  };
}
