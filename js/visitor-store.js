const BASE_URL = "https://api.jsonstorage.net/v1/json";

export const VISITOR_STORE_CONFIG = {
  userId: "b81a9faf-e1ad-4b62-b156-35a1d75ff40e",
  itemId: "5f5c6b89-00a0-4052-a0a1-ef72717d10f8",
  apiKey: ""
};

export function getVisitorStoreUrl() {
  const { userId, itemId, apiKey } = VISITOR_STORE_CONFIG;
  if (!userId || !itemId) return "";
  const endpoint = `${BASE_URL}/${encodeURIComponent(userId)}/${encodeURIComponent(itemId)}`;
  return apiKey ? `${endpoint}?apiKey=${encodeURIComponent(apiKey)}` : endpoint;
}

export async function loadVisitors() {
  const url = getVisitorStoreUrl();
  if (!url) throw new Error("Konfigurasi userId/itemId kosong");

  const res = await fetch(url, { method: "GET", cache: "no-store" });
  if (res.status === 404) return {};
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`GET ${res.status}: ${bodyText || res.statusText}`);
  }

  const data = await res.json();
  return data && typeof data.visitors === "object" && data.visitors !== null ? data.visitors : {};
}

export async function saveVisitors(visitorsMap) {
  const url = getVisitorStoreUrl();
  if (!url) throw new Error("Konfigurasi userId/itemId kosong");

  const payload = {
    visitors: visitorsMap,
    updatedAt: Date.now()
  };

  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`PUT ${res.status}: ${bodyText || res.statusText}`);
  }
  return true;
}

export async function upsertVisitorRecord(visitorId, patch = {}) {
  const current = await loadVisitors();
  const prev = current[visitorId] || {
    visitorId,
    firstSeenAt: Date.now(),
    permissions: {}
  };

  current[visitorId] = {
    ...prev,
    ...patch,
    permissions: {
      ...(prev.permissions || {}),
      ...(patch.permissions || {})
    },
    lastSeenAt: Date.now()
  };

  await saveVisitors(current);
  return current[visitorId];
}

export async function deleteVisitorRecord(visitorId) {
  const current = await loadVisitors();
  if (current[visitorId]) {
    delete current[visitorId];
    await saveVisitors(current);
  }
  return current;
}
