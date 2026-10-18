export async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

export async function getJSONOrNull(url) {
  try {
    return await getJSON(url);
  } catch {
    return null;
  }
}

export const audioURL = (p) => "/audio/" + p.split("/").map(encodeURIComponent).join("/");
