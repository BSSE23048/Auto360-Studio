import type { OriginalPhoto, Project, ShowroomRepository } from './model';
import { cloudEnabled, cloudRepository } from './backend';

let database: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
  if (!database) database = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('This browser does not support local draft storage.')); return; }
    const request = indexedDB.open('auto360-studio-drafts', 1);
    request.onupgradeneeded = () => {
      const connection = request.result;
      connection.createObjectStore('projects', { keyPath: 'id' });
      connection.createObjectStore('photos', { keyPath: 'id' }).createIndex('projectId', 'projectId');
    };
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); database = undefined; }; resolve(request.result); };
    request.onerror = () => { database = undefined; reject(request.error); };
    request.onblocked = () => { database = undefined; reject(new Error('Close other Auto360 tabs, then reload to open local storage.')); };
  });
  return database;
}
async function read<T>(store: string, query: (source: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const tx = connection.transaction(store, 'readonly');
    const request = query(tx.objectStore(store));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function write(stores: string[], mutate: (tx: IDBTransaction) => void): Promise<void> {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const tx = connection.transaction(stores, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Local storage failed.'));
    tx.onabort = () => reject(tx.error ?? new Error('Local storage was interrupted.'));
    mutate(tx);
  });
}
const localRepository: ShowroomRepository = {
  listProjects: () => read<Project[]>('projects', store => store.getAll()),
  saveProject: project => write(['projects'], tx => { tx.objectStore('projects').put(project); }),
  getPhotos: projectId => read<OriginalPhoto[]>('photos', store => store.index('projectId').getAll(projectId)),
  savePhoto: photo => write(['photos'], tx => { tx.objectStore('photos').put(photo); }),
  deletePhoto: id => write(['photos'], tx => { tx.objectStore('photos').delete(id); }),
  deleteProject: id => write(['projects', 'photos'], tx => {
    tx.objectStore('projects').delete(id);
    const request = tx.objectStore('photos').index('projectId').openCursor(IDBKeyRange.only(id));
    request.onsuccess = () => { const cursor = request.result; if (cursor) { cursor.delete(); cursor.continue(); } };
  }),
};
export const repository = cloudEnabled ? cloudRepository : localRepository;
export function storageError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') return 'Browser storage is full. Keep your originals backed up and free space before trying again. This upload was not saved.';
  return error instanceof Error ? error.message : 'Unable to save locally. Your browser may be restricting storage.';
}
export async function canDisplay(file: File): Promise<boolean> {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<boolean>(resolve => {
      const img = new Image();
      const timer = window.setTimeout(() => resolve(false), 8000);
      img.onload = () => { window.clearTimeout(timer); resolve(true); };
      img.onerror = () => { window.clearTimeout(timer); resolve(false); };
      img.src = url;
    });
  } finally { URL.revokeObjectURL(url); }
}
