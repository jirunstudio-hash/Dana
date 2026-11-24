export const JSONSTORAGE_CONFIG = {
  baseUrl: "https://api.jsonstorage.net/v1/json",
  userId: "ISI_USER_ID",
  itemId: "ISI_ITEM_ID",
  apiKey: "" // isi jika item menggunakan apiKey
};

export function getJsonStorageUrl() {
  const { baseUrl, userId, itemId, apiKey } = JSONSTORAGE_CONFIG;
  if (!userId || !itemId) return "";
  const endpoint = `${baseUrl}/${encodeURIComponent(userId)}/${encodeURIComponent(itemId)}`;
  return apiKey ? `${endpoint}?apiKey=${encodeURIComponent(apiKey)}` : endpoint;
}

export async function readCloudStore(fallback = { devices: {}, invites: {}, sessions: {} }) {
  const url = getJsonStorageUrl();
  if (!url) return fallback;
  const res = await fetch(url, { method: "GET", cache: "no-store" });
  if (res.status === 404) return fallback;
  if (!res.ok) throw new Error(`GET gagal: ${res.status}`);
  const data = await res.json();
  return {
    devices: data?.devices && typeof data.devices === "object" ? data.devices : {},
    invites: data?.invites && typeof data.invites === "object" ? data.invites : {},
    sessions: data?.sessions && typeof data.sessions === "object" ? data.sessions : {}
  };
}

export async function writeCloudStore(payload) {
  const url = getJsonStorageUrl();
  if (!url) return false;
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`PUT gagal: ${res.status}`);
  return true;
}
