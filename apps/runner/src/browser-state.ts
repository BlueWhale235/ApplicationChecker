import type { Browser, Page } from "puppeteer-core";
import type { BrowserCookie, BrowserStateEnvelope } from "@application-checker/contracts";

const indexedDbRecordLimit = 1_000;

function sameSite(value: string | undefined): BrowserCookie["sameSite"] {
  if (value === "Strict" || value === "Lax" || value === "None") return value;
  return undefined;
}

export async function installBrowserState(page: Page, state: BrowserStateEnvelope | null): Promise<void> {
  if (!state) return;
  if (state.cookies.length) {
    await page.setCookie(...state.cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      ...(cookie.expires ? { expires: cookie.expires } : {}),
      ...(cookie.httpOnly !== undefined ? { httpOnly: cookie.httpOnly } : {}),
      ...(cookie.secure !== undefined ? { secure: cookie.secure } : {}),
      ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
    })));
  }
  await page.evaluateOnNewDocument((origins) => {
    const entry = origins.find((item) => item.origin === location.origin);
    if (!entry) return;
    for (const [key, value] of Object.entries(entry.localStorage)) localStorage.setItem(key, value);
  }, state.origins);
}

export async function restoreIndexedDbState(page: Page, state: BrowserStateEnvelope | null): Promise<boolean> {
  if (!state) return false;
  return page.evaluate(async (origins) => {
    const entry = origins.find((item) => item.origin === location.origin);
    if (!entry?.indexedDB?.length) return false;

    type EncodedValue = {
      type: string;
      value?: unknown;
      name?: string;
      mimeType?: string;
      lastModified?: number;
    };
    const decode = (encoded: unknown): unknown => {
      const item = encoded as EncodedValue;
      switch (item.type) {
        case "null": return null;
        case "undefined": return undefined;
        case "string":
        case "boolean": return item.value;
        case "number":
          if (item.value === "NaN") return Number.NaN;
          if (item.value === "Infinity") return Number.POSITIVE_INFINITY;
          if (item.value === "-Infinity") return Number.NEGATIVE_INFINITY;
          return item.value;
        case "bigint": return BigInt(String(item.value));
        case "date": return new Date(String(item.value));
        case "regexp": {
          const value = item.value as { source: string; flags: string };
          return new RegExp(value.source, value.flags);
        }
        case "array": return (item.value as unknown[]).map(decode);
        case "object": return Object.fromEntries(
          (item.value as Array<[string, unknown]>).map(([key, value]) => [key, decode(value)]),
        );
        case "map": return new Map(
          (item.value as Array<[unknown, unknown]>).map(([key, value]) => [decode(key), decode(value)]),
        );
        case "set": return new Set((item.value as unknown[]).map(decode));
        case "arraybuffer": {
          const bytes = Uint8Array.from(atob(String(item.value)), (character) => character.charCodeAt(0));
          return bytes.buffer;
        }
        case "typedarray": {
          const bytes = Uint8Array.from(atob(String(item.value)), (character) => character.charCodeAt(0));
          const constructor = (globalThis as unknown as Record<string, new (buffer: ArrayBuffer) => ArrayBufferView>)[item.name!];
          return constructor ? new constructor(bytes.buffer) : bytes;
        }
        case "blob": {
          const bytes = Uint8Array.from(atob(String(item.value)), (character) => character.charCodeAt(0));
          return new Blob([bytes], item.mimeType === undefined ? {} : { type: item.mimeType });
        }
        case "file": {
          const bytes = Uint8Array.from(atob(String(item.value)), (character) => character.charCodeAt(0));
          return new File([bytes], item.name ?? "file", {
            ...(item.mimeType === undefined ? {} : { type: item.mimeType }),
            ...(item.lastModified === undefined ? {} : { lastModified: item.lastModified }),
          });
        }
        default: throw new Error(`Unsupported IndexedDB value type: ${item.type}`);
      }
    };
    const requestResult = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transactionDone = (transaction: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
    const openDatabase = (name: string, version?: number, upgrade?: (database: IDBDatabase) => void): Promise<IDBDatabase> =>
      new Promise((resolve, reject) => {
        const request = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
        request.onupgradeneeded = () => upgrade?.(request.result);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error(`IndexedDB ${name} is blocked`));
      });

    let restored = false;
    for (const snapshot of entry.indexedDB) {
      try {
        let database = await openDatabase(snapshot.name);
        const missingStores = snapshot.stores.filter((store) => !database.objectStoreNames.contains(store.name));
        if (missingStores.length) {
          const nextVersion = Math.max(database.version + 1, snapshot.version);
          database.close();
          database = await openDatabase(snapshot.name, nextVersion, (upgrading) => {
            for (const storeSnapshot of missingStores) {
              const store = upgrading.createObjectStore(storeSnapshot.name, {
                keyPath: storeSnapshot.keyPath,
                autoIncrement: storeSnapshot.autoIncrement,
              });
              for (const index of storeSnapshot.indexes) {
                store.createIndex(index.name, index.keyPath, {
                  unique: index.unique,
                  multiEntry: index.multiEntry,
                });
              }
            }
          });
        }
        for (const storeSnapshot of snapshot.stores) {
          if (!database.objectStoreNames.contains(storeSnapshot.name)) continue;
          const transaction = database.transaction(storeSnapshot.name, "readwrite");
          const store = transaction.objectStore(storeSnapshot.name);
          if (!storeSnapshot.truncated) store.clear();
          for (const record of storeSnapshot.records) {
            const value = decode(record.value);
            if (store.keyPath === null) store.put(value, decode(record.key) as IDBValidKey);
            else store.put(value);
          }
          await transactionDone(transaction);
          restored = true;
        }
        database.close();
      } catch (error) {
        console.warn(`Unable to restore IndexedDB ${snapshot.name}`, error);
      }
    }
    return restored;
  }, state.origins);
}

export async function collectBrowserState(browser: Browser, page: Page, site: string): Promise<BrowserStateEnvelope> {
  const rawCookies = await browser.cookies();
  const cookies: BrowserCookie[] = rawCookies.filter((cookie) => {
    const domain = cookie.domain.replace(/^\./, "").toLowerCase();
    return domain === site || domain.endsWith(`.${site}`);
  }).map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    ...(cookie.expires > 0 ? { expires: cookie.expires } : {}),
    ...(cookie.httpOnly !== undefined ? { httpOnly: cookie.httpOnly } : {}),
    ...(cookie.secure !== undefined ? { secure: cookie.secure } : {}),
    ...(sameSite(cookie.sameSite) ? { sameSite: sameSite(cookie.sameSite)! } : {}),
  }));
  const origins = await page.evaluate(async (recordLimit) => {
    try {
      const values: Record<string, string> = {};
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key !== null) values[key] = localStorage.getItem(key) ?? "";
      }
      type EncodedValue = {
        type: string;
        value?: unknown;
        name?: string;
        mimeType?: string;
        lastModified?: number;
      };
      const bytesToBase64 = (bytes: Uint8Array): string => {
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        return btoa(binary);
      };
      const encode = async (value: unknown, ancestors = new Set<object>()): Promise<EncodedValue> => {
        if (value === null) return { type: "null" };
        if (value === undefined) return { type: "undefined" };
        if (typeof value === "string" || typeof value === "boolean") return { type: typeof value, value };
        if (typeof value === "number") {
          const encoded = Number.isNaN(value) ? "NaN"
            : value === Number.POSITIVE_INFINITY ? "Infinity"
              : value === Number.NEGATIVE_INFINITY ? "-Infinity"
                : value;
          return { type: "number", value: encoded };
        }
        if (typeof value === "bigint") return { type: "bigint", value: value.toString() };
        if (typeof value !== "object") throw new Error(`Unsupported IndexedDB value: ${typeof value}`);
        if (ancestors.has(value)) throw new Error("Cyclic IndexedDB values are not supported");
        ancestors.add(value);
        try {
          if (value instanceof Date) return { type: "date", value: value.toISOString() };
          if (value instanceof RegExp) return { type: "regexp", value: { source: value.source, flags: value.flags } };
          if (value instanceof File) {
            return {
              type: "file",
              value: bytesToBase64(new Uint8Array(await value.arrayBuffer())),
              name: value.name,
              mimeType: value.type,
              lastModified: value.lastModified,
            };
          }
          if (value instanceof Blob) {
            return {
              type: "blob",
              value: bytesToBase64(new Uint8Array(await value.arrayBuffer())),
              mimeType: value.type,
            };
          }
          if (value instanceof ArrayBuffer) {
            return { type: "arraybuffer", value: bytesToBase64(new Uint8Array(value)) };
          }
          if (ArrayBuffer.isView(value)) {
            return {
              type: "typedarray",
              name: value.constructor.name,
              value: bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
            };
          }
          if (Array.isArray(value)) {
            return { type: "array", value: await Promise.all(value.map((item) => encode(item, ancestors))) };
          }
          if (value instanceof Map) {
            return {
              type: "map",
              value: await Promise.all([...value].map(async ([key, item]) => [
                await encode(key, ancestors),
                await encode(item, ancestors),
              ])),
            };
          }
          if (value instanceof Set) {
            return { type: "set", value: await Promise.all([...value].map((item) => encode(item, ancestors))) };
          }
          return {
            type: "object",
            value: await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await encode(item, ancestors)])),
          };
        } finally {
          ancestors.delete(value);
        }
      };
      const requestResult = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const openDatabase = (name: string): Promise<IDBDatabase> => new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error(`IndexedDB ${name} is blocked`));
      });
      const databases = typeof indexedDB.databases === "function" ? await indexedDB.databases() : [];
      const snapshots = [];
      for (const info of databases) {
        if (!info.name) continue;
        try {
          const database = await openDatabase(info.name);
          const stores = [];
          for (const storeName of database.objectStoreNames) {
            const transaction = database.transaction(storeName, "readonly");
            const store = transaction.objectStore(storeName);
            const [keys, records, count] = await Promise.all([
              requestResult(store.getAllKeys(undefined, recordLimit)),
              requestResult(store.getAll(undefined, recordLimit)),
              requestResult(store.count()),
            ]);
            const encodedRecords = [];
            for (let index = 0; index < records.length; index += 1) {
              try {
                encodedRecords.push({
                  key: await encode(keys[index]),
                  value: await encode(records[index]),
                });
              } catch (error) {
                console.warn(`Unable to save an IndexedDB record from ${info.name}/${storeName}`, error);
              }
            }
            stores.push({
              name: store.name,
              keyPath: store.keyPath,
              autoIncrement: store.autoIncrement,
              indexes: [...store.indexNames].map((indexName) => {
                const index = store.index(indexName);
                return {
                  name: index.name,
                  keyPath: index.keyPath,
                  unique: index.unique,
                  multiEntry: index.multiEntry,
                };
              }),
              records: encodedRecords,
              truncated: count > recordLimit,
            });
          }
          snapshots.push({ name: database.name, version: database.version, stores });
          database.close();
        } catch (error) {
          console.warn(`Unable to save IndexedDB ${info.name}`, error);
        }
      }
      return [{ origin: location.origin, localStorage: values, indexedDB: snapshots }];
    } catch (error) {
      console.warn("Unable to save browser origin storage", error);
      return [];
    }
  }, indexedDbRecordLimit);
  return { version: 1, cookies, origins };
}
