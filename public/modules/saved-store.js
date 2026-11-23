const DATABASE = "hnx-saved";
const SAVED = "saved";
const IMAGES = "images";

export function bookmarkMetadata(record) {
  const { html, ...metadata } = record;
  return metadata;
}

export function createSavedStore() {
  let database;
  function open() {
    database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore(SAVED, { keyPath: "id" });
        db.createObjectStore(IMAGES, { keyPath: "key" });
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          database = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Offline storage is busy."));
    }).catch((error) => {
      database = null;
      throw error;
    });
    return database;
  }

  async function transaction(stores, mode, run) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result;
      let failure;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure || tx.error || new Error("Offline storage transaction aborted."));
      tx.onerror = (event) => { failure = event.target.error; };

      function guard(callback) {
        return () => {
          try {
            callback();
          } catch (error) {
            failure = error;
            tx.abort();
          }
        };
      }

      guard(() => run(tx, (value) => { result = value; }, guard))();
    });
  }

  const imageRange = (id) => IDBKeyRange.bound([id, 0], [id, 7]);

  function list() {
    return transaction([SAVED], "readonly", (tx, result, guard) => {
      const items = [];
      const cursor = tx.objectStore(SAVED).openCursor();
      cursor.onsuccess = guard(() => {
        if (cursor.result) {
          items.push(bookmarkMetadata(cursor.result.value));
          cursor.result.continue();
        } else {
          result(items);
        }
      });
    });
  }

  function put(record) {
    return transaction([SAVED, IMAGES], "readwrite", (tx) => {
      tx.objectStore(IMAGES).delete(imageRange(record.id));
      tx.objectStore(SAVED).put(record);
    });
  }

  function finish(record, images = []) {
    return transaction([SAVED, IMAGES], "readwrite", (tx, result, guard) => {
      const saved = tx.objectStore(SAVED);
      const stored = saved.get(record.id);
      stored.onsuccess = guard(() => {
        if (stored.result?.saveToken !== record.saveToken) {
          result(false);
          return;
        }
        saved.put(record);
        const files = tx.objectStore(IMAGES);
        files.delete(imageRange(record.id));
        for (const image of images) files.put(image);
        result(true);
      });
    });
  }

  function read(id) {
    return transaction([SAVED, IMAGES], "readonly", (tx, result) => {
      const saved = tx.objectStore(SAVED).get(id);
      const images = tx.objectStore(IMAGES).getAll(imageRange(id));
      const data = {};
      result(data);
      saved.onsuccess = () => { data.record = saved.result; };
      images.onsuccess = () => { data.images = images.result; };
    });
  }

  function remove(id, saveToken) {
    return transaction([SAVED, IMAGES], "readwrite", (tx, _result, guard) => {
      const saved = tx.objectStore(SAVED);
      const stored = saved.get(id);
      stored.onsuccess = guard(() => {
        if (stored.result?.saveToken !== saveToken) return;
        saved.delete(id);
        tx.objectStore(IMAGES).delete(imageRange(id));
      });
    });
  }

  function clear() {
    return transaction([SAVED, IMAGES], "readwrite", (tx) => {
      tx.objectStore(SAVED).clear();
      tx.objectStore(IMAGES).clear();
    });
  }

  return { list, put, finish, read, remove, clear };
}
