'use strict';
// 암호화한 데이터를 기기 안에서 푼다 (PBKDF2-SHA256 + AES-256-GCM, 압축은 gzip).
// 암호는 저장하지 않는다. 암호로 만든 열쇠만 꺼낼 수 없는 형태로 IndexedDB에 둔다.
(() => {
  const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  function store(mode, run) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('mnm-key', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('keys');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('keys', mode);
        const req = run(tx.objectStore('keys'));
        tx.oncomplete = () => { db.close(); resolve(req.result); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  }

  async function deriveKey(pass, box) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: bytes(box.salt), iterations: box.iterations },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
    );
  }

  async function open(key, box) {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(box.iv) }, key, bytes(box.data));
    const stream = new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).json();
  }

  function ask(box) {
    const gate = document.getElementById('gate');
    const input = document.getElementById('gate-pass');
    const message = document.getElementById('gate-msg');
    const button = gate.querySelector('button');
    gate.hidden = false;
    input.focus();
    return new Promise((resolve) => {
      gate.onsubmit = async (event) => {
        event.preventDefault();
        if (!input.value) return;
        button.disabled = true;
        message.textContent = '확인하는 중입니다…';
        try {
          const key = await deriveKey(input.value, box);
          const data = await open(key, box);
          try {
            await store('readwrite', (s) => s.put(key, box.salt));
          } catch (err) {
            // 저장하지 못하면 다음에 다시 묻는다
          }
          input.value = '';
          gate.hidden = true;
          resolve(data);
        } catch (err) {
          message.textContent = '암호가 맞지 않습니다.';
        } finally {
          button.disabled = false;
        }
      };
    });
  }

  self.unlockData = async (box) => {
    try {
      const saved = await store('readonly', (s) => s.get(box.salt));
      if (saved) return await open(saved, box);
    } catch (err) {
      // 저장한 열쇠가 없거나 맞지 않으면 암호를 묻는다
    }
    return ask(box);
  };
})();
