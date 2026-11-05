// Backup export / import (JSON incl. images as data URLs)
import { getAll, putMany, kvGet, kvSet, clearAll, openDB } from './db.js';

const blobToDataURL = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});

async function dataURLToBlob(url) {
  return (await fetch(url)).blob();
}

export async function exportData() {
  const [folders, cards, imgs] = await Promise.all([getAll('folders'), getAll('cards'), getAll('images')]);
  const images = [];
  for (const im of imgs) images.push({ id: im.id, data: await blobToDataURL(im.blob) });
  const data = {
    app: 'shindanshi-anki',
    version: 1,
    exportedAt: new Date().toISOString(),
    folders,
    cards,
    images,
    settings: await kvGet('settings', null),
    history: await kvGet('history', {}),
  };
  return new Blob([JSON.stringify(data)], { type: 'application/json' });
}

export async function importData(file, replace) {
  const data = JSON.parse(await file.text());
  if (data.app !== 'shindanshi-anki' || !Array.isArray(data.cards)) throw new Error('このアプリのバックアップファイルではありません');
  const images = [];
  for (const im of data.images || []) images.push({ id: im.id, blob: await dataURLToBlob(im.data) });
  await openDB();
  if (replace) await clearAll();
  await putMany('folders', data.folders || []);
  await putMany('cards', data.cards);
  await putMany('images', images);
  if (replace || !(await kvGet('settings', null))) {
    if (data.settings) await kvSet('settings', data.settings);
  }
  const hist = await kvGet('history', {});
  for (const [d, v] of Object.entries(data.history || {})) {
    if (!hist[d] || (v.reviewed || 0) > (hist[d].reviewed || 0)) hist[d] = v;
  }
  await kvSet('history', hist);
  return { folders: (data.folders || []).length, cards: data.cards.length };
}
